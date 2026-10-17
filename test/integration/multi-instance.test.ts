import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { assertAnswersMatchDatabase, assertInvariants, assertProviderAnswers, waitForConvergence, type ConvergenceTarget } from '../support/convergence';
import { initTestOrm, truncateAll } from '../support/database';
import { startClusterFixture, type ClusterFixture } from '../support/cluster-fixture';
import type { Cluster } from '../support/instances';
import { openWallets, planLoad, playLoad, type DeliveryRecord } from '../support/load';

// Real OS processes sharing one database and one set of queues (§8, §13). The final state is judged by the database
// invariants, not by what the clients were told.
const INSTANCES = 3;
const WALLETS = 6;
const SEED = Number(process.env.LOAD_SEED ?? 20261018);

describe('several instances under mixed load (real processes, PostgreSQL and MiniStack)', () => {
  let orm: MikroORM;
  let fixture: ClusterFixture;
  let cluster: Cluster;
  let sqs: SQSClient;
  let target: ClusterFixture['target'];

  beforeAll(async () => {
    orm = await initTestOrm();
    await truncateAll(orm);
    fixture = await startClusterFixture(INSTANCES);
    ({ cluster, sqs, target } = fixture);
  }, 60_000);

  afterAll(async () => {
    await fixture?.dispose();
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
      assertProviderAnswers(records);
      await assertAnswersMatchDatabase(orm, records);
    } catch (error) {
      for (const instance of cluster.instances) console.error(`--- instance ${instance.index} ---\n${cluster.tail(instance.index)}`);
      throw new Error(`${(error as Error).message} (replay with LOAD_SEED=${SEED})`, { cause: error });
    }

    const http = records.filter((r): r is DeliveryRecord => r.operation.channel === 'http');
    expect(http.length).toBeGreaterThan(100);

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
