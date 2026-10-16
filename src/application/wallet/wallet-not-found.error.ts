/** No wallet exists for the given id (HTTP 404 at the edge). Nothing is persisted for the request. */
export class WalletNotFoundError extends Error {
  constructor(public readonly walletId: string) {
    super(`Wallet ${walletId} not found`);
    this.name = 'WalletNotFoundError';
  }
}
