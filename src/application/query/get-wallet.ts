import type { Wallet } from '../../domain/wallet/wallet';
import type { UnitOfWork } from '../ports/unit-of-work';
import { WalletNotFoundError } from '../wallet/wallet-not-found.error';

/** Reads a wallet. Throws WalletNotFoundError. */
export class GetWallet {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(walletId: string): Promise<Wallet> {
    return this.unitOfWork.run(async (repos) => {
      const wallet = await repos.wallets.findById(walletId);
      if (wallet === undefined) throw new WalletNotFoundError(walletId);
      return wallet;
    });
  }
}
