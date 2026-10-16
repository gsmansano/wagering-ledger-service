import { BadRequestException, Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { ProcessWagerTransaction } from '../../application/transaction/process-wager-transaction';
import { WagerTransactionKind } from '../../domain/transaction/wager-transaction';
import { asObject, optionalString, requiredString } from './request-parsing';

const KINDS = new Set<string>(Object.values(WagerTransactionKind));

@Controller('wagering')
export class WageringController {
  constructor(private readonly processWagerTransaction: ProcessWagerTransaction) {}

  @Post('transactions')
  @HttpCode(200)
  async submit(@Headers('idempotency-key') idempotencyKey: string | undefined, @Body() body: unknown) {
    if (idempotencyKey === undefined || idempotencyKey.trim() === '') {
      throw new BadRequestException({ error: 'MALFORMED_REQUEST', message: 'The Idempotency-Key header is required' });
    }
    const request = asObject(body, 'body');
    const kind = requiredString(request, 'kind');
    if (!KINDS.has(kind)) {
      throw new BadRequestException({ error: 'MALFORMED_REQUEST', message: `kind must be one of ${[...KINDS].join(', ')}` });
    }
    const money = asObject(request.money, 'money');

    const result = await this.processWagerTransaction.execute({
      idempotencyKey,
      providerId: requiredString(request, 'providerId'),
      externalTransactionId: requiredString(request, 'externalTransactionId'),
      playerId: requiredString(request, 'playerId'),
      walletId: requiredString(request, 'walletId'),
      roundId: requiredString(request, 'roundId'),
      gameId: requiredString(request, 'gameId'),
      kind: kind as WagerTransactionKind, // checked against the enum values just above
      money: { amount: requiredString(money, 'amount'), currency: requiredString(money, 'currency') },
      referenceExternalTransactionId: optionalString(request, 'referenceExternalTransactionId'),
    });

    return {
      transactionId: result.transaction.id,
      status: result.transaction.status,
      ...(result.transaction.failureCode !== undefined && { failureCode: result.transaction.failureCode }),
      balance: result.balanceAfter?.toJSON(),
      idempotentReplay: result.idempotentReplay,
    };
  }
}
