import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { IdempotencyConflictError } from '../../src/application/transaction/idempotency-conflict.error';
import { InboxPayloadConflictError } from '../../src/application/transaction/inbox-payload-conflict.error';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
  type ProcessWagerTransactionResult,
} from '../../src/application/transaction/process-wager-transaction';
import { CreateWallet } from '../../src/application/wallet/create-wallet';
import { WalletNotFoundError } from '../../src/application/wallet/wallet-not-found.error';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/transaction/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/repositories/mikro-orm-unit-of-work';
import { initTestOrm, truncateAll } from '../support/database';
import { assertLedgerMatchesBalance } from '../support/ledger';

const CONSUMER = 'wager-transactions-consumer';

describe('ProcessWagerTransaction from a queue message: inbox (real PostgreSQL)', () => {
  let orm: MikroORM;
  let uow: MikroOrmUnitOfWork;
  let process: ProcessWagerTransaction;
  let walletId: string;

  const deps = () => ({ unitOfWork: uow, now: () => new Date(), newId: () => crypto.randomUUID() });
  const query = <T>(sql: string, params: unknown[] = []) => orm.em.getConnection().execute<T[]>(sql, params);
  const count = async (table: string) => Number((await query<{ n: string }>(`select count(*) as n from ${table}`))[0]!.n);
  const balanceOf = async () => (await query<{ balance: string }>('select balance from wallets where id = ?', [walletId]))[0]!.balance;
  const bet = (overrides: Partial<ProcessWagerTransactionCommand> = {}): ProcessWagerTransactionCommand => ({
    idempotencyKey: 'key-1',
    providerId: 'provider-1',
    externalTransactionId: 'ext-1',
    playerId: 'player-1',
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '30.00', currency: 'BRL' },
    ...overrides,
  });
  const asResult = (value: unknown) => value as ProcessWagerTransactionResult;

  beforeAll(async () => {
    orm = await initTestOrm();
    uow = new MikroOrmUnitOfWork(orm.em);
    process = new ProcessWagerTransaction(deps());
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
    walletId = (await new CreateWallet(deps()).execute({ playerId: 'player-1', currency: 'BRL', initialAmount: '100.00' })).id;
  });

  it('records the message as processed together with the business change', async () => {
    const result = asResult(await process.execute(bet(), { consumerName: CONSUMER, messageId: 'msg-1' }));

    expect(result.idempotentReplay).toBe(false);
    expect(await balanceOf()).toBe('70.00');
    const rows = await query<{ consumer_name: string; message_id: string; processed_at: Date | null }>(
      'select consumer_name, message_id, processed_at from inbox_messages',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ consumer_name: CONSUMER, message_id: 'msg-1' });
    expect(rows[0]!.processed_at).not.toBeNull();
    await assertLedgerMatchesBalance(orm, walletId);
  });

  it('a redelivered message id is reported as a duplicate and writes nothing', async () => {
    await process.execute(bet(), { consumerName: CONSUMER, messageId: 'msg-1' });
    const ledgerBefore = await count('ledger_entries');
    const outboxBefore = await count('outbox_messages');

    const again = await process.execute(bet(), { consumerName: CONSUMER, messageId: 'msg-1' });

    expect(again).toEqual({ duplicateMessage: true });
    expect(await balanceOf()).toBe('70.00');
    expect(await count('inbox_messages')).toBe(1);
    expect(await count('ledger_entries')).toBe(ledgerBefore);
    expect(await count('outbox_messages')).toBe(outboxBefore);
  });

  it('the same message id with a different payload is a conflict, not a duplicate', async () => {
    await process.execute(bet(), { consumerName: CONSUMER, messageId: 'msg-1' });
    const other = bet({ money: { amount: '31.00', currency: 'BRL' } });

    await expect(process.execute(other, { consumerName: CONSUMER, messageId: 'msg-1' })).rejects.toBeInstanceOf(
      InboxPayloadConflictError,
    );
    expect(await balanceOf()).toBe('70.00');
  });

  it('the same message id under another consumer is a separate message', async () => {
    await process.execute(bet(), { consumerName: CONSUMER, messageId: 'msg-1' });
    const second = asResult(
      await process.execute(bet({ idempotencyKey: 'key-2', externalTransactionId: 'ext-2' }), {
        consumerName: 'other-consumer',
        messageId: 'msg-1',
      }),
    );

    expect(second.idempotentReplay).toBe(false);
    expect(await count('inbox_messages')).toBe(2);
    expect(await balanceOf()).toBe('40.00');
  });

  it('a new message id for an already settled transaction is a replay, and is still recorded', async () => {
    await process.execute(bet(), { consumerName: CONSUMER, messageId: 'msg-1' });
    const replay = asResult(await process.execute(bet(), { consumerName: CONSUMER, messageId: 'msg-2' }));

    expect(replay.idempotentReplay).toBe(true);
    expect(await balanceOf()).toBe('70.00');
    expect(await count('inbox_messages')).toBe(2);
    expect(await count('ledger_entries')).toBe(2); // opening credit + one debit
  });

  it('a business rejection is a result: the inbox row commits with it', async () => {
    const result = asResult(
      await process.execute(bet({ money: { amount: '500.00', currency: 'BRL' } }), { consumerName: CONSUMER, messageId: 'msg-1' }),
    );

    expect(result.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(await count('inbox_messages')).toBe(1);
    expect(await balanceOf()).toBe('100.00');
  });

  it('an error rolls the inbox row back, so the redelivery is processed normally', async () => {
    await expect(
      process.execute(bet({ walletId: crypto.randomUUID() }), { consumerName: CONSUMER, messageId: 'msg-1' }),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(await count('inbox_messages')).toBe(0);

    const result = asResult(await process.execute(bet(), { consumerName: CONSUMER, messageId: 'msg-1' }));
    expect(result.idempotentReplay).toBe(false);
    expect(await count('inbox_messages')).toBe(1);
  });

  it('an idempotency conflict rolls the inbox row back too', async () => {
    await process.execute(bet(), { consumerName: CONSUMER, messageId: 'msg-1' });
    const conflicting = bet({ money: { amount: '5.00', currency: 'BRL' } });

    await expect(process.execute(conflicting, { consumerName: CONSUMER, messageId: 'msg-2' })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(await count('inbox_messages')).toBe(1);
  });

  it('20 concurrent deliveries of one message give one effect and 19 duplicates', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => process.execute(bet(), { consumerName: CONSUMER, messageId: 'msg-1' })),
    );

    expect(results.filter((r) => 'duplicateMessage' in r)).toHaveLength(19);
    expect(await balanceOf()).toBe('70.00');
    expect(await count('inbox_messages')).toBe(1);
    await assertLedgerMatchesBalance(orm, walletId);
  });

  it('without an inbox context nothing is recorded (HTTP path)', async () => {
    await process.execute(bet());
    expect(await count('inbox_messages')).toBe(0);
  });
});
