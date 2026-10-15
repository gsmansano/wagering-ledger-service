import { DomainError } from './domain-error';
import type { Money } from './money';

/** A debit larger than the balance. A business outcome, not a bug: the use case rejects the transaction. */
export class InsufficientFundsError extends DomainError {
  constructor(
    public readonly balance: Money,
    public readonly requested: Money,
  ) {
    super(`Insufficient funds: balance ${balance}, requested ${requested}`);
  }
}
