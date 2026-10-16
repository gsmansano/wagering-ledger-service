import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { initTestOrm, truncateAll } from '../support/database';

// Contract sweep: every endpoint is called once per status it can answer (decision #43), all in one place, so the
// whole table can be read at a glance. The detailed behaviour of each endpoint is tested in its own file.
describe('HTTP contract: every endpoint, every status class (real PostgreSQL + SQS emulator)', () => {
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

  const MISSING = '00000000-0000-4000-8000-000000000000';
  const submission = (walletId: string, playerId: string, overrides: Record<string, unknown> = {}) => ({
    providerId: 'provider-contract',
    externalTransactionId: crypto.randomUUID(),
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  });
  const submit = (body: unknown, key: string | null = crypto.randomUUID()) =>
    call('POST', '/wagering/transactions', body, key === null ? {} : { 'Idempotency-Key': key });

  // One shared fixture: a funded wallet with a processed BET, a rejected BET and a parked REFUND.
  let playerId: string;
  let walletId: string;
  let processed: Json;
  let rejected: Json;
  let pending: Json;
  let processedExternalId: string;

  beforeAll(async () => {
    playerId = `contract-${crypto.randomUUID()}`;
    walletId = (await call('POST', '/wallets', { playerId, initialBalance: { currency: 'BRL', amount: '100.00' } })).body.id;
    const bet = submission(walletId, playerId);
    processedExternalId = bet.externalTransactionId;
    processed = (await submit(bet)).body;
    rejected = (await submit(submission(walletId, playerId, { money: { amount: '5000.00', currency: 'BRL' } }))).body;
    pending = (await submit(submission(walletId, playerId, { kind: 'REFUND', referenceExternalTransactionId: 'not-yet-arrived' }))).body;
  });

  type Row = { name: string; run: () => Promise<{ status: number; body: Json }>; status: number; error?: string };
  const rows = (): Row[] => [
    // POST /wallets
    { name: 'POST /wallets creates', run: () => call('POST', '/wallets', { playerId: `c-${crypto.randomUUID()}`, initialBalance: { currency: 'BRL' } }), status: 201 },
    { name: 'POST /wallets malformed body', run: () => call('POST', '/wallets', { playerId: 7 }), status: 400, error: 'MALFORMED_REQUEST' },
    { name: 'POST /wallets invalid amount', run: () => call('POST', '/wallets', { playerId: 'p', initialBalance: { currency: 'BRL', amount: '-1.00' } }), status: 400, error: 'INVALID_PAYLOAD' },
    { name: 'POST /wallets duplicate', run: () => call('POST', '/wallets', { playerId, initialBalance: { currency: 'BRL' } }), status: 409, error: 'WALLET_ALREADY_EXISTS' },

    // POST /wagering/transactions
    { name: 'submit processed', run: () => submit(submission(walletId, playerId)), status: 200 },
    { name: 'submit pending reference', run: () => submit(submission(walletId, playerId, { kind: 'ROLLBACK', referenceExternalTransactionId: 'nowhere' })), status: 202 },
    { name: 'submit without Idempotency-Key', run: () => submit(submission(walletId, playerId), null), status: 400, error: 'MALFORMED_REQUEST' },
    { name: 'submit invalid payload', run: () => submit(submission(walletId, playerId, { kind: 'OPENING' })), status: 400, error: 'INVALID_PAYLOAD' },
    { name: 'submit unknown wallet', run: () => submit(submission(MISSING, playerId)), status: 404, error: 'WALLET_NOT_FOUND' },
    { name: 'submit idempotency conflict', run: async () => {
      const key = crypto.randomUUID();
      const body = submission(walletId, playerId);
      await submit(body, key);
      return submit({ ...body, money: { amount: '11.00', currency: 'BRL' } }, key);
    }, status: 409, error: 'IDEMPOTENCY_CONFLICT' },
    { name: 'submit business rejection', run: () => submit(submission(walletId, playerId, { money: { amount: '9999.00', currency: 'BRL' } })), status: 422 },

    // GET /wagering/transactions/:id and the by-provider lookup
    { name: 'GET transaction by id (processed)', run: () => call('GET', `/wagering/transactions/${processed.transactionId}`), status: 200 },
    { name: 'GET transaction by id (rejected, still a 200 read)', run: () => call('GET', `/wagering/transactions/${rejected.transactionId}`), status: 200 },
    { name: 'GET transaction by id (pending, still a 200 read)', run: () => call('GET', `/wagering/transactions/${pending.transactionId}`), status: 200 },
    { name: 'GET transaction by id unknown', run: () => call('GET', `/wagering/transactions/${MISSING}`), status: 404, error: 'TRANSACTION_NOT_FOUND' },
    { name: 'GET transaction by id not a UUID', run: () => call('GET', '/wagering/transactions/abc'), status: 400, error: 'MALFORMED_REQUEST' },
    { name: 'GET transaction by provider', run: () => call('GET', `/providers/provider-contract/wagering/transactions/${processedExternalId}`), status: 200 },
    { name: 'GET transaction by provider unknown', run: () => call('GET', '/providers/provider-contract/wagering/transactions/nope'), status: 404, error: 'TRANSACTION_NOT_FOUND' },
    { name: 'GET transaction by another provider never matches', run: () => call('GET', `/providers/other/wagering/transactions/${processedExternalId}`), status: 404, error: 'TRANSACTION_NOT_FOUND' },

    // GET /wallets/:id and /wallets/:id/ledger
    { name: 'GET wallet', run: () => call('GET', `/wallets/${walletId}`), status: 200 },
    { name: 'GET wallet unknown', run: () => call('GET', `/wallets/${MISSING}`), status: 404, error: 'WALLET_NOT_FOUND' },
    { name: 'GET wallet not a UUID', run: () => call('GET', '/wallets/abc'), status: 400, error: 'MALFORMED_REQUEST' },
    { name: 'GET ledger', run: () => call('GET', `/wallets/${walletId}/ledger?limit=2`), status: 200 },
    { name: 'GET ledger unknown wallet', run: () => call('GET', `/wallets/${MISSING}/ledger`), status: 404, error: 'WALLET_NOT_FOUND' },
    { name: 'GET ledger bad cursor', run: () => call('GET', `/wallets/${walletId}/ledger?cursor=%%%`), status: 400, error: 'INVALID_CURSOR' },
    { name: 'GET ledger bad limit', run: () => call('GET', `/wallets/${walletId}/ledger?limit=0`), status: 400, error: 'MALFORMED_REQUEST' },

    // POST /wallets/:id/reconciliation
    { name: 'reconciliation', run: () => call('POST', `/wallets/${walletId}/reconciliation`), status: 200 },
    { name: 'reconciliation unknown wallet', run: () => call('POST', `/wallets/${MISSING}/reconciliation`), status: 404, error: 'WALLET_NOT_FOUND' },
    { name: 'reconciliation not a UUID', run: () => call('POST', '/wallets/abc/reconciliation'), status: 400, error: 'MALFORMED_REQUEST' },

    // Health (503 is covered in http-operations.test.ts and error-mapping.test.ts)
    { name: 'GET /health/live', run: () => call('GET', '/health/live'), status: 200 },
    { name: 'GET /health/ready', run: () => call('GET', '/health/ready'), status: 200 },
  ];

  // Evaluated once: the rows only build closures, nothing runs until the test does.
  for (const row of rows()) {
    it(`${row.name} -> ${row.status}${row.error ? ` ${row.error}` : ''}`, async () => {
      const { status, body } = await row.run();
      expect(status).toBe(row.status);
      if (row.error) {
        // Every error has the same two fields, so a provider parses one shape. (A 422 is a transaction view.)
        expect(Object.keys(body).sort()).toEqual(['error', 'message']);
        expect(body.error).toBe(row.error);
      }
    });
  }

  it('the three transaction statuses reach a provider with the fields it needs to decide what to do', () => {
    expect(processed.status).toBe('PROCESSED');
    expect(processed.balance).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(pending.status).toBe('PENDING_REFERENCE');
    expect(pending.balance).toBeUndefined();
  });
});
