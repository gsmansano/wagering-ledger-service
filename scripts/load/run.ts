// `bun run test:load`: closed-loop HTTP load against several real instances, with the results written to JSON.
// Method and caveats: docs/LOAD_TEST.md. Runs against the test database (the preload in package.json sets it).
import os from 'node:os';
import { gaugeOf, histogramDelta, histogramOf, parseMetrics, quantileUpperBound, type Sample } from './prometheus';
import { assertInvariants, waitForConvergence } from '../../test/support/convergence';
import { initTestOrm, truncateAll } from '../../test/support/database';
import { startClusterFixture, type ClusterFixture } from '../../test/support/cluster-fixture';
import { createRng, CURRENCY, openWallets, PROVIDER_ID, type LoadWallet } from '../../test/support/load';

const env = process.env;
const config = {
  durationS: Number(env.LOAD_DURATION_S ?? 15),
  warmupS: Number(env.LOAD_WARMUP_S ?? 2),
  concurrency: (env.LOAD_CONCURRENCY ?? '8,32,128').split(',').map(Number),
  scenarios: (env.LOAD_SCENARIOS ?? 'spread,skewed,hot').split(','),
  instances: Number(env.LOAD_INSTANCES ?? 3),
  wallets: Number(env.LOAD_WALLETS ?? 200),
  seed: Number(env.LOAD_SEED ?? 1),
  duplicateRate: 0.05,
  out: env.LOAD_OUT ?? 'docs/load-test-results.json',
};

type Scenario = 'spread' | 'skewed' | 'hot';
const HOT_SHARE: Record<Scenario, { hotWallets: number; share: number }> = {
  spread: { hotWallets: 0, share: 0 },
  skewed: { hotWallets: 5, share: 0.8 },
  hot: { hotWallets: 1, share: 0.9 },
};

interface Sampled {
  latencyMs: number;
  status: number | 'error';
  hot: boolean;
}

interface Tally {
  samples: Sampled[];
  /** Distinct transactions that must have a row: some delivery of them got a 200, 202 or 422. */
  accepted: number;
  duplicateMismatches: number;
  duplicatesSent: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(sortedAsc: number[], p: number): number | undefined {
  if (sortedAsc.length === 0) return undefined;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1))];
}

function latencySummary(samples: Sampled[]) {
  const ms = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const round = (n: number | undefined) => (n === undefined ? null : Math.round(n * 10) / 10);
  return { n: ms.length, p50: round(percentile(ms, 0.5)), p95: round(percentile(ms, 0.95)), p99: round(percentile(ms, 0.99)), max: round(ms.at(-1)) };
}

async function scrape(fixture: ClusterFixture): Promise<Sample[][]> {
  return Promise.all(fixture.cluster.alive.map(async (i) => parseMetrics(await (await fetch(`${i.url}/metrics`)).text())));
}

/** Integer cents only: no floating point reaches an amount. */
function amountFrom(rng: () => number): string {
  const units = 1 + Math.floor(rng() * 19);
  const cents = Math.floor(rng() * 100);
  return `${units}.${String(cents).padStart(2, '0')}`;
}

