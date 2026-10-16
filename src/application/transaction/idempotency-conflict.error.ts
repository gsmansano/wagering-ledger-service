/** The idempotency key or provider transaction id was already used with a different payload (HTTP 409 at the edge). */
export class IdempotencyConflictError extends Error {
  constructor(
    public readonly idempotencyKey: string,
    public readonly existingTransactionId: string,
  ) {
    super(`Idempotency key ${idempotencyKey} was already used with a different payload (transaction ${existingTransactionId})`);
    this.name = 'IdempotencyConflictError';
  }
}
