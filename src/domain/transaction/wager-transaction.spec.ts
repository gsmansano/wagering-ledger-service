import { describe, expect, it } from 'bun:test';
import { DomainError } from '../shared/domain-error';
import { FailureCode } from './failure-code';
import { InvalidTransactionStateError } from './invalid-transaction-state-error';
import { Money } from '../shared/money';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import {
  ReferenceReadiness,
  referenceReadiness,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
} from './wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const t0 = new Date('2026-01-01T00:00:00Z');
const t1 = new Date('2026-01-01T00:05:00Z');

function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: 'tx1',
    providerId: 'prov',
    externalTransactionId: 'ext1',
    idempotencyKey: 'key1',
    payloadHash: 'hash1',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind: Kind.Bet,
    money: brl('10.00'),
    referenceExternalTransactionId: undefined,
    createdAt: t0,
    ...overrides,
  };
}

const bet = (o: Partial<CreateWagerTransactionProps> = {}) => WagerTransaction.create(props(o));
const reversal = (kind: Kind.Refund | Kind.Rollback = Kind.Refund) =>
  WagerTransaction.create(props({ kind, referenceExternalTransactionId: 'ext0' }));

/** A transaction of the given kind driven to the given status. */
function inStatus(status: Status, kind: Kind = Kind.Bet): WagerTransaction {
  const tx = kind === Kind.Refund || kind === Kind.Rollback ? reversal(kind) : bet({ kind });
  switch (status) {
    case Status.Pending:
      break;
    case Status.PendingReference:
      tx.markPendingReference();
      break;
    case Status.Processed:
      tx.markProcessed(undefined, t1);
      break;
    case Status.Rejected:
      tx.reject(FailureCode.InsufficientFunds, t1);
      break;
    case Status.Failed:
      tx.fail(FailureCode.ProcessingFailed, t1);
      break;
  }
  return tx;
}

