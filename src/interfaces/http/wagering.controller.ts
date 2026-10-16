import { BadRequestException, Body, Controller, Headers, HttpCode, Post, Res } from '@nestjs/common';
import { ProcessWagerTransaction } from '../../application/transaction/process-wager-transaction';
import { WagerTransactionKind } from '../../domain/transaction/wager-transaction';
import { asObject, correlationIdFrom, optionalString, requiredString, requiredUuid } from './request-parsing';
import { submitStatusCode, toTransactionView } from './transaction-view';

const KINDS = new Set<string>(Object.values(WagerTransactionKind));

@Controller('wagering')
export class WageringController {
  constructor(private readonly processWagerTransaction: ProcessWagerTransaction) {}

  @Post('transactions')
  @HttpCode(200)
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ) {
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
      walletId: requiredUuid(request, 'walletId'),
      roundId: requiredString(request, 'roundId'),
      gameId: requiredString(request, 'gameId'),
      kind: kind as WagerTransactionKind, // checked against the enum values just above
      money: { amount: requiredString(money, 'amount'), currency: requiredString(money, 'currency') },
      referenceExternalTransactionId: optionalString(request, 'referenceExternalTransactionId'),
      correlationId: correlationIdFrom(correlationId),
    });

    // Decision #43: 200 processed, 202 pending, 422 business rejection (a replay of any of them answers the same).
    response.status(submitStatusCode(result.transaction.status));
    return { ...toTransactionView(result.transaction, result.balanceAfter), idempotentReplay: result.idempotentReplay };
  }
}
