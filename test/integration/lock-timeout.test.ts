import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { CreateWallet } from '../../src/application/wallet/create-wallet';
import { ProcessWagerTransaction } from '../../src/application/transaction/process-wager-transaction';
import { WalletLockTimeoutError } from '../../src/application/wallet/wallet-lock-timeout.error';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/transaction/wager-transaction';
import { MikroOrmWalletRepository } from '../../src/infrastructure/database/repositories/mikro-orm-wallet.repository';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/repositories/mikro-orm-unit-of-work';
import { CountingMetrics } from '../support/counting-metrics';
import { initTestOrm, truncateAll } from '../support/database';

const TIMEOUT_MS = 300;

// Decision #65: the total wait for a wallet lock is bounded. Past the limit the whole request rolls back and the provider
// resends it (503), instead of holding a connection indefinitely behind a hot wallet.
describe('wallet lock timeout (real PostgreSQL)', () => {
  let orm: MikroORM;
  let holder: MikroOrmUnitOfWork; // takes the lock and keeps it
  let bounded: MikroOrmUnitOfWork;
  let walletId: string;
  let playerId: string;
  const query = <T>(sql: string, params: unknown[] = []) => orm.em.getConnection().execute<T[]>(sql, params);

  beforeAll(async () => {
    orm = await initTestOrm();
    holder = new MikroOrmUnitOfWork(orm.em);
    bounded = new MikroOrmUnitOfWork(orm.em, TIMEOUT_MS);
  });
  afterAll(async () => {
    await truncateAll(orm);
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
    playerId = `lock-${crypto.randomUUID()}`;
    const wallet = await new CreateWallet({ unitOfWork: holder, now: () => new Date(), newId: () => crypto.randomUUID() }).execute({
      playerId,
      currency: 'BRL',
      initialAmount: '100.00',
    });
    walletId = wallet.id;
  });

  /** Locks the wallet in its own transaction until `release()` is called; resolves once the lock is held. */
  const holdLock = async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held!: () => void;
    const acquired = new Promise<void>((resolve) => {
      held = resolve;
    });
    const done = holder.run(async (repos) => {
      await repos.wallets.findByIdForUpdate(walletId);
      held();
      await gate;
    });
    await acquired;
    return { release, done };
  };

  const bet = (externalTransactionId = 'ext-1') => ({
    idempotencyKey: `provider:${externalTransactionId}`,
    providerId: 'provider',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'r',
    gameId: 'g',
    kind: WagerTransactionKind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
  });

  it('fails with WalletLockTimeoutError after about the limit, and succeeds once the lock is free', async () => {
    const lock = await holdLock();
    const started = Date.now();

    const error = await bounded.run((repos) => repos.wallets.findByIdForUpdate(walletId)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WalletLockTimeoutError);
    expect((error as WalletLockTimeoutError).walletId).toBe(walletId);
    expect(Date.now() - started).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS + 2_000);

    lock.release();
    await lock.done;
    expect(await bounded.run((repos) => repos.wallets.findByIdForUpdate(walletId))).toBeDefined();
  });

  it('bounds a queue of short holders too: no single wait is long, but the total is capped', async () => {
    // Each holder keeps the lock for 120 ms, well below the 300 ms limit. lock_timeout would never fire here, because every
    // wait step is one holder's turn; the total wait of the later requests is what the limit has to cap.
    const outcomes = await Promise.all(
      Array.from({ length: 9 }, () =>
        bounded
          .run(async (repos) => {
            await repos.wallets.findByIdForUpdate(walletId);
            await new Promise((resolve) => setTimeout(resolve, 120));
          })
          .then(() => 'locked' as const, (error: unknown) => error),
      ),
    );

    const timedOut = outcomes.filter((o) => o instanceof WalletLockTimeoutError);
    const locked = outcomes.filter((o) => o === 'locked');
    expect(locked.length).toBeGreaterThanOrEqual(1);
    expect(timedOut.length).toBeGreaterThanOrEqual(1);
    expect(locked.length + timedOut.length).toBe(9); // nothing failed in any other way
  });

  it('limits only the lock wait: the previous setting is back for the rest of the transaction', async () => {
    const after = await orm.em.transactional(async (tx) => {
      const repository = new MikroOrmWalletRepository(tx, TIMEOUT_MS);
      const setting = async () => (await tx.execute<{ statement_timeout: string }[]>('show statement_timeout'))[0]!.statement_timeout;
      await tx.execute(`select set_config('statement_timeout', '7000ms', true)`); // a setting that is not the default
      await repository.findByIdForUpdate(walletId);
      return setting();
    });

    expect(after).toBe('7s'); // put back to what it was before the lock, not to 0 and not left at the limit
  });

  it('a timed-out request persists nothing and the same key succeeds after the lock is released', async () => {
    const metrics = new CountingMetrics();
    const process = new ProcessWagerTransaction({ unitOfWork: bounded, now: () => new Date(), newId: () => crypto.randomUUID(), metrics });
    const lock = await holdLock();

    const error = await process.execute(bet()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WalletLockTimeoutError);
    expect(await query('select 1 from wager_transactions where external_transaction_id = ?', ['ext-1'])).toHaveLength(0);
    expect(metrics.lockWaits).toEqual(['timeout']);
    expect(metrics.processing).toEqual(['error']);

    lock.release();
    await lock.done;
    const result = await process.execute(bet());

    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(result.idempotentReplay).toBe(false);
    expect(metrics.lockWaits).toEqual(['timeout', 'acquired']);
    expect(await query('select 1 from wager_transactions where external_transaction_id = ?', ['ext-1'])).toHaveLength(1);
  });

  it('a wait shorter than the limit is not an error', async () => {
    const lock = await holdLock();
    const waiting = new ProcessWagerTransaction({ unitOfWork: new MikroOrmUnitOfWork(orm.em, 5_000), now: () => new Date(), newId: () => crypto.randomUUID() }).execute(bet());
    await new Promise((resolve) => setTimeout(resolve, 150));
    lock.release();

    expect((await waiting).transaction.status).toBe(WagerTransactionStatus.Processed);
    await lock.done;
  });
});

