import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from '../../src/application/transaction/process-wager-transaction';
import { CreateWallet } from '../../src/application/wallet/create-wallet';
import { WagerTransactionKind as Kind, WagerTransactionStatus } from '../../src/domain/transaction/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/repositories/mikro-orm-unit-of-work';
import { initTestOrm, truncateAll } from '../support/database';

// Which events each outcome writes to the outbox (spec §11), and the contract a consumer can rely on when a wallet's
// events are read in outbox order: walletVersion rises by one and balances chain, so a gap is detectable (#58).
describe('events written to the outbox (real PostgreSQL)', () => {
  let orm: MikroORM;
  let createWallet: CreateWallet;
  let process: ProcessWagerTransaction;
  let sequence = 0;

  const query = <T>(sql: string, params: unknown[] = []) => orm.em.getConnection().execute<T[]>(sql, params);
  const eventTypes = async (walletId: string) =>
    (await query<{ event_type: string }>('select event_type from outbox_messages where aggregate_id = ? order by sequence', [walletId])).map(
      (r) => r.event_type,
    );
  /** Events written after the wallet's opening one. */
  const eventsAfterOpening = async (walletId: string) => (await eventTypes(walletId)).slice(1);

  const open = (amount = '100.00') => createWallet.execute({ playerId: `p${++sequence}`, currency: 'BRL', initialAmount: amount });
  const send = (walletId: string, playerId: string, kind: Kind, amount: string, referenceExternalId?: string) => {
    sequence += 1;
    const command: ProcessWagerTransactionCommand = {
      idempotencyKey: `key-${sequence}`,
      providerId: 'provider-1',
      externalTransactionId: `ext-${sequence}`,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind,
      money: { amount, currency: 'BRL' },
      ...(referenceExternalId === undefined ? {} : { referenceExternalTransactionId: referenceExternalId }),
    };
    return process.execute(command);
  };

  beforeAll(async () => {
    orm = await initTestOrm();
    const deps = { unitOfWork: new MikroOrmUnitOfWork(orm.em), now: () => new Date(), newId: () => Bun.randomUUIDv7() };
    createWallet = new CreateWallet(deps);
    process = new ProcessWagerTransaction(deps);
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
  });

  const PROCESSED = 'WagerTransactionProcessed';
  const CHANGED = 'WalletBalanceChanged';

  describe('per outcome', () => {
    it('a wallet opened with money announces the balance change; an empty wallet announces nothing', async () => {
      const funded = await open('100.00');
      const empty = await open('0.00');
      expect(await eventTypes(funded.id)).toEqual([CHANGED]);
      expect(await eventTypes(empty.id)).toEqual([]);
    });

    it('BET and WIN that apply write Processed and BalanceChanged', async () => {
      const w = await open();
      await send(w.id, w.playerId, Kind.Bet, '10.00');
      await send(w.id, w.playerId, Kind.Win, '25.00');
      expect(await eventsAfterOpening(w.id)).toEqual([PROCESSED, CHANGED, PROCESSED, CHANGED]);
    });

    it('LOSS writes only Processed: the balance does not move', async () => {
      const w = await open();
      await send(w.id, w.playerId, Kind.Loss, '10.00');
      expect(await eventsAfterOpening(w.id)).toEqual([PROCESSED]);
    });

    it('a rejection writes only Rejected (insufficient funds, amount mismatch)', async () => {
      const w = await open('10.00');
      await send(w.id, w.playerId, Kind.Bet, '50.00'); // insufficient funds
      const bet = await send(w.id, w.playerId, Kind.Bet, '1.00');
      await send(w.id, w.playerId, Kind.Refund, '2.00', bet.transaction.externalTransactionId); // amount mismatch
      expect(await eventsAfterOpening(w.id)).toEqual([
        'WagerTransactionRejected',
        PROCESSED,
        CHANGED,
        'WagerTransactionRejected',
      ]);
    });

    it('REFUND and ROLLBACK that apply write Processed and BalanceChanged', async () => {
      const w = await open();
      const bet = await send(w.id, w.playerId, Kind.Bet, '10.00');
      const win = await send(w.id, w.playerId, Kind.Win, '5.00');
      await send(w.id, w.playerId, Kind.Refund, '10.00', bet.transaction.externalTransactionId);
      await send(w.id, w.playerId, Kind.Rollback, '5.00', win.transaction.externalTransactionId);
      expect(await eventsAfterOpening(w.id)).toEqual([
        PROCESSED, CHANGED, // bet
        PROCESSED, CHANGED, // win
        PROCESSED, CHANGED, // refund
        PROCESSED, CHANGED, // rollback
      ]);
    });

    it('a reversal waiting for its reference writes only PendingReference, once', async () => {
      const w = await open();
      const first = await send(w.id, w.playerId, Kind.Refund, '10.00', 'ext-not-here-yet');
      expect(first.transaction.status).toBe(WagerTransactionStatus.PendingReference);
      expect(await eventsAfterOpening(w.id)).toEqual(['WagerTransactionPendingReference']);
    });

    it('a replay writes nothing', async () => {
      const w = await open();
      const command: ProcessWagerTransactionCommand = {
        idempotencyKey: 'same-key',
        providerId: 'provider-1',
        externalTransactionId: 'same-ext',
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: Kind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
      };
      await process.execute(command);
      const before = await eventTypes(w.id);
      await Promise.all(Array.from({ length: 10 }, () => process.execute(command)));
      expect(await eventTypes(w.id)).toEqual(before);
    });
  });

  describe('consumer contract', () => {
    it('the balance changes of a wallet chain: versions rise by one and each balanceBefore is the previous balanceAfter', async () => {
      const w = await open('500.00');
      const bets: Promise<unknown>[] = [];
      for (let i = 0; i < 30; i++) {
        const kind = [Kind.Bet, Kind.Win, Kind.Loss, Kind.Bet][i % 4]!;
        const amount = i % 7 === 6 ? '900.00' : `${(i % 5) + 1}.00`; // a few bets that must be rejected
        bets.push(send(w.id, w.playerId, kind, amount));
      }
      await Promise.all(bets);

      const changes = await query<{ data: { walletVersion: number; balanceBefore: { amount: string }; balanceAfter: { amount: string } } }>(
        `select payload->'data' as data from outbox_messages where aggregate_id = ? and event_type = 'WalletBalanceChanged' order by sequence`,
        [w.id],
      );
      expect(changes.length).toBeGreaterThan(10);
      changes.forEach((change, i) => {
        expect(change.data.walletVersion).toBe(i + 1);
        if (i > 0) expect(change.data.balanceBefore.amount).toBe(changes[i - 1]!.data.balanceAfter.amount);
      });
      const [wallet] = await query<{ balance: string; version: number }>('select balance, version from wallets where id = ?', [w.id]);
      expect(changes.at(-1)!.data.balanceAfter.amount).toBe(wallet!.balance);
      expect(changes.at(-1)!.data.walletVersion).toBe(wallet!.version);
    });
  });
});
