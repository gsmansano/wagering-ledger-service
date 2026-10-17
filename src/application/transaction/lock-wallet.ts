import type { Wallet } from '../../domain/wallet/wallet';
import { type Metrics, NO_METRICS } from '../ports/metrics';
import type { Repositories } from '../ports/unit-of-work';
import { WalletLockTimeoutError } from '../wallet/wallet-lock-timeout.error';

/**
 * Takes the wallet lock and reports how long the wait was, including a wait that ended in a timeout. The wait is
 * reported when it ends, before the transaction commits: it measures contention, not a business outcome.
 * Throws WalletLockTimeoutError. Undefined when the wallet does not exist.
 */
export async function lockWallet(repos: Repositories, walletId: string, metrics: Metrics = NO_METRICS): Promise<Wallet | undefined> {
  const started = performance.now();
  try {
    const wallet = await repos.wallets.findByIdForUpdate(walletId);
    metrics.walletLockWaited('acquired', (performance.now() - started) / 1000);
    return wallet;
  } catch (error) {
    if (error instanceof WalletLockTimeoutError) metrics.walletLockWaited('timeout', (performance.now() - started) / 1000);
    throw error;
  }
}
