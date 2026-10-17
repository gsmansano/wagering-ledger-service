import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { startClusterFixture, type ClusterFixture } from '../support/cluster-fixture';
import { assertAnswersMatchDatabase, assertInvariants, assertProviderAnswers, waitForConvergence, type ConvergenceTarget } from '../support/convergence';
import { initTestOrm, truncateAll } from '../support/database';
import { openWallets, planLoad, playLoad, Progress } from '../support/load';

// Instances are killed with SIGKILL while the load runs: no shutdown hooks, connections cut mid-transaction,
// queue messages left in flight. Providers resend with the same key, the queue redelivers, and the system must end
// in exactly the state an undisturbed run would satisfy (§8, §10, §11).
const INSTANCES = 3;
const WALLETS = 6;
const OPERATIONS = 240;
const SEED = Number(process.env.LOAD_SEED ?? 20261019);

describe('restart under load (real processes, PostgreSQL and MiniStack)', () => {
  let orm: MikroORM;
  let fixture: ClusterFixture;

  beforeAll(async () => {
    orm = await initTestOrm();
    await truncateAll(orm);
    fixture = await startClusterFixture(INSTANCES);
  }, 60_000);

  afterAll(async () => {
    await fixture?.dispose();
    await truncateAll(orm);
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
    // An earlier test may leave an instance down; every test starts with the full cluster.
    await Promise.all(fixture.cluster.instances.filter((i) => !i.alive).map((i) => fixture.cluster.restart(i.index)));
  }, 60_000);

  const run = async (disturb: (progress: Progress, transactionsAtKill: { value: number }) => Promise<void>) => {
    const { cluster, sqs, target } = fixture;
    const wallets = await openWallets(cluster, WALLETS, '300.00', 'rs');
    const plan = planLoad(SEED, wallets, OPERATIONS);
    const progress = new Progress();
    const atKill = { value: -1 };

    const [records] = await Promise.all([
      playLoad(cluster, plan, { concurrency: 24, sqs, wagerQueueUrl: target.wagerQueueUrl, progress }),
      disturb(progress, atKill),
    ]);

    const convergence: ConvergenceTarget = { ...target, expectedTransactions: plan.distinctTransactions };
    try {
      await waitForConvergence(orm, sqs, convergence, 120_000);
      await assertInvariants(orm, sqs, convergence);
      assertProviderAnswers(records);
      await assertAnswersMatchDatabase(orm, records);
    } catch (error) {
      for (const instance of cluster.instances) console.error(`--- instance ${instance.index} ---\n${cluster.tail(instance.index)}`);
      throw new Error(`${(error as Error).message} (replay with LOAD_SEED=${SEED})`, { cause: error });
    }
    // The kill landed in the middle of the work, not before it or after it.
    expect(atKill.value).toBeGreaterThan(0);
    expect(atKill.value).toBeLessThan(plan.distinctTransactions);
    const retries = records.reduce((n, r) => n + r.retries, 0);
    console.log(`seed ${SEED}: ${atKill.value}/${plan.distinctTransactions} transactions at the kill, ${retries} resent deliveries`);
    return { records, retries };
  };

  const transactionCount = async () =>
    Number(
      (await orm.em.getConnection().execute<{ n: string }[]>(`select count(*) as n from wager_transactions where kind <> 'OPENING'`))[0]!.n,
    );

  it('one instance killed mid-load and started again: the others carry on and the ledger is consistent', async () => {
    const { cluster } = fixture;
    const { retries } = await run(async (progress, atKill) => {
      await progress.reached(70);
      atKill.value = await transactionCount();
      await cluster.kill(1);
      await progress.reached(140);
      await cluster.restart(1);
    });
    expect(cluster.alive).toHaveLength(INSTANCES);
    expect(retries).toBeGreaterThan(0); // requests in flight at the dead instance were resent elsewhere
  }, 240_000);

  it('every instance killed mid-load and started again: nothing acknowledged is lost, nothing is applied twice', async () => {
    const { cluster } = fixture;
    const { retries } = await run(async (progress, atKill) => {
      await progress.reached(90);
      atKill.value = await transactionCount();
      for (const instance of [...cluster.alive]) await cluster.kill(instance.index);
      expect(cluster.alive).toHaveLength(0);
      await Promise.all(cluster.instances.map((instance) => cluster.restart(instance.index)));
    });
    expect(cluster.alive).toHaveLength(INSTANCES);
    expect(retries).toBeGreaterThan(0);
  }, 240_000);
});
