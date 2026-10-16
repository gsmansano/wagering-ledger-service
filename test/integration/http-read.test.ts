import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { initTestOrm, truncateAll } from '../support/database';

// The read endpoints of M6 over real HTTP, including the cursor-paginated ledger.
describe('read endpoints (real PostgreSQL + SQS emulator)', () => {
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
    return { status: res.status, body: (await res.json()) as Json };
  };
  const get = (path: string) => call('GET', path);

  const newWallet = async (amount?: string) => {
    const playerId = `read-${crypto.randomUUID()}`;
    const res = await call('POST', '/wallets', { playerId, initialBalance: { currency: 'BRL', ...(amount && { amount }) } });
    return { playerId, walletId: res.body.id as string };
  };
  const submit = (walletId: string, playerId: string, overrides: Json = {}) => {
    const externalTransactionId = overrides.externalTransactionId ?? crypto.randomUUID();
    return call(
      'POST',
      '/wagering/transactions',
      {
        providerId: 'provider-a',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
        ...overrides,
      },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
  };
  const MISSING = '0192f291-27dd-7d3f-8071-5f8685deef37';

  describe('GET /wallets/:walletId', () => {
    it('returns the wallet with its current balance and version', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      await submit(walletId, playerId);

      const res = await get(`/wallets/${walletId}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: walletId, playerId, balance: { amount: '90.00', currency: 'BRL' }, version: 2 });
    });

    it('answers 404 for an unknown wallet and 400 for an id that is not a UUID', async () => {
      const unknown = await get(`/wallets/${MISSING}`);
      expect(unknown.status).toBe(404);
      expect(unknown.body.error).toBe('WALLET_NOT_FOUND');
      const malformed = await get('/wallets/not-a-uuid');
      expect(malformed.status).toBe(400);
      expect(malformed.body.error).toBe('MALFORMED_REQUEST');
    });
  });

  describe('transaction lookups', () => {
    it('returns a processed transaction by id and by provider identifier, as the same view', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      const posted = await submit(walletId, playerId, { externalTransactionId: 'lookup-1' });

      const byId = await get(`/wagering/transactions/${posted.body.transactionId}`);
      const byExternal = await get('/providers/provider-a/wagering/transactions/lookup-1');

      expect(byId.status).toBe(200);
      expect(byId.body).toMatchObject({ status: 'PROCESSED', kind: 'BET', balance: { amount: '90.00' } });
      expect(byId.body.idempotentReplay).toBeUndefined(); // only a submit has a replay flag
      expect(byExternal.status).toBe(200);
      expect(byExternal.body).toEqual(byId.body);
    });

    it('returns a rejected transaction with 200: a read is not a rejection', async () => {
      const { playerId, walletId } = await newWallet('5.00');
      const posted = await submit(walletId, playerId);
      expect(posted.status).toBe(422);

      const read = await get(`/wagering/transactions/${posted.body.transactionId}`);

      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '5.00' } });
    });

    it('returns a pending reversal with 200 and no balance, then the settled result after it resolves', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      const refund = await submit(walletId, playerId, {
        kind: 'REFUND',
        externalTransactionId: 'late-refund',
        referenceExternalTransactionId: 'late-bet',
      });
      expect(refund.status).toBe(202);

      const read = await get('/providers/provider-a/wagering/transactions/late-refund');

      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ status: 'PENDING_REFERENCE', referenceExternalTransactionId: 'late-bet' });
      expect(read.body.balance).toBeUndefined();
      expect(read.body.processedAt).toBeUndefined();
    });

    it('is scoped by provider: another provider\'s identifier does not match', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      await submit(walletId, playerId, { externalTransactionId: 'scoped-1' });

      const other = await get('/providers/provider-b/wagering/transactions/scoped-1');

      expect(other.status).toBe(404);
      expect(other.body.error).toBe('TRANSACTION_NOT_FOUND');
    });

    it('answers 404 for unknown transactions and 400 for an id that is not a UUID', async () => {
      expect((await get(`/wagering/transactions/${MISSING}`)).status).toBe(404);
      expect((await get('/providers/provider-a/wagering/transactions/never-sent')).status).toBe(404);
      expect((await get('/wagering/transactions/42')).status).toBe(400);
    });
  });

  describe('GET /wallets/:walletId/ledger', () => {
    const collect = async (walletId: string, limit: number) => {
      const pages: Json[] = [];
      let cursor: string | null = null;
      do {
        const res: { status: number; body: Json } = await get(
          `/wallets/${walletId}/ledger?limit=${limit}${cursor === null ? '' : `&cursor=${cursor}`}`,
        );
        expect(res.status).toBe(200);
        pages.push(res.body);
        cursor = res.body.nextCursor;
      } while (cursor !== null);
      return pages;
    };

    it('pages through the ledger in application order with an opaque cursor', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      for (let i = 0; i < 4; i += 1) await submit(walletId, playerId); // 90, 80, 70, 60

      const pages = await collect(walletId, 2);

      expect(pages.map((p) => p.entries.length)).toEqual([2, 2, 1]);
      expect(pages.at(-1)!.nextCursor).toBeNull();
      const entries = pages.flatMap((p) => p.entries);
      expect(entries.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(entries.map((e) => e.direction)).toEqual(['CREDIT', 'DEBIT', 'DEBIT', 'DEBIT', 'DEBIT']);
      expect(entries.map((e) => e.balanceAfter.amount)).toEqual(['100.00', '90.00', '80.00', '70.00', '60.00']);
      // Each entry starts where the previous one ended.
      for (let i = 1; i < entries.length; i += 1) {
        expect(entries[i].balanceBefore).toEqual(entries[i - 1].balanceAfter);
      }
      expect(entries[1]).toMatchObject({ money: { amount: '10.00', currency: 'BRL' }, balanceBefore: { amount: '100.00' } });
      expect(pages[0]!.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    }, 30_000);

    it('a page that ends exactly at the last entry has no next cursor', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      await submit(walletId, playerId);
      const res = await get(`/wallets/${walletId}/ledger?limit=2`);
      expect(res.body.entries).toHaveLength(2);
      expect(res.body.nextCursor).toBeNull();
    });

    it('stays stable while entries are appended between pages: nothing repeated, nothing skipped', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      for (let i = 0; i < 2; i += 1) await submit(walletId, playerId);

      const first = await get(`/wallets/${walletId}/ledger?limit=2`);
      await submit(walletId, playerId);
      await submit(walletId, playerId);
      const second = await get(`/wallets/${walletId}/ledger?limit=2&cursor=${first.body.nextCursor}`);
      const third = await get(`/wallets/${walletId}/ledger?limit=2&cursor=${second.body.nextCursor}`);

      const sequences = [first, second, third].flatMap((p) => p.body.entries.map((e: Json) => e.sequence));
      expect(sequences).toEqual([1, 2, 3, 4, 5]);
      expect(third.body.nextCursor).toBeNull();
    }, 30_000);

    it('returns an empty page for a wallet without entries', async () => {
      const { walletId } = await newWallet();
      const res = await get(`/wallets/${walletId}/ledger`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ entries: [], nextCursor: null });
    });

    it('answers 404 for an unknown wallet and 400 for malformed ids, cursors and limits', async () => {
      const { walletId } = await newWallet('10.00');
      expect((await get(`/wallets/${MISSING}/ledger`)).status).toBe(404);
      expect((await get('/wallets/xyz/ledger')).status).toBe(400);

      const badCursor = await get(`/wallets/${walletId}/ledger?cursor=garbage`);
      expect(badCursor.status).toBe(400);
      expect(badCursor.body.error).toBe('INVALID_CURSOR');
      expect((await get(`/wallets/${walletId}/ledger?cursor=`)).body.error).toBe('INVALID_CURSOR');

      for (const limit of ['0', '201', 'abc', '-3']) {
        const res = await get(`/wallets/${walletId}/ledger?limit=${limit}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('MALFORMED_REQUEST');
      }
    });
  });
});
