import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { initTestOrm, truncateAll } from '../support/database';
import { startClusterFixture, type ClusterFixture } from '../support/cluster-fixture';

// The JSON log of a real process: one line per event, the correlation fields on it, and no money or player data.
const AMOUNT = '123.45';
const PLAYER = 'player-secret-77';

describe('structured logs (a real instance, HTTP and SQS)', () => {
  let orm: MikroORM;
  let fixture: ClusterFixture;
  let baseUrl: string;
  let lines: () => Record<string, unknown>[];

  beforeAll(async () => {
    orm = await initTestOrm();
    await truncateAll(orm);
    fixture = await startClusterFixture(1, { LOG_LEVEL: 'info' });
    const instance = fixture.cluster.instances[0]!;
    baseUrl = instance.url;
    // Every line must be one JSON object: that is what a log collector parses.
    lines = () => instance.logs.map((line) => JSON.parse(line) as Record<string, unknown>);
  }, 60_000);

  afterAll(async () => {
    await fixture?.dispose();
    await truncateAll(orm);
    await orm.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  const wager = (walletId: string, externalTransactionId: string, playerId = PLAYER) => ({
    providerId: 'provider-log',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: AMOUNT, currency: 'BRL' },
  });

  it('logs the request line with the correlation fields, and never money or player data', async () => {
    const created = await post('/wallets', { playerId: PLAYER, initialBalance: { currency: 'BRL', amount: '500.00' } });
    const wallet = (await created.json()) as { id: string };
    expect(created.status).toBe(201);
    const res = await post('/wagering/transactions', wager(wallet.id, 'tx-http-1'), {
      'idempotency-key': 'key-http-1',
      'x-correlation-id': 'corr-http-1',
    });
    const { transactionId } = (await res.json()) as { transactionId: string };
    // An insufficient-funds rejection is a 422, logged at warn level.
    await post('/wagering/transactions', { ...wager(wallet.id, 'tx-http-2'), money: { amount: '9999.00', currency: 'BRL' } }, { 'idempotency-key': 'key-http-2' });

    await Bun.sleep(200); // the child's stdout is read asynchronously
    const entry = lines().find((line) => line.correlationId === 'corr-http-1');
    expect(entry).toMatchObject({
      level: 'info',
      event: 'transaction_settled',
      providerId: 'provider-log',
      walletId: wallet.id,
      transactionId,
      kind: 'BET',
      status: 'PROCESSED',
      req: { method: 'POST', path: '/wagering/transactions' },
      res: { statusCode: 200 },
    });
    const rejected = lines().find((line) => line.status === 'REJECTED');
    expect(rejected).toMatchObject({ level: 'warn', failureCode: 'INSUFFICIENT_FUNDS', res: { statusCode: 422 } });
    expect(lines().find((line) => line.event === 'wallet_created')).toMatchObject({ walletId: wallet.id });

    const everything = fixture.cluster.instances[0]!.logs.join('\n');
    for (const secret of [AMOUNT, '9999.00', '500.00', PLAYER, 'key-http-1']) expect(everything).not.toContain(secret);
  }, 30_000);

  it('logs a processed queue message with its message id', async () => {
    const created = await post('/wallets', { playerId: `${PLAYER}-sqs`, initialBalance: { currency: 'BRL', amount: '500.00' } });
    const wallet = (await created.json()) as { id: string };
    expect(created.status).toBe(201);
    await fixture.sqs.send(
      new SendMessageCommand({
        QueueUrl: fixture.target.wagerQueueUrl,
        MessageGroupId: wallet.id,
        MessageDeduplicationId: crypto.randomUUID(),
        MessageBody: JSON.stringify({
          messageId: 'msg-log-1',
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: { ...wager(wallet.id, 'tx-sqs-1', `${PLAYER}-sqs`), idempotencyKey: 'provider-log:tx-sqs-1' },
        }),
      }),
    );

    const deadline = Date.now() + 15_000;
    let entry: Record<string, unknown> | undefined;
    while (entry === undefined && Date.now() < deadline) {
      await Bun.sleep(200);
      entry = lines().find((line) => line.messageId === 'msg-log-1');
    }
    expect(entry).toMatchObject({
      event: 'transaction_settled',
      correlationId: 'msg-log-1',
      walletId: wallet.id,
      providerId: 'provider-log',
      kind: 'BET',
      status: 'PROCESSED',
    });
    expect(fixture.cluster.instances[0]!.logs.join('\n')).not.toContain(AMOUNT);
  }, 30_000);
});
