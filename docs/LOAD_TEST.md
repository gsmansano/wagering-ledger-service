# Load test

`bun run test:load` (`scripts/load/run.ts`) drives HTTP load against three real application instances and checks, once each run is quiet, that the ledger is still correct. The raw results of the run described here are in `docs/load-test-results.json`. There is no throughput target: the purpose is to find where the system bends and to say honestly what the numbers do and do not show.

## Environment

| | |
|---|---|
| Machine | AMD Ryzen 5 PRO 3500U, 4 cores, 9.9 GiB, WSL2 (Linux 6.6.87.2) |
| Software | Bun 1.4.3, PostgreSQL 17.11 (Docker), MiniStack (Docker) |
| Application | 3 instances (separate processes), `DATABASE_POOL_MAX=10` each, `WALLET_LOCK_TIMEOUT_MS=5000`, `OUTBOX_POLL_MS=500`, `LOG_LEVEL=info`, queue consumer off |
| Placement | **The load generator, the three instances, PostgreSQL and MiniStack share the same four cores.** |

## Method

- **Load model: closed loop.** *N* concurrent loops, each sending one request and waiting for its answer. Concurrency levels: 8, 32, 128. Each run lasts 15 s after a 2 s warm-up, on a freshly truncated database with 200 wallets opened with 1,000,000.00.
- **Mix.** 60% BET, 25% WIN, 15% LOSS, amounts from 1.00 to 19.99. About 5% of requests are sent twice at the same moment, with the same `Idempotency-Key`, to two different instances. Reversals are not in the mix (covered by the correctness tests).
- **Scenarios.** *spread*: wallets chosen uniformly. *skewed*: 80% of requests on 5 wallets. *hot*: 90% of requests on one wallet.
- **What is measured.** Latency is measured by the client (p50, p95, p99). Wallet-lock waits (the "concurrency conflicts" of this design) and server processing time come from the `/metrics` histograms, as differences before and after the measured window; a histogram only gives the bucket a value fell in, so those percentiles are upper bounds. The outbox lag and the number of unpublished events are sampled from `/metrics` every second, and the time the publishers need to catch up is measured after the load stops.
- **Correctness.** After each run the script waits for convergence and runs the SQL invariants of the multi-instance tests: `balance == ledger`, gapless ledger and event chains, one row per accepted transaction, nothing pending, outbox published. A `503` is counted as shed load, and the row count check also proves it persisted nothing.

## Results

One run per cell. Latency in ms; "shed / error" is the share of `503` answers and of any answer other than 200, 202, 422 and 503. Outbox: oldest unpublished event at the end (s) / most unpublished events seen / seconds to drain after the load stopped.

| Scenario | In flight | Requests | req/s | p50 | p95 | p99 | Shed / error | Wallet-lock wait (mean, share, timeouts) | Outbox lag / backlog / drain |
|---|---|---|---|---|---|---|---|---|---|
| spread | 8 | 951 | 63 | 118 | 221 | 275 | 0% / 0% | 30 ms, 1% > 100 ms, 0 | 10 / 1179 / 12 |
| spread | 32 | 1529 | 100 | 288 | 560 | 692 | 0% / 0% | 65 ms, 12% > 100 ms, 0 | 15 / 2737 / 33 |
| spread | 128 | 1764 | 109 | 1121 | 1638 | 2013 | 0% / 0% | 75 ms, 19% > 100 ms, 0 | 17 / 3608 / 54 |
| skewed | 8 | 746 | 48 | 136 | 362 | 544 | 0% / 0% | 60 ms, 16% > 100 ms, 0 | 11 / 1044 / 17 |
| skewed | 32 | 1137 | 73 | 305 | 1241 | 2326 | 0% / 0% | 242 ms, 49% > 100 ms, 0 | 14 / 1992 / 45 |
| skewed | 128 | 1379 | 78 | 1424 | 2914 | 3836 | 0% / 0% | 266 ms, 53% > 100 ms, 0 | 20 / 2941 / 55 |
| hot | 8 | 629 | 41 | 125 | 580 | 892 | 0% / 0% | 157 ms, 47% > 100 ms, 0 | 11 / 746 / 31 |
| hot | 32 | 606 | 38 | 566 | 2345 | 3736 | 0% / 0% | 616 ms, 68% > 100 ms, 0 | 12 / 765 / 23 |
| hot | 128 | 852 | 46 | 2565 | 4563 | 6260 | 0% / 0% | 545 ms, 56% > 100 ms, 0 | 20 / 1722 / >60 |

In all nine runs the ledger check passed, every answer was 200 or 422 (no `503`, no error), and every duplicate pair got the same transaction id.

