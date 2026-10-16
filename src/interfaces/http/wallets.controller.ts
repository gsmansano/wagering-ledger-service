import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { GetLedger } from '../../application/query/get-ledger';
import { GetWallet } from '../../application/query/get-wallet';
import { CreateWallet } from '../../application/wallet/create-wallet';
import { decodeLedgerCursor, encodeLedgerCursor, parseLedgerLimit } from './ledger-cursor';
import { asObject, asUuid, optionalString, requiredString } from './request-parsing';
import { toLedgerEntryView, toWalletView } from './transaction-view';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly getWallet: GetWallet,
    private readonly getLedger: GetLedger,
  ) {}

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
    return toWalletView(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return toWalletView(await this.getWallet.execute(asUuid(walletId, 'walletId')));
  }

  // Entries in the order they were applied. Pass `nextCursor` back as `cursor` for the next page (decision #46).
  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    const page = await this.getLedger.execute(asUuid(walletId, 'walletId'), {
      afterSequence: cursor === undefined ? undefined : decodeLedgerCursor(cursor),
      limit: parseLedgerLimit(limit),
    });
    return {
      entries: page.entries.map(toLedgerEntryView),
      nextCursor: page.nextAfterSequence === undefined ? null : encodeLedgerCursor(page.nextAfterSequence),
    };
  }
}
