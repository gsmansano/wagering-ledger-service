/**
 * An insert was refused as a conflict, yet no stored transaction owns the idempotency key or the provider
 * transaction id. Some other unique rule fired (for example a repeated internal id). The use case cannot tell
 * whether this is a replay, so it fails loudly instead: a bug, not a client error (not mapped to a 4xx).
 */
export class UnresolvedConflictError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly idempotencyKey: string,
  ) {
    super(`Insert conflicted but no stored transaction owns key ${idempotencyKey} of provider ${providerId}`);
    this.name = 'UnresolvedConflictError';
  }
}
