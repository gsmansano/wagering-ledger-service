import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/shared/money';
import { payloadHash } from '../../domain/shared/payload-hash';
import { WagerTransaction, WagerTransactionKind } from '../../domain/transaction/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { UnitOfWork } from '../ports/unit-of-work';
import { WalletAlreadyExistsError } from './wallet-already-exists.error';

/** Provider and round/game labels of the internal OPENING transaction (decision #20). */
const OPENING_PROVIDER_ID = 'SYSTEM';
const OPENING_LABEL = 'opening';

export interface CreateWalletCommand {
  playerId: string;
  currency: string;
  /** Decimal string such as "1000.00". Omitted or "0.00" opens an empty wallet. Negative is invalid. */
  initialAmount?: string;
  correlationId?: string;
}

export interface CreateWalletDeps {
  unitOfWork: UnitOfWork;
  now: () => Date;
  newId: () => string;
}

export class CreateWallet {
  constructor(private readonly deps: CreateWalletDeps) {}

  /**
   * Creates the wallet and, when it opens with money, the OPENING transaction, its CREDIT ledger entry and the
   * WalletBalanceChanged event, all in one SQL transaction (decision #27).
   * Throws DomainError for an invalid payload and WalletAlreadyExistsError for a duplicate player and currency.
   */
  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const { unitOfWork, now, newId } = this.deps;
    const at = now();
    const opening = Money.from({ amount: command.initialAmount ?? '0', currency: command.currency });
    const wallet = Wallet.open({ id: newId(), playerId: command.playerId, initialBalance: opening, now: at });

    return unitOfWork.run(async (repos) => {
      // ON CONFLICT instead of a pre-check: two concurrent creations cannot both pass, and a conflict does not abort the transaction.
      if (!(await repos.wallets.insertIfAbsent(wallet))) {
        throw new WalletAlreadyExistsError(command.playerId, command.currency);
      }
      if (!opening.isPositive()) return wallet;

      const transaction = WagerTransaction.create({
        id: newId(),
        providerId: OPENING_PROVIDER_ID,
        externalTransactionId: wallet.id,
        idempotencyKey: `opening:${wallet.id}`,
        payloadHash: payloadHash({
          providerId: OPENING_PROVIDER_ID,
          externalTransactionId: wallet.id,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: OPENING_LABEL,
          gameId: OPENING_LABEL,
          kind: WagerTransactionKind.Opening,
          money: opening.toJSON(),
        }),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: OPENING_LABEL,
        gameId: OPENING_LABEL,
        kind: WagerTransactionKind.Opening,
        money: opening,
        referenceExternalTransactionId: undefined,
        createdAt: at,
      });
      await repos.transactions.insert(transaction);

      // Built directly from a zero balance: the wallet was opened already holding the amount so that version stays 1.
      const entry = WalletLedgerEntry.create({
        id: newId(),
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: LedgerDirection.Credit,
        money: opening,
        balanceBefore: Money.zero(command.currency),
        balanceAfter: opening,
        createdAt: at,
      });
      await repos.ledger.append(entry);

      transaction.markProcessed(undefined, at);
      await repos.transactions.update(transaction, wallet.balance);

      const event = WalletBalanceChanged.from(wallet, entry, {
        eventId: newId(),
        correlationId: command.correlationId ?? newId(),
        causationId: transaction.id,
        occurredAt: at,
      });
      await repos.outbox.insert(OutboxMessage.enqueue(event));
      return wallet;
    });
  }
}
