import type { PersistedWagerTransaction } from '../ports/wager-transaction.repository';
import type { UnitOfWork } from '../ports/unit-of-work';
import { TransactionNotFoundError } from './transaction-not-found.error';

/** Reads a stored transaction, whatever its status. Throws TransactionNotFoundError. */
export class GetTransaction {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  byId(transactionId: string): Promise<PersistedWagerTransaction> {
    return this.unitOfWork.run(async (repos) =>
      found(await repos.transactions.findById(transactionId), transactionId),
    );
  }

  /** The provider's own identifier; scoped by provider, so another provider's transaction never matches. */
  byProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<PersistedWagerTransaction> {
    return this.unitOfWork.run(async (repos) =>
      found(
        await repos.transactions.findByProviderAndExternalId(providerId, externalTransactionId),
        `${providerId}/${externalTransactionId}`,
      ),
    );
  }
}

function found(result: PersistedWagerTransaction | undefined, lookup: string): PersistedWagerTransaction {
  if (result === undefined) throw new TransactionNotFoundError(lookup);
  return result;
}
