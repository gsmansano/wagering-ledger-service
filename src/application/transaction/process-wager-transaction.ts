import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference';
import type { IntegrationEvent } from '../../domain/events/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { InvalidInputError } from '../../domain/shared/invalid-input-error';
import { Money, type MoneyProps } from '../../domain/shared/money';
import { payloadHash } from '../../domain/shared/payload-hash';
import { WagerTransaction, WagerTransactionKind } from '../../domain/transaction/wager-transaction';
import type { PersistedWagerTransaction } from '../ports/wager-transaction.repository';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work';
import { WalletNotFoundError } from '../wallet/wallet-not-found.error';
import { ApplyOutcome, applyUnderLock } from './apply-transaction';
import { IdempotencyConflictError } from './idempotency-conflict.error';
import {
  DEFAULT_REFERENCE_RETRY_POLICY,
  referenceRetryAt,
  type ReferenceRetryPolicy,
} from './reference-retry-policy';
import { UnresolvedConflictError } from './unresolved-conflict.error';

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
}

export interface ProcessWagerTransactionResult {
  transaction: WagerTransaction;
  /** Wallet balance observed when the transaction was settled; on a replay, the original one. */
  balanceAfter: Money | undefined;
  /** True when this call returned the stored result of an earlier delivery. */
  idempotentReplay: boolean;
}

export interface ProcessWagerTransactionDeps {
  unitOfWork: UnitOfWork;
  now: () => Date;
  newId: () => string;
  referenceRetry?: ReferenceRetryPolicy;
}

export class ProcessWagerTransaction {
  constructor(private readonly deps: ProcessWagerTransactionDeps) {}

  /**
   * Applies a BET, WIN or LOSS in one SQL transaction (decisions #25 and #26): record the transaction
   * (idempotency), lock the wallet, apply, write the ledger entry, settle, queue the events.
   * Business rejections (insufficient funds, currency mismatch) are persisted and returned, not thrown.
   * REFUND and ROLLBACK are checked against their reference under the wallet lock (decisions #36 to #38) and
   * rejected with a stable failure code when the reference is unusable or the reversal would overdraw. A reversal
   * whose reference has not arrived or is still in flight is stored as PENDING_REFERENCE, with `balanceAfter`
   * undefined, and retried later by `ResolvePendingReference`.
   * Throws, persisting nothing: InvalidInputError for an invalid payload (including OPENING and a wrong player),
   * WalletNotFoundError and IdempotencyConflictError.
   */
  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const { unitOfWork, now, newId } = this.deps;
    const retryPolicy = this.deps.referenceRetry ?? DEFAULT_REFERENCE_RETRY_POLICY;
    this.assertSupportedKind(command.kind);

    const money = Money.from(command.money);
    const hash = payloadHash({ ...command, money: money.toJSON() });
    const transaction = WagerTransaction.create({
      id: newId(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: hash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now(),
    });
    const correlationId = command.correlationId ?? newId();

    return unitOfWork.run(async (repos) => {
      // Fast path for a clean WalletNotFoundError only; correctness does not depend on it. The foreign key on
      // wager_transactions.wallet_id is the real guard: without this read a missing wallet would surface as a
      // constraint violation on the insert below. A wallet that vanished in between would do the same, a rare
      // generic error rather than a wrong balance. Ownership and currency are checked on the locked row.
      if ((await repos.wallets.findById(command.walletId)) === undefined) {
        throw new WalletNotFoundError(command.walletId);
      }

      if (!(await repos.transactions.insertIfAbsent(transaction))) {
        return this.replay(repos, command, hash);
      }

      // The first statement that touches the balance: from here to commit, other transactions on this wallet wait.
      const wallet = (await repos.wallets.findByIdForUpdate(command.walletId))!; // exists unless deleted since the read above
      if (wallet.playerId !== command.playerId) {
        throw new InvalidInputError(`Wallet ${wallet.id} does not belong to player ${command.playerId}`);
      }
      const at = now();
      const events: IntegrationEvent<unknown>[] = [];
      const outcome = await applyUnderLock(repos, transaction, wallet, { at, newId, correlationId }, events);

      let balanceAfter: Money | undefined;
      if (outcome === ApplyOutcome.Waiting) {
        // The reference has not arrived or is still in flight: park the reversal; the worker retries it (#39, #40).
        transaction.markPendingReference();
        await repos.transactions.update(transaction);
        await repos.transactions.scheduleReferenceRetry(transaction.id, 0, referenceRetryAt(retryPolicy, 1, at));
        events.push(
          WagerTransactionPendingReference.from(transaction, {
            eventId: newId(),
            correlationId,
            causationId: transaction.id,
            occurredAt: at,
          }),
        );
      } else {
        balanceAfter = wallet.balance;
        await repos.transactions.update(transaction, balanceAfter);
      }
      for (const event of events) await repos.outbox.insert(OutboxMessage.enqueue(event));
      return { transaction, balanceAfter, idempotentReplay: false };
    });
  }

  private assertSupportedKind(kind: WagerTransactionKind): void {
    if (kind === WagerTransactionKind.Opening) {
      throw new InvalidInputError('OPENING is internal and cannot be submitted');
    }
  }

  /**
   * Another delivery owns the key or the provider transaction id. `insertIfAbsent` returned only after the
   * owner committed (or rolled back, in which case we would have inserted), so its settled row is visible.
   * The same business payload is a replay of the original result; a different one is a conflict.
   */
  private async replay(
    repos: Repositories,
    command: ProcessWagerTransactionCommand,
    hash: string,
  ): Promise<ProcessWagerTransactionResult> {
    const existing: PersistedWagerTransaction | undefined =
      (await repos.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey)) ??
      (await repos.transactions.findByProviderAndExternalId(command.providerId, command.externalTransactionId));
    if (existing === undefined) {
      throw new UnresolvedConflictError(command.providerId, command.idempotencyKey);
    }
    if (!existing.transaction.matchesPayload(hash)) {
      throw new IdempotencyConflictError(command.idempotencyKey, existing.transaction.id);
    }
    return { transaction: existing.transaction, balanceAfter: existing.balanceAfter, idempotentReplay: true };
  }
}
