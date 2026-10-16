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

    it('answers 400 for a malformed body and 422 for an invalid amount', async () => {
      expect((await post('/wallets', { playerId: 'x' })).status).toBe(400);
      expect((await post('/wallets', { initialBalance: { currency: 'BRL' } })).status).toBe(400);
      const negative = await post('/wallets', { playerId: 'x', initialBalance: { currency: 'BRL', amount: '-1.00' } });
      expect(negative.status).toBe(422);
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

    it('reports a business rejection in the body with its failure code', async () => {
      const { playerId, walletId } = await newWallet('10.00');
      const res = await post('/wagering/transactions', transaction(walletId, playerId), { 'Idempotency-Key': crypto.randomUUID() });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
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

    it('answers 404 for an unknown wallet', async () => {
      const res = await post('/wagering/transactions', transaction(crypto.randomUUID(), 'nobody'), { 'Idempotency-Key': crypto.randomUUID() });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('WALLET_NOT_FOUND');
    });

    it('answers 422 for OPENING, a wrong player, an invalid amount and a kind not supported yet', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      const key = () => ({ 'Idempotency-Key': crypto.randomUUID() });
      expect((await post('/wagering/transactions', transaction(walletId, playerId, { kind: 'OPENING' }), key())).status).toBe(422);
      expect((await post('/wagering/transactions', transaction(walletId, 'someone-else'), key())).status).toBe(422);
      expect(
        (await post('/wagering/transactions', transaction(walletId, playerId, { money: { amount: '1.234', currency: 'BRL' } }), key())).status,
      ).toBe(422);
      const refund = await post(
        '/wagering/transactions',
        transaction(walletId, playerId, { kind: 'REFUND', referenceExternalTransactionId: 'ext-x' }),
        key(),
      );
      expect(refund.status).toBe(422);
      expect(refund.body.error).toBe('UNSUPPORTED_KIND');
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
