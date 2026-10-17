import { type Metrics, NO_METRICS } from '../ports/metrics';
import type { LedgerReconciliation } from '../ports/ledger.repository';
import type { UnitOfWork } from '../ports/unit-of-work';
import { WalletNotFoundError } from './wallet-not-found.error';

export interface ReconciliationResult extends LedgerReconciliation {
  walletId: string;
}

/**
 * Checks a wallet's balance against its ledger (spec §9). Read-only on purpose: a divergence is reported to the
 * caller (and logged by the edge), never corrected here, because the ledger is the audit trail and a silent fix
 * would hide the cause. Throws WalletNotFoundError.
 */
export class ReconcileWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly metrics: Metrics = NO_METRICS,
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const result = await this.unitOfWork.run((repos) => repos.ledger.reconcile(walletId));
    if (result === undefined) throw new WalletNotFoundError(walletId);
    if (!result.consistent) this.metrics.reconciliationDivergence();
    return { walletId, ...result };
  }
}
