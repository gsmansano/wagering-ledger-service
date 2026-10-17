import { describe, expect, it } from 'bun:test';
import { IdempotencyConflictError } from '../../application/transaction/idempotency-conflict.error';
import { InboxPayloadConflictError } from '../../application/transaction/inbox-payload-conflict.error';
import type { ProcessWagerTransaction } from '../../application/transaction/process-wager-transaction';
import { UnresolvedConflictError } from '../../application/transaction/unresolved-conflict.error';
import { WalletLockTimeoutError } from '../../application/wallet/wallet-lock-timeout.error';
import { WalletNotFoundError } from '../../application/wallet/wallet-not-found.error';
import { DomainError } from '../../domain/shared/domain-error';
import { InvalidInputError } from '../../domain/shared/invalid-input-error';
import { WagerMessageHandler } from './wager-message.handler';

const body = JSON.stringify({
  messageId: 'msg-1',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-1',
    idempotencyKey: 'provider-a:transaction-1',
    playerId: 'player-1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
});

// The handler only calls `execute`; the use case itself is covered against a real database elsewhere.
const handlerFor = (execute: () => Promise<unknown>) =>
  new WagerMessageHandler({ execute } as unknown as ProcessWagerTransaction, { baseMs: 1_000, capMs: 5_000 });

const failing = (error: unknown) => handlerFor(() => Promise.reject(error));

describe('WagerMessageHandler', () => {
  it('acks a processed message', async () => {
    const handler = handlerFor(async () => ({
      transaction: { id: 'transaction-id', status: 'PROCESSED', failureCode: undefined },
      idempotentReplay: false,
    }));
    expect(await handler.handle(body, 1)).toEqual({ kind: 'ack', outcome: 'processed' });
  });

  it('acks a duplicate message', async () => {
    const handler = handlerFor(async () => ({ duplicateMessage: true }));
    expect(await handler.handle(body, 3)).toEqual({ kind: 'ack', outcome: 'duplicate' });
  });

  const permanent: [string, unknown, string][] = [
    ['an invalid input', new InvalidInputError('amount must be positive'), 'InvalidInputError'],
    ['an unknown wallet', new WalletNotFoundError('w-1'), 'WalletNotFoundError'],
    ['an idempotency conflict', new IdempotencyConflictError('k', 't'), 'IdempotencyConflictError'],
    ['a message id reused with another payload', new InboxPayloadConflictError('c', 'm'), 'InboxPayloadConflictError'],
  ];
  for (const [name, error, code] of permanent) {
    it(`dead-letters ${name}, never retrying`, async () => {
      expect(await failing(error).handle(body, 1)).toMatchObject({ kind: 'dead-letter', code });
    });
  }

  it('dead-letters a body that is not a valid message without touching the use case', async () => {
    let called = false;
    const handler = handlerFor(async () => {
      called = true;
    });
    expect(await handler.handle('{oops', 1)).toMatchObject({ kind: 'dead-letter', code: 'InvalidMessageError' });
    expect(called).toBe(false);
  });

  it('truncates a very long reason', async () => {
    const result = await failing(new InvalidInputError('x'.repeat(5_000))).handle(body, 1);
    expect(result.kind === 'dead-letter' && result.reason.length).toBe(1_000);
  });

  describe('retry', () => {
    const transient = Object.assign(new Error('connection terminated'), { code: '08006' });

    it('retries a transient database error with a delay that grows with the receive count, up to the cap', async () => {
      const delays: unknown[] = [];
      for (const receiveCount of [1, 2, 3, 4, 10]) {
        const result = await failing(transient).handle(body, receiveCount);
        expect(result.kind).toBe('retry');
        delays.push(result.kind === 'retry' && result.delayMs);
      }
      expect(delays).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
    });

    it('retries an unknown error: a bug is more likely than bad input', async () => {
      for (const error of [new Error('boom'), new UnresolvedConflictError('p', 'k'), new DomainError('invalid transition')]) {
        expect((await failing(error).handle(body, 1)).kind).toBe('retry');
      }
    });

    it('retries a wallet-lock timeout four times later than other transient errors, up to the cap', async () => {
      const timeout = new WalletLockTimeoutError('wallet-1');
      const delays: unknown[] = [];
      for (const receiveCount of [1, 2, 3]) {
        const result = await failing(timeout).handle(body, receiveCount);
        delays.push(result.kind === 'retry' && result.delayMs);
      }
      expect(delays).toEqual([4_000, 5_000, 5_000]); // 1 s, 2 s, 4 s times four, capped at 5 s
    });

    it('treats a missing receive count as the first attempt', async () => {
      const result = await failing(transient).handle(body, 0);
      expect(result).toMatchObject({ kind: 'retry', delayMs: 1_000 });
    });
  });
});
