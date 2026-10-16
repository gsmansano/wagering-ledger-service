import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { CreateWallet } from '../../application/wallet/create-wallet';
import { asObject, optionalString, requiredString } from './request-parsing';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly createWallet: CreateWallet) {}

  // `initialBalance.amount` is optional: without it (or with "0.00") the wallet opens empty (decision #27).
  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const request = asObject(body, 'body');
    const initialBalance = asObject(request.initialBalance, 'initialBalance');
    const wallet = await this.createWallet.execute({
      playerId: requiredString(request, 'playerId'),
      currency: requiredString(initialBalance, 'currency'),
      initialAmount: optionalString(initialBalance, 'amount'),
    });
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }
}
