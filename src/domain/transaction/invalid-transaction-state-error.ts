import { DomainError } from '../shared/domain-error';

/** A state transition that the state machine forbids. A programming error, not a business outcome. */
export class InvalidTransactionStateError extends DomainError {
  constructor(
    public readonly from: string,
    public readonly attempted: string,
  ) {
    super(`Invalid transaction transition: ${from} -> ${attempted}`);
  }
}
