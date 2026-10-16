import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransaction } from '../../src/application/transaction/process-wager-transaction';
import { CreateWallet } from '../../src/application/wallet/create-wallet';
import { WagerTransactionKind } from '../../src/domain/transaction/wager-transaction';
import type { WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/repositories/mikro-orm-unit-of-work';
import { initTestOrm, truncateAll } from '../support/database';

// A wallet statement must list entries in the order they were applied: the ledger is the audit trail of that
// order (concurrent requests on one wallet are applied in lock order, and the outcome depends on it).
describe('ledger statement order (real PostgreSQL)', () => {
  let orm: MikroORM;
  let uow: MikroOrmUnitOfWork;

  beforeAll(async () => {
    orm = await initTestOrm();
    uow = new MikroOrmUnitOfWork(orm.em);
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
  });

  it('lists entries in application order even when every entry carries the same timestamp', async () => {
    // A frozen clock makes every created_at identical, and random v4 ids make the id tie-break arbitrary.
    const frozen = new Date('2026-10-16T12:00:00.000Z');
    const deps = { unitOfWork: uow, now: () => frozen, newId: () => crypto.randomUUID() };
    const wallet = await new CreateWallet(deps).execute({ playerId: 'p1', currency: 'BRL', initialAmount: '1000.00' });
    const process = new ProcessWagerTransaction(deps);
    for (let i = 0; i < 12; i++) {
      await process.execute({
        idempotencyKey: `key-${i}`,
        providerId: 'provider-1',
        externalTransactionId: `ext-${i}`,
        playerId: 'p1',
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
      });
    }

    // Read the whole statement through the paginated API, three entries at a time.
    const statement: WalletLedgerEntry[] = [];
    const sequences: number[] = [];
    let afterSequence: number | undefined;
    for (;;) {
      const page = await uow.run((r) => r.ledger.page(wallet.id, { afterSequence, limit: 3 }));
      if (page.length === 0) break;
      statement.push(...page.map((record) => record.entry));
      sequences.push(...page.map((record) => record.sequence));
      afterSequence = page[page.length - 1]!.sequence;
    }

    expect(statement).toHaveLength(13); // the opening credit and 12 bets
    expect(sequences).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect(statement[0]!.balanceBefore.toJSON().amount).toBe('0.00');
    for (let i = 1; i < statement.length; i++) {
      // Each entry starts where the previous one ended: that is the order they were applied in.
      expect(statement[i]!.balanceBefore.toJSON().amount).toBe(statement[i - 1]!.balanceAfter.toJSON().amount);
    }
  });
});