describe('WagerTransaction', () => {
  describe('create', () => {
    it('starts PENDING with no outcome fields', () => {
      const tx = bet();
      expect(tx.status).toBe(Status.Pending);
      expect(tx.failureCode).toBeUndefined();
      expect(tx.processedAt).toBeUndefined();
      expect(tx.referenceTransactionId).toBeUndefined();
    });

    it.each([Kind.Refund, Kind.Rollback])('%s requires a reference', (kind) => {
      expect(() => bet({ kind })).toThrow(DomainError);
      expect(() => bet({ kind, referenceExternalTransactionId: 'ext0' })).not.toThrow();
    });

    it.each([Kind.Bet, Kind.Opening])('%s with a stray reference is an invalid payload', (kind) => {
      expect(() => bet({ kind, referenceExternalTransactionId: 'ext0' })).toThrow(DomainError);
    });

    it.each([Kind.Win, Kind.Loss])('%s may or may not carry a reference', (kind) => {
      expect(bet({ kind }).referenceExternalTransactionId).toBeUndefined();
      expect(bet({ kind, referenceExternalTransactionId: 'ext0' }).referenceExternalTransactionId).toBe('ext0');
    });

    it('a referenced WIN is created PENDING and does not wait for its reference', () => {
      const win = bet({ kind: Kind.Win, referenceExternalTransactionId: 'ext0' });
      expect(win.status).toBe(Status.Pending);
      expect(win.requiresReference()).toBe(false);
      expect(() => win.markPendingReference()).toThrow(DomainError);
    });

    it('rejects an empty reference when one is provided', () => {
      expect(() => bet({ kind: Kind.Win, referenceExternalTransactionId: ' ' })).toThrow(DomainError);
    });

    it.each(['providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash', 'walletId', 'playerId', 'roundId', 'gameId'] as const)(
      'rejects an empty %s',
      (field) => {
        expect(() => bet({ [field]: '  ' })).toThrow(DomainError);
      },
    );

    it('rejects a zero amount except for LOSS', () => {
      expect(() => bet({ money: Money.zero('BRL') })).toThrow(DomainError);
      expect(() => bet({ kind: Kind.Loss, money: Money.zero('BRL') })).not.toThrow();
    });

    it('rejects a negative amount', () => {
      expect(() => bet({ money: brl('1.00').negate() })).toThrow(DomainError);
      expect(() => bet({ kind: Kind.Loss, money: brl('1.00').negate() })).toThrow(DomainError);
    });
  });

  describe('transitions', () => {
    it('PENDING -> PROCESSED records the reference id and time', () => {
      const tx = bet();
      tx.markProcessed('tx0', t1);
      expect(tx.status).toBe(Status.Processed);
      expect(tx.referenceTransactionId).toBe('tx0');
      expect(tx.processedAt).toEqual(t1);
      expect(tx.failureCode).toBeUndefined();
    });

    it('PENDING -> PENDING_REFERENCE -> PROCESSED', () => {
      const tx = reversal();
      tx.markPendingReference();
      expect(tx.status).toBe(Status.PendingReference);
      expect(tx.isTerminal()).toBe(false);
      tx.markProcessed('tx0', t1);
      expect(tx.status).toBe(Status.Processed);
    });

    it('PENDING and PENDING_REFERENCE can be rejected or failed', () => {
      for (const from of [Status.Pending, Status.PendingReference]) {
        const rejected = inStatus(from, Kind.Refund);
        rejected.reject(FailureCode.ReferenceNotFound, t1);
        expect(rejected.status).toBe(Status.Rejected);
        expect(rejected.failureCode).toBe(FailureCode.ReferenceNotFound);
        expect(rejected.processedAt).toEqual(t1);

        const failed = inStatus(from, Kind.Refund);
        failed.fail(FailureCode.ProcessingFailed, t1);
        expect(failed.status).toBe(Status.Failed);
        expect(failed.failureCode).toBe(FailureCode.ProcessingFailed);
      }
    });

    it('PENDING_REFERENCE does not transition to itself', () => {
      expect(() => inStatus(Status.PendingReference, Kind.Refund).markPendingReference()).toThrow(
        InvalidTransactionStateError,
      );
    });

    it.each([Status.Processed, Status.Rejected, Status.Failed])('%s is terminal: every transition throws', (status) => {
      const tx = inStatus(status);
      expect(tx.isTerminal()).toBe(true);
      expect(() => tx.markProcessed(undefined, t1)).toThrow(InvalidTransactionStateError);
      expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
      expect(() => tx.reject(FailureCode.InsufficientFunds, t1)).toThrow(InvalidTransactionStateError);
      expect(() => tx.fail(FailureCode.ProcessingFailed, t1)).toThrow(InvalidTransactionStateError);
      expect(tx.status).toBe(status);
    });

    it('a failed transition leaves the state untouched', () => {
      const tx = inStatus(Status.Rejected);
      expect(() => tx.markProcessed('tx0', t1)).toThrow();
      expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(tx.referenceTransactionId).toBeUndefined();
    });

    it('keeps PROCESSING_FAILED exclusive to FAILED', () => {
      expect(() => bet().reject(FailureCode.ProcessingFailed, t1)).toThrow(DomainError);
      expect(() => bet().fail(FailureCode.InsufficientFunds, t1)).toThrow(DomainError);
    });
  });

  describe('queries', () => {
    it('affectsBalance is false only for LOSS', () => {
      for (const kind of [Kind.Opening, Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback]) {
        expect(WagerTransaction.rehydrate({ ...stateOf(bet()), kind }).affectsBalance()).toBe(true);
      }
      expect(bet({ kind: Kind.Loss }).affectsBalance()).toBe(false);
    });

    it('requiresReference is true only for REFUND and ROLLBACK', () => {
      expect(reversal(Kind.Refund).requiresReference()).toBe(true);
      expect(reversal(Kind.Rollback).requiresReference()).toBe(true);
      for (const kind of [Kind.Bet, Kind.Win, Kind.Loss]) {
        expect(bet({ kind }).requiresReference()).toBe(false);
      }
    });

    it('matchesPayload compares the hash', () => {
      expect(bet().matchesPayload('hash1')).toBe(true);
      expect(bet().matchesPayload('other')).toBe(false);
    });
  });

  describe('ledgerDirectionFor', () => {
    it('BET debits; WIN, REFUND and OPENING credit', () => {
      expect(bet().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(bet({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(reversal(Kind.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(bet({ kind: Kind.Opening }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });

    it('LOSS has no direction and throws', () => {
      expect(() => bet({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(DomainError);
    });

    it('ROLLBACK is the inverse of its reference', () => {
      const rollback = reversal(Kind.Rollback);
      expect(rollback.ledgerDirectionFor(bet())).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(bet({ kind: Kind.Win }))).toBe(LedgerDirection.Debit);
      expect(rollback.ledgerDirectionFor(reversal(Kind.Refund))).toBe(LedgerDirection.Debit);
    });

    it('ROLLBACK without a reference, or with a non-reversible one, throws', () => {
      const rollback = reversal(Kind.Rollback);
      expect(() => rollback.ledgerDirectionFor()).toThrow(DomainError);
      expect(() => rollback.ledgerDirectionFor(bet({ kind: Kind.Loss }))).toThrow(DomainError);
      expect(() => rollback.ledgerDirectionFor(reversal(Kind.Rollback))).toThrow(DomainError);
    });
  });

  it('rehydrate restores state as given, without validation', () => {
    const tx = WagerTransaction.rehydrate({
      ...stateOf(bet()),
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      processedAt: t1,
    });
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.processedAt).toEqual(t1);
  });
});

describe('referenceReadiness', () => {
  it('waits when the reference has not arrived', () => {
    expect(referenceReadiness(undefined)).toBe(ReferenceReadiness.Missing);
  });

  it.each([Status.Pending, Status.PendingReference])('waits while the reference is %s', (status) => {
    expect(referenceReadiness(inStatus(status, Kind.Refund))).toBe(ReferenceReadiness.Waiting);
  });

  it('is ready when the reference is PROCESSED', () => {
    expect(referenceReadiness(inStatus(Status.Processed))).toBe(ReferenceReadiness.Ready);
  });

  it.each([Status.Rejected, Status.Failed])('is unprocessable only when the reference is %s', (status) => {
    expect(referenceReadiness(inStatus(status))).toBe(ReferenceReadiness.Unprocessable);
  });

  it('classifies every status, and only REJECTED and FAILED are unprocessable', () => {
    const unprocessable = Object.values(Status).filter(
      (status) => referenceReadiness(inStatus(status, Kind.Refund)) === ReferenceReadiness.Unprocessable,
    );
    expect(unprocessable.sort()).toEqual([Status.Failed, Status.Rejected]);
  });
});

function stateOf(tx: WagerTransaction) {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    createdAt: tx.createdAt,
    status: tx.status,
    referenceTransactionId: tx.referenceTransactionId,
    failureCode: tx.failureCode,
    processedAt: tx.processedAt,
  };
}