/** Drives `concurrency` loops for `durationMs`; each loop sends one request (and sometimes its twin) at a time. */
async function drive(
  fixture: ClusterFixture,
  wallets: LoadWallet[],
  scenario: Scenario,
  concurrency: number,
  durationMs: number,
  tag: string,
  seed: number,
): Promise<Tally> {
  const { hotWallets, share } = HOT_SHARE[scenario];
  const tally: Tally = { samples: [], accepted: 0, duplicateMismatches: 0, duplicatesSent: 0 };
  const deadline = performance.now() + durationMs;
  let counter = 0;

  const post = async (instanceIndex: number, key: string, body: string) => {
    const instances = fixture.cluster.alive;
    const target = instances[instanceIndex % instances.length]!;
    const started = performance.now();
    try {
      const res = await fetch(`${target.url}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      const parsed = (await res.json()) as { transactionId?: string };
      return { status: res.status as number | 'error', latencyMs: performance.now() - started, transactionId: parsed.transactionId };
    } catch {
      return { status: 'error' as const, latencyMs: performance.now() - started, transactionId: undefined };
    }
  };
  const persisted = (status: number | 'error') => status === 200 || status === 202 || status === 422;

  const loop = async (loopIndex: number) => {
    const rng = createRng(seed * 1_000 + loopIndex);
    while (performance.now() < deadline) {
      const hot = hotWallets > 0 && rng() < share;
      const wallet = hot ? wallets[Math.floor(rng() * hotWallets)]! : wallets[hotWallets + Math.floor(rng() * (wallets.length - hotWallets))]!;
      const roll = rng();
      const kind = roll < 0.6 ? 'BET' : roll < 0.85 ? 'WIN' : 'LOSS';
      const externalTransactionId = `${tag}-${loopIndex}-${counter++}`;
      const request = {
        providerId: PROVIDER_ID,
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: `round-${externalTransactionId}`,
        gameId: 'load-game',
        kind,
        money: { amount: amountFrom(rng), currency: CURRENCY },
      };
      const body = JSON.stringify(request);
      const key = `${PROVIDER_ID}:${externalTransactionId}`;
      const first = loopIndex + counter;
      if (rng() < config.duplicateRate) {
        // The same key at the same moment on two instances: one applies it, the other must replay it.
        tally.duplicatesSent += 1;
        const [a, b] = await Promise.all([post(first, key, body), post(first + 1, key, body)]);
        tally.samples.push({ latencyMs: a.latencyMs, status: a.status, hot });
        if (persisted(a.status) || persisted(b.status)) tally.accepted += 1;
        if (persisted(a.status) && persisted(b.status) && a.transactionId !== b.transactionId) tally.duplicateMismatches += 1;
      } else {
        const result = await post(first, key, body);
        tally.samples.push({ latencyMs: result.latencyMs, status: result.status, hot });
        if (persisted(result.status)) tally.accepted += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, (_, i) => loop(i)));
  return tally;
}

async function runOne(fixture: ClusterFixture, orm: Awaited<ReturnType<typeof initTestOrm>>, scenario: Scenario, concurrency: number) {
  await truncateAll(orm);
  const wallets = await openWallets(fixture.cluster, config.wallets, '1000000.00', `${scenario}-${concurrency}`);
  const tag = `${scenario}${concurrency}`;

  const warmup = await drive(fixture, wallets, scenario, concurrency, config.warmupS * 1000, `${tag}w`, config.seed + 7);

  const before = await scrape(fixture);
  const lagSamples: number[] = [];
  const pendingSamples: number[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const first = parseMetrics(await (await fetch(`${fixture.cluster.alive[0]!.url}/metrics`)).text());
      lagSamples.push(gaugeOf(first, 'wagering_outbox_lag_seconds') ?? 0);
      pendingSamples.push(gaugeOf(first, 'wagering_outbox_pending_events') ?? 0);
      await sleep(1000);
    }
  })();
  const started = performance.now();
  const tally = await drive(fixture, wallets, scenario, concurrency, config.durationS * 1000, tag, config.seed);
  const elapsedS = (performance.now() - started) / 1000;
  sampling = false;
  await sampler;
  const after = await scrape(fixture);

  // How long the publishers need to catch up once the load stops.
  const drainStarted = performance.now();
  let drainMs: number | null = null;
  while (performance.now() - drainStarted < 60_000) {
    const [row] = await orm.em.getConnection().execute<{ n: string }[]>(`select count(*) as n from outbox_messages where published_at is null`);
    if (Number(row!.n) === 0) {
      drainMs = Math.round(performance.now() - drainStarted);
      break;
    }
    await sleep(50);
  }

  const statuses: Record<string, number> = {};
  for (const s of tally.samples) statuses[String(s.status)] = (statuses[String(s.status)] ?? 0) + 1;
  const served = tally.samples.filter((s) => s.status === 200 || s.status === 202 || s.status === 422);
  const unexpected = tally.samples.filter((s) => ![200, 202, 422, 503].includes(s.status as number)).length;

  const lockAcquired = histogramDelta(
    histogramOf(after, 'wagering_wallet_lock_wait_seconds', { key: 'outcome', value: 'acquired' }),
    histogramOf(before, 'wagering_wallet_lock_wait_seconds', { key: 'outcome', value: 'acquired' }),
  );
  const lockTimeouts = histogramDelta(
    histogramOf(after, 'wagering_wallet_lock_wait_seconds', { key: 'outcome', value: 'timeout' }),
    histogramOf(before, 'wagering_wallet_lock_wait_seconds', { key: 'outcome', value: 'timeout' }),
  );
  const processing = histogramDelta(
    histogramOf(after, 'wagering_processing_seconds', { key: 'result', value: 'settled' }),
    histogramOf(before, 'wagering_processing_seconds', { key: 'result', value: 'settled' }),
  );
  const slowLockWaits = lockAcquired.count - (lockAcquired.buckets.get(0.1) ?? 0);

  // Every answered transaction (warm-up included) must be in the database exactly once, and the ledger must agree.
  let invariants: { ok: boolean; error?: string } = { ok: true };
  try {
    const target = { expectedTransactions: warmup.accepted + tally.accepted, wagerQueueUrl: fixture.target.wagerQueueUrl, dlqUrl: fixture.target.dlqUrl };
    await waitForConvergence(orm, fixture.sqs, target, 60_000);
    await assertInvariants(orm, fixture.sqs, target);
  } catch (error) {
    invariants = { ok: false, error: (error as Error).message.split('\n').slice(0, 6).join(' | ') };
  }

  const hotSamples = tally.samples.filter((s) => s.hot);
  const otherSamples = tally.samples.filter((s) => !s.hot);
  const sortedLag = [...lagSamples].sort((a, b) => a - b);
  const result = {
    scenario,
    concurrency,
    seconds: Math.round(elapsedS * 10) / 10,
    requests: tally.samples.length,
    requestsPerSecond: Math.round(tally.samples.length / elapsedS),
    servedPerSecond: Math.round(served.length / elapsedS),
    statuses,
    errorRate: Math.round((unexpected / Math.max(1, tally.samples.length)) * 10_000) / 100,
    shedRate: Math.round(((statuses['503'] ?? 0) / Math.max(1, tally.samples.length)) * 10_000) / 100,
    latencyMs: { all: latencySummary(tally.samples), served: latencySummary(served), hotWallets: scenario === 'spread' ? null : latencySummary(hotSamples), otherWallets: scenario === 'spread' ? null : latencySummary(otherSamples) },
    serverProcessingSecondsUpperBound: { p50: quantileUpperBound(processing, 0.5) ?? null, p99: quantileUpperBound(processing, 0.99) ?? null },
    lockWait: {
      waits: lockAcquired.count,
      meanMs: lockAcquired.count > 0 ? Math.round((lockAcquired.sum / lockAcquired.count) * 10_000) / 10 : null,
      p95UpperBoundSeconds: quantileUpperBound(lockAcquired, 0.95) ?? null,
      p99UpperBoundSeconds: quantileUpperBound(lockAcquired, 0.99) ?? null,
      over100ms: slowLockWaits,
      share: lockAcquired.count > 0 ? Math.round((slowLockWaits / lockAcquired.count) * 10_000) / 100 : null,
      timeouts: lockTimeouts.count,
    },
    outbox: { lagMaxSeconds: sortedLag.at(-1) ?? null, lagP95Seconds: percentile(sortedLag, 0.95) ?? null, pendingMax: Math.max(0, ...pendingSamples), drainMsAfterLoad: drainMs },
    duplicates: { sent: tally.duplicatesSent, differentTransactionIds: tally.duplicateMismatches },
    invariants,
  };
  console.log(
    `${scenario.padEnd(6)} c=${String(concurrency).padEnd(3)} ${String(result.requestsPerSecond).padStart(5)} req/s  ` +
      `p50 ${result.latencyMs.all.p50}  p95 ${result.latencyMs.all.p95}  p99 ${result.latencyMs.all.p99} ms  ` +
      `503 ${result.shedRate}%  err ${result.errorRate}%  lock>100ms ${result.lockWait.share ?? 0}%  ` +
      `outbox lag max ${result.outbox.lagMaxSeconds}s drain ${drainMs}ms  ledger ${invariants.ok ? 'OK' : 'FAILED'}`,
  );
  if (!invariants.ok) console.log(`  ${invariants.error}`);
  return result;
}

async function main() {
  const orm = await initTestOrm();
  const fixture = await startClusterFixture(config.instances, {
    // Defaults a deployment would run with, not the short test intervals.
    OUTBOX_POLL_MS: '500',
    SQS_CONSUMER: 'off', // HTTP load only; the queue path is covered by the multi-instance tests
    LOG_LEVEL: 'info',
    METRICS_CACHE_MS: '0',
  });
  const [versionRow] = await orm.em.getConnection().execute<{ version: string }[]>('select version()');
  const environment = {
    date: new Date().toISOString(),
    machine: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryMiB: Math.round(os.totalmem() / 1024 / 1024), os: `${os.type()} ${os.release()}` },
    bun: Bun.version,
    postgres: versionRow!.version,
    note: 'Load generator, application instances, PostgreSQL and the SQS emulator share one machine.',
    instances: config.instances,
    databasePoolMax: Number(env.DATABASE_POOL_MAX ?? 10),
    walletLockTimeoutMs: Number(env.WALLET_LOCK_TIMEOUT_MS ?? 5000),
    logLevel: 'info',
  };
  console.log(`${environment.machine.cpu} (${environment.machine.cores} cores), ${config.instances} instances, ${config.durationS}s per run\n`);
  const runs = [];
  try {
    for (const scenario of config.scenarios as Scenario[]) {
      for (const concurrency of config.concurrency) runs.push(await runOne(fixture, orm, scenario, concurrency));
    }
  } finally {
    await fixture.dispose();
    await truncateAll(orm);
    await orm.close();
  }
  await Bun.write(config.out, `${JSON.stringify({ environment, config, runs }, null, 2)}\n`);
  console.log(`\nResults written to ${config.out}`);
  if (runs.some((run) => !run.invariants.ok)) process.exit(1);
}

await main();
