/**
 * A wallet changed between the moment it was read under the lock and the moment it was written back. The lock
 * makes this impossible, so reaching it means a code path wrote without locking: a bug, not a business outcome
 * (it is deliberately not mapped to a client error).
 */
export class WalletVersionConflictError extends Error {
  constructor(
    public readonly walletId: string,
    public readonly expectedVersion: number,
  ) {
    super(`Wallet ${walletId} was not at version ${expectedVersion} when it was updated`);
    this.name = 'WalletVersionConflictError';
  }
}
