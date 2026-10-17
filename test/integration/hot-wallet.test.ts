import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { startClusterFixture } from '../support/cluster-fixture';
import { assertInvariants, waitForConvergence } from '../support/convergence';
import { initTestOrm, truncateAll } from '../support/database';
import { CURRENCY, openWallets, PROVIDER_ID } from '../support/load';

// Hot-wallet experiment (M9). A request waits for the wallet lock inside its SQL transaction, so it holds a
// connection while it waits. With more requests queued on one wallet than the pool holds, requests for other wallets
// wait for a connection. This measures how long, as a documented limit rather than a guarantee: it asserts
// correctness and prints the numbers; the latencies are not thresholds. Since decision #65 a request that waits
// longer than WALLET_LOCK_TIMEOUT_MS for the wallet lock is shed with a 503 and persists nothing; those are counted
// out of the expected transactions, and every other request must be settled.
const BURST = Number(process.env.HOT_BURST ?? 200);
const COLD_WALLETS = 5;

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
const summarize = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0
    ? { n: 0 }
    : { n: sorted.length, p50: Math.round(percentile(sorted, 0.5)), p95: Math.round(percentile(sorted, 0.95)), max: Math.round(sorted.at(-1)!) };
};

describe('hot wallet (one instance, real PostgreSQL)', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await initTestOrm();
  });
  afterAll(async () => {
    await truncateAll(orm);
    await orm.close();
  });

  const experiment = async (pool: number) => {
    await truncateAll(orm);
    // One instance and no consumer: the pool of this process is the only thing being measured.
    const fixture = await startClusterFixture(1, { DATABASE_POOL_MAX: String(pool), SQS_CONSUMER: 'off' });
    try {
      const { cluster, sqs, target } = fixture;
      const url = cluster.instances[0]!.url;
      const wallets = await openWallets(cluster, 1 + COLD_WALLETS, '100000.00', `hot${pool}`);
      const hot = wallets[0]!;
      const cold = wallets.slice(1);
      let sequence = 0;
      let shed = 0; // answered 503: the wallet-lock wait hit its limit (decision #65) and nothing was persisted

      const bet = async (wallet: { id: string; playerId: string }) => {
        const id = `ext-${pool}-${++sequence}`;
        const started = performance.now();
        const res = await fetch(`${url}/wagering/transactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': `${PROVIDER_ID}:${id}` },
          body: JSON.stringify({
            providerId: PROVIDER_ID, externalTransactionId: id, playerId: wallet.playerId, walletId: wallet.id,
            roundId: 'round-1', gameId: 'game-1', kind: 'BET', money: { amount: '1.00', currency: CURRENCY },
          }),
        });
        await res.arrayBuffer();
        if (res.status === 503) shed += 1;
        return { status: res.status, ms: performance.now() - started };
      };

      // Probes for other wallets: one at a time, in turn, for as long as `running` says.
      const probe = async (running: () => boolean) => {
        const results: { status: number; ms: number }[] = [];
        for (let i = 0; running(); i += 1) {
          results.push(await bet(cold[i % cold.length]!));
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return results;
      };

      // Warm-up: open the pool's connections first, so connection set-up does not count as lock waiting.
      await Promise.all(Array.from({ length: pool * 2 }, (_, i) => bet(cold[i % cold.length]!)));

      const baselineEnd = Date.now() + 2_000;
      const baseline = await probe(() => Date.now() < baselineEnd);

      let burstDone = false;
      const probing = probe(() => !burstDone);
      const started = performance.now();
      const burst = await Promise.all(Array.from({ length: BURST }, () => bet(hot)));
      const burstMs = performance.now() - started;
      burstDone = true;
      const during = await probing;

      const submitted = sequence - shed; // a shed request left no transaction behind; the provider would resend it
      await waitForConvergence(orm, sqs, { ...target, expectedTransactions: submitted }, 60_000);
      await assertInvariants(orm, sqs, { ...target, expectedTransactions: submitted });

      const statuses = (rs: { status: number }[]) => Object.fromEntries([...new Set(rs.map((r) => r.status))].map((s) => [s, rs.filter((r) => r.status === s).length]));
      const row = {
        pool,
        burst: BURST,
        shed,
        burstSeconds: Number((burstMs / 1000).toFixed(2)),
        hot: summarize(burst.map((r) => r.ms)),
        coldBaseline: summarize(baseline.map((r) => r.ms)),
        coldDuringBurst: summarize(during.map((r) => r.ms)),
      };
      console.log(`hot wallet ${JSON.stringify(row)} hotStatuses ${JSON.stringify(statuses(burst))} coldStatuses ${JSON.stringify(statuses(during))}`);
      return { burst, during, baseline };
    } finally {
      await fixture.dispose();
    }
  };

  for (const pool of [10, 50]) {
    it(`a burst of ${BURST} requests on one wallet with a pool of ${pool}: every request is settled and the ledger is consistent`, async () => {
      const { burst, during, baseline } = await experiment(pool);
      // Never a server error: a request either completes or, when the infrastructure is saturated, is told to retry.
      for (const r of [...burst, ...during, ...baseline]) expect([200, 422, 503]).toContain(r.status);
      expect(burst.filter((r) => r.status === 200).length).toBeGreaterThan(0);
    }, 180_000);
  }
});
