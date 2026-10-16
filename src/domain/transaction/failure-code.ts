/**
 * Stable, machine-readable reason a transaction was REJECTED or FAILED.
 * Providers use it to decide whether to resend, fix the payload or give up.
 */
export enum FailureCode {
  /** BET larger than the balance. Do not resend. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** A reversal would take the balance below zero. Needs operational handling. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** The referenced transaction never arrived within the retry limit. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** The referenced transaction exists but ended REJECTED or FAILED, so there is nothing to reverse. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** The reference belongs to another provider, player, wallet, currency or round. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** REFUND of a non-BET, or ROLLBACK of a LOSS, OPENING or ROLLBACK. */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** The reference was already reversed by the same operation type. */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** The reversal amount differs from the reference amount. */
  AmountMismatch = 'AMOUNT_MISMATCH',
  /** The transaction currency differs from the wallet currency. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** No wallet exists for the given id. */
  WalletNotFound = 'WALLET_NOT_FOUND',
  /** FAILED only: permanent infrastructure error, not caused by the payload. */
  ProcessingFailed = 'PROCESSING_FAILED',
}
