import { DomainError } from '../shared/domain-error';
import { InvalidInputError } from '../shared/invalid-input-error';
import { InsufficientFundsError } from './insufficient-funds-error';
import type { Money } from '../shared/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Everything a movement needs from the caller. Ids and time are passed in so the domain stays deterministic. */
export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  now: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; now: Date }): Wallet {
    if (props.playerId.trim() === '') {
      throw new InvalidInputError('playerId must not be empty');
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidInputError('Initial balance must not be negative');
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );
  }

  /** Rebuilds a persisted wallet; it was valid when saved, so nothing is re-checked. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Lowers the balance and returns the ledger entry that records it. Throws InsufficientFundsError if it would go negative. */
  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertValidMovement(movement.money);
    if (this._balance.isLessThan(movement.money)) {
      throw new InsufficientFundsError(this._balance, movement.money);
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(movement.money), movement);
  }

  /** Raises the balance and returns the ledger entry that records it. */
  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertValidMovement(movement.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(movement.money), movement);
  }

  // The entry is built before any field changes, so if it throws the wallet is untouched.
  private apply(direction: LedgerDirection, newBalance: Money, movement: WalletMovement): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter: newBalance,
      createdAt: movement.now,
    });
    this._balance = newBalance;
    this._version += 1;
    this._updatedAt = movement.now;
    return entry;
  }

  private assertValidMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new DomainError(`Movement amount must be positive, got ${money}`);
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new DomainError(`Currency mismatch: wallet is ${this.currency}, movement is ${money.currency}`);
    }
  }
}
