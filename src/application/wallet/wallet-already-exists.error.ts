/** A wallet for this player and currency already exists (HTTP 409 at the edge). */
export class WalletAlreadyExistsError extends Error {
  constructor(
    public readonly playerId: string,
    public readonly currency: string,
  ) {
    super(`Wallet already exists for player ${playerId} in ${currency}`);
    this.name = 'WalletAlreadyExistsError';
  }
}
