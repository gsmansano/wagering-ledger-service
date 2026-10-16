import type { WagerTransactionKind } from '../../domain/transaction/wager-transaction';

/** The kind is valid but not handled yet. REFUND and ROLLBACK arrive in M5; this error goes away with them. */
export class UnsupportedKindError extends Error {
  constructor(public readonly kind: WagerTransactionKind) {
    super(`Transaction kind ${kind} is not supported yet`);
    this.name = 'UnsupportedKindError';
  }
}
