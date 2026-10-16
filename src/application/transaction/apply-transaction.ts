import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import type { EventContext, IntegrationEvent } from '../../domain/events/integration-event';
import { FailureCode } from '../../domain/transaction/failure-code';
import {
  ReferenceReadiness,
  referenceReadiness,
  type WagerTransaction,
} from '../../domain/transaction/wager-transaction';
import { InsufficientFundsError } from '../../domain/wallet/insufficient-funds-error';
import type { Wallet } from '../../domain/wallet/wallet';
import { LedgerDirection } from '../../domain/wallet/wallet-ledger-entry';
import type { Repositories } from '../ports/unit-of-work';

export interface ApplyContext {
  at: Date;
  newId: () => string;
  correlationId: string;
}

export enum ApplyOutcome {
  /** The transaction reached PROCESSED or REJECTED (and its events were queued in `events`). */
  Settled = 'SETTLED',
  /** A reversal whose reference has not arrived or is still in flight; nothing was changed. */
  Waiting = 'WAITING',
}

type ReferenceVerdict =
  | { verdict: 'wait' }
  | { verdict: 'reject'; code: FailureCode }
  | { verdict: 'proceed'; reference: WagerTransaction };

/**
 * Applies a transaction to its wallet. The caller holds the wallet lock and runs this inside the single SQL
 * transaction, for a first delivery and for a retry of a pending reversal alike (decision #40). On `Settled` the
 * transaction has been moved to PROCESSED or REJECTED, the ledger and wallet written, and the events appended to
 * `events`; the caller persists the transaction and the events. On `Waiting` nothing was touched.
 */
export async function applyUnderLock(
  repos: Repositories,
  transaction: WagerTransaction,
  wallet: Wallet,
  context: ApplyContext,
  events: IntegrationEvent<unknown>[],
): Promise<ApplyOutcome> {
  const { at, newId, correlationId } = context;
  const eventContext = (): EventContext => ({
    eventId: newId(),
    correlationId,
    causationId: transaction.id,
    occurredAt: at,
  });
  const reject = (code: FailureCode): ApplyOutcome => {
    transaction.reject(code, at);
    events.push(WagerTransactionRejected.from(transaction, eventContext()));
    return ApplyOutcome.Settled;
  };

  if (transaction.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);

  // For a reversal, the transaction it reverses; read under the wallet lock, so its status and any reversal of it
  // are settled (a reference lives in this same wallet, or the checks reject it).
  let reference: WagerTransaction | undefined;
  if (transaction.requiresReference()) {
    const judged = await judgeReference(repos, transaction);
    if (judged.verdict === 'wait') return ApplyOutcome.Waiting;
    if (judged.verdict === 'reject') return reject(judged.code);
    reference = judged.reference;
  }

  if (!transaction.affectsBalance()) {
    transaction.markProcessed(undefined, at);
    events.push(WagerTransactionProcessed.from(transaction, eventContext()));
    return ApplyOutcome.Settled;
  }

  const versionRead = wallet.version;
  const movement = { entryId: newId(), transactionId: transaction.id, money: transaction.money, now: at };
  try {
    const entry =
      transaction.ledgerDirectionFor(reference) === LedgerDirection.Debit
        ? wallet.debit(movement)
        : wallet.credit(movement);
    await repos.ledger.append(entry);
    await repos.wallets.update(wallet, versionRead);
    transaction.markProcessed(reference?.id, at);
    events.push(WagerTransactionProcessed.from(transaction, eventContext()));
    events.push(WalletBalanceChanged.from(wallet, entry, eventContext()));
    return ApplyOutcome.Settled;
  } catch (error) {
    if (!(error instanceof InsufficientFundsError)) throw error;
    // A reversal that debits is undoing money already spent, which is not the same as a bet without funds.
    return reject(transaction.requiresReference() ? FailureCode.ReversalWouldOverdraw : FailureCode.InsufficientFunds);
  }
}

/**
 * Judges the reference of a reversal at first sight (decision #38). Only a reference that has not arrived, or
 * is still in flight, makes the reversal wait; every other failure is final.
 */
async function judgeReference(repos: Repositories, reversal: WagerTransaction): Promise<ReferenceVerdict> {
  const found = await repos.transactions.findByProviderAndExternalId(
    reversal.providerId,
    reversal.referenceExternalTransactionId!, // present: requiresReference() implies it (create enforces it)
  );
  const readiness = referenceReadiness(found?.transaction);
  if (readiness === ReferenceReadiness.Missing) return { verdict: 'wait' };
  const target = found!.transaction; // not Missing

  const sameContext =
    target.id !== reversal.id &&
    target.walletId === reversal.walletId &&
    target.playerId === reversal.playerId &&
    target.roundId === reversal.roundId &&
    target.money.currency === reversal.money.currency;
  if (!sameContext) return { verdict: 'reject', code: FailureCode.ReferenceMismatch };
  if (!reversal.canReverse(target)) return { verdict: 'reject', code: FailureCode.InvalidReferenceKind };

  if (readiness === ReferenceReadiness.Waiting) return { verdict: 'wait' };
  if (readiness === ReferenceReadiness.Unprocessable) {
    return { verdict: 'reject', code: FailureCode.ReferenceNotProcessed };
  }

  if (!target.money.equals(reversal.money)) return { verdict: 'reject', code: FailureCode.AmountMismatch };
  if (await repos.transactions.hasProcessedReversalOf(target.id)) {
    return { verdict: 'reject', code: FailureCode.AlreadyReversed };
  }
  return { verdict: 'proceed', reference: target };
}
