/**
 * Waiting for the wallet lock took longer than the configured limit (decision #65). Nothing was written: the whole
 * transaction rolled back, so the provider can resend the same request. The underlying database error is the
 * `cause`; the error itself is what maps to a retryable 503.
 */
export class WalletLockTimeoutError extends Error {
  constructor(
    public readonly walletId: string,
    options?: { cause?: unknown },
  ) {
    super(`Timed out waiting for the lock on wallet ${walletId}`, options);
    this.name = 'WalletLockTimeoutError';
  }
}
