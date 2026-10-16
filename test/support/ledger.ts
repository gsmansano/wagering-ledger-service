import type { MikroORM } from '@mikro-orm/postgresql';
import { expect } from 'bun:test';

/**
 * The core invariant of the ledger (§6.4): a wallet's balance equals the sum of its entries, and every
 * PROCESSED transaction that moves money has exactly one entry. Meant to be called at the end of every test
 * that changes balances.
 */
export async function assertLedgerMatchesBalance(orm: MikroORM, walletId: string): Promise<void> {
  const db = orm.em.getConnection();
  const [wallet] = await db.execute<{ balance: string; net: string; entries: string }[]>(
    `select w.balance,
            coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0) as net,
            count(e.id) as entries
       from wallets w left join ledger_entries e on e.wallet_id = w.id
      where w.id = ? group by w.id`,
    [walletId],
  );
  expect(wallet).toBeDefined();
  expect(Number(wallet!.net).toFixed(2)).toBe(Number(wallet!.balance).toFixed(2));

  const [moving] = await db.execute<{ n: string }[]>(
    `select count(*) as n from wager_transactions
      where wallet_id = ? and status = 'PROCESSED' and kind <> 'LOSS'`,
    [walletId],
  );
  expect(Number(wallet!.entries)).toBe(Number(moving!.n));
}