describe('wallet lock timeout over HTTP', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let baseUrl: string;
  let holder: MikroOrmUnitOfWork;
  const previous = process.env.WALLET_LOCK_TIMEOUT_MS;

  beforeAll(async () => {
    orm = await initTestOrm();
    await truncateAll(orm);
    holder = new MikroOrmUnitOfWork(orm.em);
    process.env.WALLET_LOCK_TIMEOUT_MS = String(TIMEOUT_MS);
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.listen(0);
    baseUrl = await app.getUrl();
  });
  afterAll(async () => {
    await app.close();
    if (previous === undefined) delete process.env.WALLET_LOCK_TIMEOUT_MS;
    else process.env.WALLET_LOCK_TIMEOUT_MS = previous;
    await truncateAll(orm);
    await orm.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('answers 503 with Retry-After while the wallet is locked, counts the timeout, and the resend succeeds', async () => {
    const playerId = `http-lock-${crypto.randomUUID()}`;
    const created = await post('/wallets', { playerId, initialBalance: { currency: 'BRL', amount: '100.00' } });
    const walletId = ((await created.json()) as { id: string }).id;
    const body = {
      providerId: 'provider-lock',
      externalTransactionId: 'ext-http-1',
      playerId,
      walletId,
      roundId: 'r',
      gameId: 'g',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held!: () => void;
    const acquired = new Promise<void>((resolve) => {
      held = resolve;
    });
    const holding = holder.run(async (repos) => {
      await repos.wallets.findByIdForUpdate(walletId);
      held();
      await gate;
    });
    await acquired;

    const blocked = await post('/wagering/transactions', body, { 'idempotency-key': 'k-http-1' });

    expect(blocked.status).toBe(503);
    expect(blocked.headers.get('retry-after')).toBe('1');
    expect(await blocked.json()).toMatchObject({ error: 'TRANSIENT_FAILURE' });
    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
    expect(metrics).toContain('wagering_wallet_lock_wait_seconds_count{outcome="timeout"} 1');

    release();
    await holding;
    const resent = await post('/wagering/transactions', body, { 'idempotency-key': 'k-http-1' });

    expect(resent.status).toBe(200);
    expect(await resent.json()).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
  }, 30_000);
});
