import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference';
import type { IntegrationEvent } from '../../domain/events/integration-event';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { InvalidInputError } from '../../domain/shared/invalid-input-error';
import { Money, type MoneyProps } from '../../domain/shared/money';
import { payloadHash } from '../../domain/shared/payload-hash';
import { WagerTransaction, WagerTransactionKind } from '../../domain/transaction/wager-transaction';
import { type Metrics, NO_METRICS, type ProcessingResult } from '../ports/metrics';
import type { PersistedWagerTransaction } from '../ports/wager-transaction.repository';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work';
import { WalletNotFoundError } from '../wallet/wallet-not-found.error';
import { ApplyOutcome, applyUnderLock } from './apply-transaction';
import { lockWallet } from './lock-wallet';
import { IdempotencyConflictError } from './idempotency-conflict.error';
import { InboxPayloadConflictError } from './inbox-payload-conflict.error';
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

/** Identifies the queue message a command came from, so the inbox row is written in the same SQL transaction. */
export interface InboxContext {
  consumerName: string;
  messageId: string;
}

/** The consumer already processed this message: nothing was written and the message can be acknowledged. */
export interface DuplicateMessage {
  duplicateMessage: true;
}

export interface ProcessWagerTransactionDeps {
  unitOfWork: UnitOfWork;
  now: () => Date;
  newId: () => string;
  referenceRetry?: ReferenceRetryPolicy;
  metrics?: Metrics;
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
   * With `inbox` (a queue message), the first statement records the message as processed in the same transaction
   * (decision #51): an already recorded message id returns `DuplicateMessage` and writes nothing, and the same id
   * with a different payload throws InboxPayloadConflictError.
   */
  execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult>;
  execute(
    command: ProcessWagerTransactionCommand,
    inbox: InboxContext,
  ): Promise<ProcessWagerTransactionResult | DuplicateMessage>;
  async execute(
    command: ProcessWagerTransactionCommand,
    inbox?: InboxContext,
  ): Promise<ProcessWagerTransactionResult | DuplicateMessage> {
    const metrics = this.deps.metrics ?? NO_METRICS;
    const started = performance.now();
    let result: ProcessingResult = 'error';
    try {
      const outcome = await this.process(command, inbox);
      // The transaction has committed: only now is it something that happened.
      if ('duplicateMessage' in outcome) {
        result = 'duplicate_message';
        metrics.duplicateDetected('inbox');
      } else if (outcome.idempotentReplay) {
        result = 'replay';
        metrics.duplicateDetected('idempotency_key');
      } else {
        result = 'settled';
        metrics.transactionStatus(outcome.transaction.kind, outcome.transaction.status);
      }
      return outcome;
    } finally {
      metrics.processingTime(result, (performance.now() - started) / 1000);
    }
  }

  private async process(
    command: ProcessWagerTransactionCommand,
    inbox: InboxContext | undefined,
  ): Promise<ProcessWagerTransactionResult | DuplicateMessage> {
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
      if (inbox !== undefined) {
        const at = now();
        // Written already processed: the row exists only if the business change below commits with it.
        const received = InboxMessage.receive({ ...inbox, payloadHash: hash, receivedAt: at });
        received.markProcessed(at);
        if (!(await repos.inbox.insertIfAbsent(received))) {
          const earlier = await repos.inbox.find(inbox.consumerName, inbox.messageId);
          if (earlier !== undefined && earlier.payloadHash !== hash) {
            throw new InboxPayloadConflictError(inbox.consumerName, inbox.messageId);
          }
          return { duplicateMessage: true };
        }
      }

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
      const wallet = (await lockWallet(repos, command.walletId, this.deps.metrics))!; // exists unless deleted since the read above
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
