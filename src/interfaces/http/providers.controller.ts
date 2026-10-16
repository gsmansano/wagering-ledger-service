import { Controller, Get, Param } from '@nestjs/common';
import { GetTransaction } from '../../application/query/get-transaction';
import { toTransactionView } from './transaction-view';

@Controller('providers')
export class ProvidersController {
  constructor(private readonly getTransaction: GetTransaction) {}

  // The provider's own identifier for the transaction, scoped by provider (the pair is unique in the schema).
  @Get(':providerId/wagering/transactions/:externalTransactionId')
  async get(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    const { transaction, balanceAfter } = await this.getTransaction.byProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
    return toTransactionView(transaction, balanceAfter);
  }
}
