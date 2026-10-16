import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import type { EventContext, IntegrationEvent } from '../../domain/events/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { DomainError } from '../../domain/shared/domain-error';
import { Money, type MoneyProps } from '../../domain/shared/money';
import { payloadHash } from '../../domain/shared/payload-hash';
import { FailureCode } from '../../domain/transaction/failure-code';
import { WagerTransaction, WagerTransactionKind } from '../../domain/transaction/wager-transaction';
import { InsufficientFundsError } from '../../domain/wallet/insufficient-funds-error';
import { LedgerDirection } from '../../domain/wallet/wallet-ledger-entry';
import type { PersistedWagerTransaction } from '../ports/wager-transaction.repository';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work';
import { WalletNotFoundError } from '../wallet/wallet-not-found.error';
import { IdempotencyConflictError } from './idempotency-conflict.error';
import { UnsupportedKindError } from './unsupported-kind.error';

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
}

export class ProcessWagerTransaction {
  constructor(private readonly deps: ProcessWagerTransactionDeps) {}

  /**
   * Applies a BET, WIN or LOSS in one SQL transaction (decisions #25 and #26): record the transaction
   * (idempotency), lock the wallet, apply, write the ledger entry, settle, queue the events.
   * Business rejections (insufficient funds, currency mismatch) are persisted and returned, not thrown.
   * Throws, persisting nothing: DomainError for an invalid payload (including OPENING and a wrong player),
   * WalletNotFoundError, UnsupportedKindError (REFUND and ROLLBACK, M5) and IdempotencyConflictError.
   */
  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const { unitOfWork, now, newId } = this.deps;
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
        throw new DomainError(`Wallet ${wallet.id} does not belong to player ${command.playerId}`);
      }
      const at = now();
      const events: IntegrationEvent<unknown>[] = [];
      const context = (): EventContext => ({
        eventId: newId(),
        correlationId,
        causationId: transaction.id,
        occurredAt: at,
      });

      const reject = (code: FailureCode) => {
        transaction.reject(code, at);
        events.push(WagerTransactionRejected.from(transaction, context()));
      };

      if (money.currency !== wallet.currency) {
        reject(FailureCode.CurrencyMismatch);
      } else if (!transaction.affectsBalance()) {
        transaction.markProcessed(undefined, at);
        events.push(WagerTransactionProcessed.from(transaction, context()));
      } else {
        const movement = { entryId: newId(), transactionId: transaction.id, money, now: at };
        try {
          const entry =
            transaction.ledgerDirectionFor() === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
          await repos.ledger.append(entry);
          await repos.wallets.update(wallet);
          transaction.markProcessed(undefined, at);
          events.push(WagerTransactionProcessed.from(transaction, context()));
          events.push(WalletBalanceChanged.from(wallet, entry, context()));
        } catch (error) {
          if (!(error instanceof InsufficientFundsError)) throw error;
          reject(FailureCode.InsufficientFunds);
        }
      }

      await repos.transactions.update(transaction, wallet.balance);
      for (const event of events) await repos.outbox.insert(OutboxMessage.enqueue(event));
      return { transaction, balanceAfter: wallet.balance, idempotentReplay: false };
    });
  }

  private assertSupportedKind(kind: WagerTransactionKind): void {
    if (kind === WagerTransactionKind.Opening) {
      throw new DomainError('OPENING is internal and cannot be submitted');
    }
    if (kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) {
      throw new UnsupportedKindError(kind);
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
      (await repos.transactions.findByIdempotencyKey(command.idempotencyKey)) ??
      (await repos.transactions.findByProviderAndExternalId(command.providerId, command.externalTransactionId));
    if (existing === undefined) {
      throw new Error(`Insert conflicted but no stored transaction was found for key ${command.idempotencyKey}`);
    }
    if (!existing.transaction.matchesPayload(hash)) {
      throw new IdempotencyConflictError(command.idempotencyKey, existing.transaction.id);
    }
    return { transaction: existing.transaction, balanceAfter: existing.balanceAfter, idempotentReplay: true };
  }
}
