import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { Logger, type INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { ReadinessService } from '../../src/infrastructure/readiness.service';
import { initTestOrm, truncateAll } from '../support/database';
import { WAGER_QUEUE } from '../../src/infrastructure/messaging/queue-names';

// Reconciliation and health checks over real HTTP, PostgreSQL and the SQS emulator.
describe('reconciliation and readiness (real PostgreSQL + SQS emulator)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let baseUrl: string;

  beforeAll(async () => {
    orm = await initTestOrm();
    await truncateAll(orm);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
    await truncateAll(orm);
    await orm.close();
  });

  type Json = Record<string, any>; // test-only: responses are asserted field by field
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Json, headers: res.headers };
  };
  const query = <T>(sql: string, params: unknown[] = []) => orm.em.getConnection().execute<T[]>(sql, params);

  const newWallet = async (amount?: string) => {
    const playerId = `ops-${crypto.randomUUID()}`;
    const res = await call('POST', '/wallets', { playerId, initialBalance: { currency: 'BRL', ...(amount && { amount }) } });
    return { playerId, walletId: res.body.id as string };
  };
  const bet = (walletId: string, playerId: string, amount = '10.00') =>
    call(
      'POST',
      '/wagering/transactions',
      {
        providerId: 'provider-a',
        externalTransactionId: crypto.randomUUID(),
        playerId,
        walletId,
        roundId: 'r',
        gameId: 'g',
        kind: 'BET',
        money: { amount, currency: 'BRL' },
      },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
  const balanceOf = async (walletId: string) =>
    (await query<{ balance: string }>('select balance from wallets where id = ?', [walletId]))[0]!.balance;

  describe('POST /wallets/:walletId/reconciliation', () => {
    it('reports a consistent wallet in the specified shape', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      await bet(walletId, playerId, '30.00');
      await bet(walletId, playerId, '12.50');

      const res = await call('POST', `/wallets/${walletId}/reconciliation`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        walletId,
        storedBalance: { amount: '57.50', currency: 'BRL' },
        calculatedBalance: { amount: '57.50', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 3,
      });
    }, 30_000);

    it('an empty wallet is consistent with zero entries', async () => {
      const { walletId } = await newWallet();
      const res = await call('POST', `/wallets/${walletId}/reconciliation`);
      expect(res.body).toMatchObject({
        storedBalance: { amount: '0.00' },
        calculatedBalance: { amount: '0.00' },
        difference: { amount: '0.00' },
        consistent: true,
        checkedEntries: 0,
      });
    });

    it('flags a divergence, logs it and corrects nothing', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      await bet(walletId, playerId, '30.00'); // balance 70.00
      await query('update wallets set balance = balance + 5.00 where id = ?', [walletId]); // tampered: 75.00
      const logged = spyOn(Logger.prototype, 'error').mockImplementation(() => {});

      const res = await call('POST', `/wallets/${walletId}/reconciliation`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        storedBalance: { amount: '75.00' },
        calculatedBalance: { amount: '70.00' },
        difference: { amount: '5.00' },
        consistent: false,
        checkedEntries: 2,
      });
      expect(await balanceOf(walletId)).toBe('75.00'); // not fixed
      expect(await query('select 1 from ledger_entries where wallet_id = ?', [walletId])).toHaveLength(2);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]![0]).toEqual({ event: 'reconciliation_divergence', walletId });
      logged.mockRestore();
    }, 30_000);

    it('reports a negative difference when the stored balance is below the ledger', async () => {
      const { walletId } = await newWallet('100.00');
      await query('update wallets set balance = balance - 20.00 where id = ?', [walletId]);
      const logged = spyOn(Logger.prototype, 'error').mockImplementation(() => {});

      const res = await call('POST', `/wallets/${walletId}/reconciliation`);

      expect(res.body).toMatchObject({ difference: { amount: '-20.00' }, consistent: false });
      logged.mockRestore();
    });

    it('stays consistent while bets are being applied to the same wallet (one snapshot, no false divergence)', async () => {
      const { playerId, walletId } = await newWallet('1000.00');
      const bets = Array.from({ length: 10 }, () => bet(walletId, playerId, '1.00'));
      const checks = Array.from({ length: 10 }, () => call('POST', `/wallets/${walletId}/reconciliation`));

      const results = await Promise.all([...bets, ...checks]);

      for (const check of results.slice(10)) {
        expect(check.status).toBe(200);
        expect(check.body.consistent).toBe(true);
      }
      expect(await balanceOf(walletId)).toBe('990.00');
    }, 60_000);

    it('answers 404 for an unknown wallet and 400 for an id that is not a UUID', async () => {
      expect((await call('POST', '/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/reconciliation')).status).toBe(404);
      expect((await call('POST', '/wallets/xyz/reconciliation')).status).toBe(400);
    });
  });

  describe('health checks', () => {
    it('liveness and readiness answer 200 without credentials when PostgreSQL and SQS are reachable', async () => {
      const live = await call('GET', '/health/live');
      expect(live.status).toBe(200);
      expect(live.body).toEqual({ status: 'ok' });

      const ready = await call('GET', '/health/ready');
      expect(ready.status).toBe(200);
      expect(ready.body).toEqual({ status: 'ready', checks: { postgres: 'up', sqs: 'up' } });
    });

    it('readiness sees an unreachable SQS endpoint as down while PostgreSQL stays up', async () => {
      const deadSqs = new SQSClient({
        endpoint: 'http://127.0.0.1:1',
        region: 'us-east-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        maxAttempts: 1,
      });
      const readiness = new ReadinessService(
        {
          pingPostgres: () => orm.em.getConnection().execute('select 1'),
          pingSqs: (signal) => deadSqs.send(new GetQueueUrlCommand({ QueueName: WAGER_QUEUE }), { abortSignal: signal }),
        },
        1_000,
      );

      expect(await readiness.check()).toEqual({ ready: false, checks: { postgres: 'up', sqs: 'down' } });
    });

    it('answers 503 naming the failing dependency, while liveness stays 200', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ReadinessService)
        .useValue(
          new ReadinessService({
            pingPostgres: () => Promise.reject(new Error('connection refused to 10.0.0.1')),
            pingSqs: () => Promise.resolve(),
          }),
        )
        .compile();
      const degraded = moduleRef.createNestApplication();
      await degraded.listen(0);
      try {
        const url = await degraded.getUrl();
        const ready = await fetch(`${url}/health/ready`);
        expect(ready.status).toBe(503);
        const text = await ready.text();
        expect(JSON.parse(text)).toEqual({ status: 'unavailable', checks: { postgres: 'down', sqs: 'up' } });
        expect(text).not.toContain('10.0.0.1'); // the cause goes to the log, not to the caller
        expect((await fetch(`${url}/health/live`)).status).toBe(200);
      } finally {
        await degraded.close();
      }
    });
  });
});
