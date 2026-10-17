import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DeleteQueueCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/config';
import { assertInvariants, waitForConvergence, type ConvergenceTarget } from '../support/convergence';
import { initTestOrm, truncateAll } from '../support/database';
import { Cluster } from '../support/instances';
import { openWallets, planLoad, playLoad, type DeliveryRecord } from '../support/load';

// Real OS processes sharing one database and one set of queues (§8, §13). The processes own their queues (a
// per-run prefix), so a running development stack cannot take their messages, and the final state is judged by
// the database invariants, not by what the clients were told.
const INSTANCES = 3;
const WALLETS = 6;
const SEED = Number(process.env.LOAD_SEED ?? 20261018);
const RUN_PREFIX = `mi${Date.now().toString(36)}-`;

describe('several instances under mixed load (real processes, PostgreSQL and MiniStack)', () => {
  const { sqs: sqsConfig } = loadConfig();
  const sqs = new SQSClient({
    endpoint: sqsConfig.endpoint,
    region: sqsConfig.region,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  let orm: MikroORM;
  let cluster: Cluster;
  let target: Pick<ConvergenceTarget, 'wagerQueueUrl' | 'dlqUrl'>;

  const queueUrl = async (name: string) => (await sqs.send(new GetQueueUrlCommand({ QueueName: `${RUN_PREFIX}${name}` }))).QueueUrl!;

  beforeAll(async () => {
    orm = await initTestOrm();
    await truncateAll(orm);
    cluster = await Cluster.start(INSTANCES, {
      env: {
        SQS_QUEUE_PREFIX: RUN_PREFIX,
        PENDING_REFERENCE_WORKER: 'on',
        PENDING_REFERENCE_POLL_MS: '200',
        PENDING_REFERENCE_BACKOFF_BASE_MS: '100',
        PENDING_REFERENCE_BACKOFF_CAP_MS: '1000',
        OUTBOX_WORKER: 'on',
        OUTBOX_POLL_MS: '100',
        SQS_CONSUMER: 'on',
        SQS_CONSUMER_CONCURRENCY: '2',
        SQS_WAIT_TIME_SECONDS: '1',
        SQS_RETRY_BASE_MS: '200',
        SQS_SHUTDOWN_TIMEOUT_MS: '3000',
      },
    });
    target = { wagerQueueUrl: await queueUrl('wager-transactions.fifo'), dlqUrl: await queueUrl('wager-transactions-dlq.fifo') };
  }, 60_000);

  afterAll(async () => {
    await cluster?.stopAll();
    for (const name of ['wager-transactions.fifo', 'wager-transactions-dlq.fifo', 'wager-events.fifo']) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: await queueUrl(name) })).catch(() => undefined);
    }
    await truncateAll(orm);
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
  });

  it(`${INSTANCES} instances applying a mixed HTTP and SQS load to shared wallets converge to a consistent ledger (seed ${SEED})`, async () => {
    const wallets = await openWallets(cluster, WALLETS, '300.00', 'mi');
    const plan = planLoad(SEED, wallets, 240);
    const channels = new Set(plan.operations.map((op) => op.channel));
    expect(channels).toEqual(new Set(['http', 'sqs']));
    expect(plan.operations.some((op) => op.duplicateOf !== undefined)).toBe(true);

    const records = await playLoad(cluster, plan, { concurrency: 24, sqs, wagerQueueUrl: target.wagerQueueUrl });

    const convergence: ConvergenceTarget = { ...target, expectedTransactions: plan.distinctTransactions };
    try {
      await waitForConvergence(orm, sqs, convergence);
      await assertInvariants(orm, sqs, convergence);
    } catch (error) {
      for (const instance of cluster.instances) console.error(`--- instance ${instance.index} ---\n${cluster.tail(instance.index)}`);
      throw new Error(`${(error as Error).message} (replay with LOAD_SEED=${SEED})`, { cause: error });
    }

    // What the providers were told: nothing but final answers or "pending", never a conflict or a server error.
    const http = records.filter((r): r is DeliveryRecord => r.httpStatus !== undefined);
    expect(http.length).toBeGreaterThan(100);
    expect(new Set(http.map((r) => r.httpStatus)).has(500)).toBe(false);
    for (const r of http) expect([200, 202, 422, 503]).toContain(r.httpStatus!);

    // A duplicate answered with the original's transaction, whichever instance and channel took it.
    const answered = new Map(http.map((r) => [r.operation.index, r]));
    let comparedDuplicates = 0;
    for (const r of http) {
      const original = answered.get(r.operation.duplicateOf ?? -1);
      if (original?.transactionId === undefined || r.transactionId === undefined) continue;
      expect(r.transactionId).toBe(original.transactionId);
      comparedDuplicates += 1;
    }
    expect(comparedDuplicates).toBeGreaterThan(0);

    // The instances really competed: every one served requests, and every wallet was reached through several.
    const servedBy = new Map<string, Set<number>>();
    for (const r of http) {
      const set = servedBy.get(r.operation.request.walletId) ?? new Set<number>();
      set.add(r.instance!);
      servedBy.set(r.operation.request.walletId, set);
    }
    expect(new Set(http.map((r) => r.instance)).size).toBe(INSTANCES);
    for (const wallet of wallets) expect(servedBy.get(wallet.id)!.size).toBeGreaterThan(1);

    // The business mix happened: money moved, some bets were refused, and reversals were exercised.
    const [mix] = await orm.em.getConnection().execute<{ processed: string; rejected: string; reversals: string }[]>(
      `select count(*) filter (where status = 'PROCESSED' and kind <> 'OPENING') as processed,
              count(*) filter (where status = 'REJECTED') as rejected,
              count(*) filter (where kind in ('REFUND', 'ROLLBACK')) as reversals
         from wager_transactions`,
    );
    expect(Number(mix!.processed)).toBeGreaterThan(50);
    expect(Number(mix!.reversals)).toBeGreaterThan(5);
    console.log(`seed ${SEED}: ${JSON.stringify(mix)}, retries ${records.reduce((n, r) => n + r.retries, 0)}`);
  }, 120_000);
});
