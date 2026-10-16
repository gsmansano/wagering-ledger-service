import { DomainError } from '../shared/domain-error';
import { FailureCode } from './failure-code';
import { InvalidTransactionStateError } from './invalid-transaction-state-error';
import type { Money } from '../shared/money';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';

export enum WagerTransactionKind {
  /** Internal: opening credit of a wallet. Never accepted from the API or the queue. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Accepted, not yet applied. */
  Pending = 'PENDING',
  /** Waiting for the referenced transaction to arrive or finish. */
  PendingReference = 'PENDING_REFERENCE',
  /** Applied (terminal). */
  Processed = 'PROCESSED',
  /** Business rule violated (terminal). */
  Rejected = 'REJECTED',
  /** Permanent infrastructure error (terminal, kept for audit). */
  Failed = 'FAILED',
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Id of the referenced transaction at the provider, not the internal id. */
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
}

export type CreateWagerTransactionProps = Omit<
  WagerTransactionState,
  'status' | 'referenceTransactionId' | 'failureCode' | 'processedAt'
>;

/** What a reversal should do, given the state of the transaction it references. */
export enum ReferenceReadiness {
  /** Not received yet: keep waiting (until the retry limit). */
  Missing = 'MISSING',
  /** Received but still PENDING or PENDING_REFERENCE: keep waiting. */
  Waiting = 'WAITING',
  /** PROCESSED: the reversal can proceed to the remaining checks. */
  Ready = 'READY',
  /** REJECTED or FAILED: nothing to reverse, reject with REFERENCE_NOT_PROCESSED. */
  Unprocessable = 'UNPROCESSABLE',
}

/** Only a terminal REJECTED or FAILED reference is unprocessable; anything in flight means wait. */
export function referenceReadiness(reference: WagerTransaction | undefined): ReferenceReadiness {
  if (reference === undefined) return ReferenceReadiness.Missing;
  switch (reference.status) {
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return ReferenceReadiness.Waiting;
    case WagerTransactionStatus.Processed:
      return ReferenceReadiness.Ready;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return ReferenceReadiness.Unprocessable;
    default: {
      // Compile-time guard: a new status must be classified here.
      const unhandled: never = reference.status;
      throw new DomainError(`Unclassified status: ${String(unhandled)}`);
    }
  }
}

const REVERSIBLE_KINDS = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
]);

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
  ) {}

  /**
   * Starts in PENDING. Invalid payloads throw a DomainError and are never persisted:
   * empty identifiers, a negative amount, a reference on a BET or OPENING, or a missing reference on a REFUND or ROLLBACK.
   * WIN and LOSS may carry a reference; it is kept as information and never blocks processing.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const identifiers = {
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
    };
    for (const [name, value] of Object.entries(identifiers)) {
      if (value.trim() === '') throw new DomainError(`${name} must not be empty`);
    }
    if (props.money.isNegative()) {
      throw new DomainError(`Amount must not be negative, got ${props.money}`);
    }
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new DomainError(`${props.kind} amount must be positive, got ${props.money}`);
    }

    const reference = props.referenceExternalTransactionId;
    if (reference !== undefined && reference.trim() === '') {
      throw new DomainError('referenceExternalTransactionId must not be empty when provided');
    }
    const needsReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (needsReference && reference === undefined) {
      throw new DomainError(`${props.kind} requires referenceExternalTransactionId`);
    }
    const forbidsReference =
      props.kind === WagerTransactionKind.Bet || props.kind === WagerTransactionKind.Opening;
    if (forbidsReference && reference !== undefined) {
      throw new DomainError(`${props.kind} must not carry referenceExternalTransactionId`);
    }

    return WagerTransaction.rehydrate({
      ...props,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
    });
  }

  /** Rebuilds a persisted transaction; it was valid when saved, so nothing is re-checked. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  // ---- transitions: PENDING -> any; PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED; terminal -> nothing

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  /** Only a PENDING reversal can start waiting. Retries are tracked outside the entity. */
  markPendingReference(): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(this._status, WagerTransactionStatus.PendingReference);
    }
    if (!this.requiresReference()) {
      throw new DomainError(`${this.kind} does not wait for a reference`);
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode, at: Date): void {
    if (code === FailureCode.ProcessingFailed) {
      throw new DomainError(`${code} is reserved for FAILED transactions`);
    }
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    if (code !== FailureCode.ProcessingFailed) {
      throw new DomainError(`FAILED transactions use ${FailureCode.ProcessingFailed}, got ${code}`);
    }
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  /** False for LOSS, which records an outcome without moving money. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direction of the ledger entry this transaction produces.
   * LOSS has none (callers check affectsBalance first) and throws.
   * ROLLBACK is the inverse of its reference, which must be a BET, WIN or REFUND.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw new DomainError('LOSS does not affect the balance and has no ledger direction');
      case WagerTransactionKind.Rollback: {
        if (reference === undefined) {
          throw new DomainError('ROLLBACK needs its reference to determine the ledger direction');
        }
        if (!REVERSIBLE_KINDS.has(reference.kind)) {
          throw new DomainError(`ROLLBACK cannot reverse a ${reference.kind}`);
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  private assertNotTerminal(attempted: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, attempted);
    }
  }
}