## What the numbers show

1. **The cluster saturates around 100 requests per second on this machine** (spread: 63, 100, 109 req/s at 8, 32 and 128 in flight). Past about 32 in flight more concurrency only adds waiting: in a closed loop latency is roughly in-flight divided by throughput, and p50 grows from 288 ms to 1.1 s for 9% more throughput. Where the limit lies (CPU, PostgreSQL, the connection pools) was not profiled; with five processes on four cores, CPU is the first suspect, and the numbers should be read as a floor for what the code can do, not as capacity.
2. **Concentration on few wallets costs throughput and tail latency, as designed.** The same concurrency gives 100 req/s spread, 73 skewed and 38 on one hot wallet at 32 in flight. The hot wallet's 38 to 46 requests per second agrees with decision #62 (15 to 45 on one instance); adding instances did not raise it, because the wallet lock serializes that wallet whatever the instance. The lock wait is where the time goes: in the hot runs the mean wait was 157 to 616 ms and 47% to 68% of waits exceeded 100 ms, against 1% to 19% in the spread runs.
3. **A hot wallet also delays other wallets once the pool is the queue.** With 8 in flight, requests for other wallets took a median 43 ms; with 128 in flight, 2.3 s, almost the same as the hot wallet's own 2.6 s. The lock timeout never fired (the longest waits were under its 5 s limit), so nothing was shed and the wait was paid in the connection pool queue, the limit already recorded in decisions #62 and #65. With 30 connections in total, a heavier burst or a lower timeout would shed with `503` instead.
4. **The outbox publisher is the first thing that does not keep up.** In every run events were written faster than they were published: the backlog reached 700 to 3,600 events, the oldest unpublished event was 10 to 20 s old at the end of a 15 s run, and the publishers needed 12 to 55 s after the load stopped to catch up (more than 60 s in the last hot run). Each request writes about two events, and the cluster published roughly 30 to 50 events per second (10 to 17 per instance), or 25 to 60 ms per event; these rates are estimates from the backlog and drain times, not a direct measurement. This is the cost named in limitation 3 of `ARCHITECTURE.md` (one event per SQL transaction, with the SQS call inside it), now measured. In the hot runs the order requirement makes it worse: a wallet's stream can have only one event in flight, so the hot wallet's events are published one at a time whichever instance takes them. No event was lost, parked or published out of order (the chain checks passed); notifications are late, not wrong, and the lag is visible in `wagering_outbox_lag_seconds`.
5. **Correctness did not depend on speed.** Duplicates sent to two instances at once never produced two transactions or two ids, no balance went negative, and the ledger matched the balance in every run, including the ones with the longest waits.

## Limits of this experiment

- **Same-machine load.** The generator competes with the system under test for four cores, so throughput is understated and latency overstated by an unknown amount.
- **Closed loop.** When the system slows down, the clients slow down with it, so a stall is under-sampled (coordinated omission). The tail latencies here are a lower bound on what a fixed arrival rate would have seen. An open-loop generator was not built.
- **One run per cell, 15 s each.** No repetitions, so the variance is unknown; the hot-wallet figures varied by about 3x between runs in the earlier M9 experiment, so differences of tens of percent between cells are not evidence. Trends across cells are.
- **Emulated SQS.** Publication cost was measured against MiniStack, not SQS. The 25 to 60 ms per event includes the emulator, the SQL claim and the contention for CPU, and was not broken down.
- **HTTP only.** The queue consumer was off. Reversals were not in the mix, and wallets started with plenty of funds, so insufficient-funds rejections are rare in this load.
- **Test database.** The script uses `wagering_test` and truncates it.

## What I would do next

- Publish several events per claim, or per SQS batch call, in one transaction (bounded by the per-wallet order rule), and measure again; that is the cheapest way to raise the publishing rate.
- Run the generator on another machine, add an open-loop mode with a fixed arrival rate, and repeat each cell to get a spread.
- Profile the saturation point (CPU per process, PostgreSQL waits) before changing the pool size or the instance count.

## Reproduce

```bash
docker compose up -d postgres ministack migrate   # and stop the Compose app
bun run test:load                                 # about 4 minutes; writes docs/load-test-results.json
LOAD_DURATION_S=5 LOAD_CONCURRENCY=8,32 LOAD_SCENARIOS=spread bun run test:load   # a short run
```

Settings: `LOAD_DURATION_S`, `LOAD_WARMUP_S`, `LOAD_CONCURRENCY`, `LOAD_SCENARIOS`, `LOAD_INSTANCES`, `LOAD_WALLETS`, `LOAD_SEED`, `LOAD_OUT`. The script exits with an error if any run fails the ledger checks.
