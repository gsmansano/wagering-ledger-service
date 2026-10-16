import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { initTestOrm, truncateAll } from '../support/database';

// The two minimal endpoints of M4 over real HTTP. The full API and its status table arrive in M6.
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('wagering over HTTP (real PostgreSQL + SQS emulator)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let baseUrl: string;

  beforeAll(async () => {
    // These tests create rows through the app; start from, and leave behind, an empty database.
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

  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> }; // test-only: the shape is asserted field by field
  };

  const newWallet = async (amount?: string) => {
    const playerId = `http-${crypto.randomUUID()}`;
    const res = await post('/wallets', { playerId, initialBalance: { currency: 'BRL', ...(amount && { amount }) } });
    return { playerId, walletId: res.body.id as string, res };
  };

  const transaction = (walletId: string, playerId: string, overrides: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    return {
      providerId: 'provider-a',
      externalTransactionId: id,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...overrides,
    };
  };

  describe('POST /wallets', () => {
    it('creates a wallet with an opening balance (201)', async () => {
      const { res, playerId } = await newWallet('1000.00');
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
      expect(res.body.id).toMatch(UUID_V7); // ids are time-ordered UUID v7, as in the specification's examples
    });

    it('creates an empty wallet when the amount is omitted or zero', async () => {
      expect((await newWallet()).res.body.balance).toEqual({ amount: '0.00', currency: 'BRL' });
      expect((await newWallet('0.00')).res.body.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    });

    it('answers 409 WALLET_ALREADY_EXISTS for the same player and currency', async () => {
      const { playerId } = await newWallet('10.00');
      const again = await post('/wallets', { playerId, initialBalance: { currency: 'BRL', amount: '10.00' } });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('WALLET_ALREADY_EXISTS');
    });

    it('answers 400 MALFORMED_REQUEST for a malformed body and 400 INVALID_PAYLOAD for an invalid amount', async () => {
      expect((await post('/wallets', { playerId: 'x' })).status).toBe(400);
      expect((await post('/wallets', { initialBalance: { currency: 'BRL' } })).status).toBe(400);
      const negative = await post('/wallets', { playerId: 'x', initialBalance: { currency: 'BRL', amount: '-1.00' } });
      expect(negative.status).toBe(400);
      expect(negative.body.error).toBe('INVALID_PAYLOAD');
    });
  });

  describe('POST /wagering/transactions', () => {
    it('processes a BET (200), replays a duplicate and reports the original balance', async () => {
      const { playerId, walletId } = await newWallet('1000.00');
      const body = transaction(walletId, playerId);
      const headers = { 'Idempotency-Key': `provider-a:${body.externalTransactionId}` };

      const first = await post('/wagering/transactions', body, headers);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });
      expect(first.body.transactionId).toMatch(UUID_V7);

      await post('/wagering/transactions', transaction(walletId, playerId, { money: { amount: '5.00', currency: 'BRL' } }), {
        'Idempotency-Key': 'other-bet-' + crypto.randomUUID(),
      });
      const replay = await post('/wagering/transactions', body, headers);
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({
        transactionId: first.body.transactionId,
        status: 'PROCESSED',
        balance: { amount: '975.00', currency: 'BRL' },
        idempotentReplay: true,
      });
    });

    it('answers 422 for a business rejection, with the failure code, and again for its replay', async () => {
      const { playerId, walletId } = await newWallet('10.00');
      const body = transaction(walletId, playerId);
      const headers = { 'Idempotency-Key': crypto.randomUUID() };

      const res = await post('/wagering/transactions', body, headers);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: { amount: '10.00', currency: 'BRL' },
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        idempotentReplay: false,
      });

      const replay = await post('/wagering/transactions', body, headers);
      expect(replay.status).toBe(422);
      expect(replay.body).toMatchObject({ transactionId: res.body.transactionId, failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: true });
    });

    it('returns the same transaction view on every status: ids, kind, money and timestamps', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      const res = await post('/wagering/transactions', transaction(walletId, playerId, { externalTransactionId: 'view-1' }), {
        'Idempotency-Key': crypto.randomUUID(),
      });
      expect(res.body).toMatchObject({ providerId: 'provider-a', externalTransactionId: 'view-1', walletId, status: 'PROCESSED' });
      expect(new Date(res.body.createdAt).toISOString()).toBe(res.body.createdAt);
      expect(new Date(res.body.processedAt).toISOString()).toBe(res.body.processedAt);
    });

    it('uses a valid X-Correlation-Id as the correlation id of the events, and ignores an invalid one', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      const correlationOf = async (externalId: string) =>
        (await orm.em.getConnection().execute<{ payload: { correlationId: string } }[]>(
          `select o.payload from outbox_messages o
             join wager_transactions t on o.payload->'data'->>'transactionId' = t.id::text
            where t.external_transaction_id = ? and o.event_type = 'WagerTransactionProcessed'`,
          [externalId],
        ))[0]!;

      await post('/wagering/transactions', transaction(walletId, playerId, { externalTransactionId: 'corr-ok' }), {
        'Idempotency-Key': crypto.randomUUID(),
        'X-Correlation-Id': 'trace-abc.123',
      });
      await post('/wagering/transactions', transaction(walletId, playerId, { externalTransactionId: 'corr-bad' }), {
        'Idempotency-Key': crypto.randomUUID(),
        'X-Correlation-Id': 'has spaces and <markup>',
      });

      expect((await correlationOf('corr-ok')).payload.correlationId).toBe('trace-abc.123');
      expect((await correlationOf('corr-bad')).payload.correlationId).toMatch(UUID_V7);
    });

    it('answers 409 IDEMPOTENCY_CONFLICT for the same key with another payload', async () => {
      const { playerId, walletId } = await newWallet('1000.00');
      const body = transaction(walletId, playerId);
      const headers = { 'Idempotency-Key': crypto.randomUUID() };
      await post('/wagering/transactions', body, headers);

      const conflict = await post('/wagering/transactions', { ...body, money: { amount: '26.00', currency: 'BRL' } }, headers);
      expect(conflict.status).toBe(409);
      expect(conflict.body.error).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('answers 400 without the Idempotency-Key header or with a malformed body', async () => {
      const { playerId, walletId } = await newWallet('10.00');
      expect((await post('/wagering/transactions', transaction(walletId, playerId))).status).toBe(400);
      const headers = { 'Idempotency-Key': crypto.randomUUID() };
      expect((await post('/wagering/transactions', { ...transaction(walletId, playerId), kind: 'DONATION' }, headers)).status).toBe(400);
      expect((await post('/wagering/transactions', { ...transaction(walletId, playerId), money: '25.00' }, headers)).status).toBe(400);
    });

    it('answers 400 MALFORMED_REQUEST when walletId is not a UUID, instead of failing in the database', async () => {
      const res = await post('/wagering/transactions', transaction('not-a-uuid', 'someone'), { 'Idempotency-Key': crypto.randomUUID() });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'MALFORMED_REQUEST', message: 'walletId must be a UUID' });
    });

    it('answers 404 for an unknown wallet', async () => {
      const res = await post('/wagering/transactions', transaction(crypto.randomUUID(), 'nobody'), { 'Idempotency-Key': crypto.randomUUID() });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('WALLET_NOT_FOUND');
    });

    it('answers 400 INVALID_PAYLOAD for OPENING, a wrong player and an invalid amount', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      const key = () => ({ 'Idempotency-Key': crypto.randomUUID() });
      expect((await post('/wagering/transactions', transaction(walletId, playerId, { kind: 'OPENING' }), key())).status).toBe(400);
      expect((await post('/wagering/transactions', transaction(walletId, 'someone-else'), key())).status).toBe(400);
      expect(
        (await post('/wagering/transactions', transaction(walletId, playerId, { money: { amount: '1.234', currency: 'BRL' } }), key())).status,
      ).toBe(400);
    });

    it('answers 202 PENDING_REFERENCE for a reversal whose reference has not arrived, and a replay stays 202 until the worker retries it', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      const key = () => ({ 'Idempotency-Key': crypto.randomUUID() });
      const refundKey = crypto.randomUUID();
      const refund = transaction(walletId, playerId, {
        kind: 'REFUND',
        externalTransactionId: 'ext-refund',
        referenceExternalTransactionId: 'ext-late-bet',
      });

      const pending = await post('/wagering/transactions', refund, { 'Idempotency-Key': refundKey });
      expect(pending.status).toBe(202);
      expect(pending.body.status).toBe('PENDING_REFERENCE');
      expect(pending.body.balance).toBeUndefined();

      const bet = await post('/wagering/transactions', transaction(walletId, playerId, { externalTransactionId: 'ext-late-bet' }), key());
      expect(bet.status).toBe(200);
      const again = await post('/wagering/transactions', refund, { 'Idempotency-Key': refundKey });
      expect(again.status).toBe(202); // still parked until the worker retries it
      expect(again.body.idempotentReplay).toBe(true);
    });

    it('50 parallel identical requests debit once', async () => {
      const { playerId, walletId } = await newWallet('1000.00');
      const body = transaction(walletId, playerId);
      const headers = { 'Idempotency-Key': crypto.randomUUID() };

      const responses = await Promise.all(Array.from({ length: 50 }, () => post('/wagering/transactions', body, headers)));

      expect(responses.every((r) => r.status === 200 && r.body.balance.amount === '975.00')).toBe(true);
      expect(responses.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    });
  });
});
