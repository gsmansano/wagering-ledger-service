import { Body, Controller, Get, HttpCode, Logger, Param, Post, Query } from '@nestjs/common';
import { GetLedger } from '../../application/query/get-ledger';
import { GetWallet } from '../../application/query/get-wallet';
import { CreateWallet } from '../../application/wallet/create-wallet';
import { ReconcileWallet } from '../../application/wallet/reconcile-wallet';
import { decodeLedgerCursor, encodeLedgerCursor, parseLedgerLimit } from './ledger-cursor';
import { asObject, asUuid, optionalString, requiredString } from './request-parsing';
import { toLedgerEntryView, toWalletView } from './transaction-view';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly getWallet: GetWallet,
    private readonly getLedger: GetLedger,
    private readonly reconcileWallet: ReconcileWallet,
  ) {}

  private readonly logger = new Logger(WalletsController.name);

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

  // Always 200: the check itself succeeded, `consistent` carries the verdict. Nothing is corrected (spec §9).
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    const result = await this.reconcileWallet.execute(asUuid(walletId, 'walletId'));
    if (!result.consistent) {
      // Diagnostic fields only, no balances: enough to find the wallet and size the problem.
      this.logger.error(
        JSON.stringify({
          event: 'reconciliation_divergence',
          walletId: result.walletId,
          difference: result.difference,
          checkedEntries: result.checkedEntries,
        }),
      );
    }
    const money = (amount: string) => ({ amount, currency: result.currency });
    return {
      walletId: result.walletId,
      storedBalance: money(result.storedBalance),
      calculatedBalance: money(result.calculatedBalance),
      difference: money(result.difference),
      consistent: result.consistent,
      checkedEntries: result.checkedEntries,
    };
  }
}
