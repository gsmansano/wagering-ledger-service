# Wagering Ledger Service

A wallet and ledger service that applies wagering operations (BET, WIN, LOSS, REFUND, ROLLBACK) received over HTTP and SQS, and stays correct under duplicate delivery, out-of-order messages, concurrent instances and crashes.

## Requirements

- Bun 1.x
- Docker with Docker Compose

## Getting started

```bash
bun install
docker compose up -d --build
curl localhost:3000/health/live   # {"status":"ok"}
bun test
```

`docker compose up` starts PostgreSQL, MiniStack (SQS emulator), a one-shot `migrate` service that applies pending migrations, and the app. The app creates the `wager-transactions.fifo` queue and its dead-letter queue `wager-transactions-dlq.fifo` on startup.

## Commands

| Command | Purpose |
|---|---|
| `bun run start` | Run the app on the host against the Compose services |
| `bun test` | Unit and integration tests (requires `postgres` and `ministack` running) |
| `bun run poc:domain` | Print a hands-on tour of the domain model (no Docker needed) |
| `bun run poc:wagering` | Curl walkthrough of M4: create a wallet, BET, duplicate, overdraft, 30 parallel duplicates, then the ledger (needs the app running, see below) |
| `bun run poc:reversals` | Curl walkthrough of M5: a REFUND before its BET is parked, the worker applies it after the BET arrives, a second reversal is refused, an orphan reversal is rejected (needs the app running with short retry timings, see below) |
| `bun run poc:consumer` | AWS CLI walkthrough of M7: send queue messages for a BET (applied once), a duplicate (no effect) and two invalid messages (they land in the DLQ with the reason); runs `amazon/aws-cli` in Docker when `aws` is not installed (needs the app running) |
| `bun run poc:outbox` | Walkthrough of M8: an instance commits and dies before publishing and another publishes the events, a repeated send leaves one copy in the queue, a parked event holds back its own wallet until it is requeued; starts its own app instances on ports 3021 and 3022, so the Compose `app` must be stopped (needs `postgres`, `ministack` and `migrate` running) |
| `bun run poc:multi` | Walkthrough of M9: three instances share four wallets under a mixed load, one is killed with SIGKILL mid-load, and the script prints the stored balance next to the ledger sum of every wallet; starts its own app instances on ports 3031 to 3033, so the Compose `app` must be stopped (needs `postgres`, `ministack` and `migrate` running) |
| `bun run poc:schema` | Try to break each database constraint and show PostgreSQL refusing it (needs `docker compose up`; leaves no data) |
| `bun run typecheck` | Type-check with `tsc --noEmit` |
| `bun run migration:up` | Apply pending migrations |
| `bun run migration:down` | Revert the most recent migration |

Configuration is read from environment variables; see `.env.example`. The SQS emulator accepts any credentials, so the app falls back to placeholder ones (`test`/`test`) when `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are not set; they are never used against real AWS.

## HTTP API

Authentication is a global no-op `AuthGuard` (the extension point, with the intended identity-provider design documented in its comment); health endpoints are marked `@Public()`. Errors are `{ error, message }` with a stable code.

| Endpoint | Success |
|---|---|
| `POST /wallets` `{ playerId, initialBalance: { currency, amount? } }` | `201` wallet with balance and `version`; an omitted or `"0.00"` amount opens an empty wallet |
| `POST /wagering/transactions` with an `Idempotency-Key` header (unique per provider) and an optional `X-Correlation-Id` | the transaction view plus `idempotentReplay` (see below) |
| `GET /wallets/:walletId` | `200` `{ id, playerId, balance, version }` |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | `200` `{ entries, nextCursor }`: entries in the order they were applied (`sequence`, `direction`, `money`, `balanceBefore`, `balanceAfter`, `transactionId`, `createdAt`); `limit` 1 to 200 (default 50); pass `nextCursor` back as `cursor`, `null` on the last page |
| `POST /wallets/:walletId/reconciliation` | `200` `{ walletId, storedBalance, calculatedBalance, difference, consistent, checkedEntries }`: the stored balance against the signed sum of the ledger, read in one SQL statement. A divergence is flagged (`consistent: false`) and logged, never corrected |
| `GET /health/live`, `GET /health/ready` | `200` `{ status: "ok" }` (process up) and `{ status: "ready", checks }`; readiness answers `503 { status: "unavailable", checks }` naming the dependency (`postgres`, `sqs`) that did not answer within 2 s. Both are public |
| `GET /wagering/transactions/:transactionId` and `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | `200` the transaction view, whatever its status (a rejected or pending transaction is returned as it is; only a submit answers `422`/`202`) |

The transaction view is `{ transactionId, providerId, externalTransactionId, walletId, kind, money, status, failureCode?, referenceExternalTransactionId?, balance?, createdAt, processedAt? }`; `balance` is the balance observed at settlement and is absent while the transaction is pending.

### Status codes

One table for every endpoint, so a provider can decide from the status alone:

| Status | Meaning | What the provider does |
|---|---|---|
| `200` / `201` | Processed (`201`: wallet created) | Nothing |
| `202` | `PENDING_REFERENCE`: a REFUND/ROLLBACK waiting for its reference | Resend the same request later, or wait |
| `400` | Invalid payload: `MALFORMED_REQUEST` (missing header, wrong type, unknown kind, id not a UUID, bad `limit`), `INVALID_CURSOR` or `INVALID_PAYLOAD` (bad amount, `OPENING`, wrong player) | Fix it and send as a new request |
| `404` | `WALLET_NOT_FOUND` or `TRANSACTION_NOT_FOUND` | Fix the id |
| `409` | `IDEMPOTENCY_CONFLICT` (same key, other payload) or `WALLET_ALREADY_EXISTS` | Do not resend with that key |
| `422` | Business rejection: the body carries `status: REJECTED` and a `failureCode`; a replay answers `422` again | Final, do not resend |
| `503` + `Retry-After` | `TRANSIENT_FAILURE`: the database was unavailable or a deadlock occurred | Resend the same request |
| `500` | `INTERNAL_ERROR`: a bug, details are only in the server log | Report it |

```bash
docker compose up -d postgres ministack migrate && bun run start   # in one terminal
bun run poc:wagering                                                                      # in another
```

For `poc:reversals`, start the app with short retry timings so the worker acts within seconds:

```bash
PENDING_REFERENCE_POLL_MS=250 PENDING_REFERENCE_BACKOFF_BASE_MS=500 PENDING_REFERENCE_MAX_ATTEMPTS=4 bun run start
bun run poc:reversals
```

### Postman collection

`docs/wagering-ledger-service.postman_collection.json` has one request per status class of every endpoint (27 requests in four folders), each with a status assertion. Import it, keep `baseUrl` at `http://localhost:3000` and run the collection in order: the first request creates a fresh player, so it can be run repeatedly. For the `202` request to turn into `PROCESSED` within seconds, start the app with the short retry timings above.

### Reversals waiting for their reference

A REFUND or ROLLBACK whose referenced transaction has not arrived (or is itself still pending) is stored as `PENDING_REFERENCE`
and answers `202`. A background worker, running in every app instance, retries due rows with exponential backoff
(1s, 2s, 4s, ... capped at 5 min) up to 10 times; after that the transaction is `REJECTED` with `REFERENCE_NOT_FOUND`. Send the
same request (same `Idempotency-Key`) to read the settled result. The worker and the limits are set through the
`PENDING_REFERENCE_*` variables in `.env.example` (`PENDING_REFERENCE_WORKER=off` disables the worker in one instance).

### Queue consumer

Every instance long-polls `wager-transactions.fifo` and runs each `WagerTransactionRequested` message through the same
use case as `POST /wagering/transactions`. Send messages with `MessageGroupId` set to the wallet id, so the messages of one
wallet are applied in order, and an explicit `MessageDeduplicationId`.

| Outcome | What the consumer does |
|---|---|
| Processed, rejected, pending reference, or a message already processed | Deletes the message, only after the SQL transaction committed |
| Transient or unknown error | Keeps the message and hides it for a growing delay (1s, 2s, 4s, ... capped at 5 min); after `SQS_MAX_RECEIVE_COUNT` receives SQS moves it to the DLQ |
| Permanent error (not JSON, wrong `type`, invalid payload, unknown wallet, idempotency conflict, message id reused with another payload) | Sends it to `wager-transactions-dlq.fifo` with `ErrorCode` and `ErrorReason` attributes, then deletes it |

Redelivery is safe: the inbox row (`consumer_name`, `message_id`) is written in the same transaction as the ledger entry, so
a message delivered twice, or redelivered after a crash between commit and ack, has no second effect. On SIGTERM an instance
stops receiving, finishes the message it is handling, hands back the ones not started and, after
`SQS_SHUTDOWN_TIMEOUT_MS`, hands back anything unfinished at once. `SQS_CONSUMER=off` disables the consumer in one instance;
the other `SQS_*` variables are in `.env.example`. `bun run poc:consumer` (app running) sends messages with the AWS CLI and
shows each outcome.

### Event publication (outbox)

Every balance change, ledger entry and transaction status is written in one SQL transaction together with the integration
events it produces (`outbox_messages`). A worker running in every instance publishes them afterwards to the FIFO queue
`wager-events.fifo`, one event per SQL transaction, claimed with `FOR UPDATE SKIP LOCKED`; the message group is the wallet and
the deduplication id is the event id. The events are:

| Event | When |
|---|---|
| `WagerTransactionProcessed` | Any applied transaction, including `LOSS` |
| `WagerTransactionRejected` | A business rejection |
| `WalletBalanceChanged` | Only when the balance changes (also the opening credit) |
| `WagerTransactionPendingReference` | A reversal whose reference is missing |

What a consumer can rely on:

- **At-least-once.** An event can arrive twice (the process died after the send and before marking it published). Deduplicate by
  `eventId`; the queue already drops a repeat of the same id within five minutes.
- **Order per wallet.** A wallet's events are published in the order its changes were applied. A failed event waits for its
  backoff (1s, 2s, 4s, ... capped at 5 min) and the wallet's later events wait behind it. After 20 failed sends the event is
  parked and keeps holding its wallet; other wallets are not affected. A parked event is logged at error level.
- **Gaps are detectable.** The `walletVersion` of a wallet's `WalletBalanceChanged` events rises by one, and each `balanceBefore` is
  the previous `balanceAfter`.

To release a parked wallet, find the event and requeue it (the worker publishes it, then the events behind it):

```sql
select id, event_type, aggregate_id, attempts, failed_at from outbox_messages where failed_at is not null;
update outbox_messages set failed_at = null, attempts = 0, next_attempt_at = null where id = '<event id>';
```

`OUTBOX_WORKER=off` disables the publisher in one instance; the other `OUTBOX_*` variables are in `.env.example`.
`bun run poc:outbox` shows a crash before publishing, a repeated send and a parked event.

## Several instances

Any number of instances can run against the same database and queues; nothing is shared in memory. A wallet's lock
serializes its writers, `ON CONFLICT` makes duplicates replays, and every worker claims rows with `SKIP LOCKED`.

- `bun run poc:multi` runs three instances, applies a mixed load, kills one with SIGKILL and prints `balance == ledger` per wallet.
- `test/integration/multi-instance.test.ts` and `multi-instance-restart.test.ts` start separate processes, apply a seeded
  HTTP and SQS load (`LOAD_SEED=<n>` replays one), kill one or all of them mid-load and check, by SQL, that balances equal
  their ledgers, ledgers and event chains have no gaps, nothing is pending and the DLQ is empty.
- `test/integration/hot-wallet.test.ts` measures what a burst on one wallet costs other wallets (decision #62 in `PLAN.md`).
  A request waiting for a wallet lock holds a database connection, so size the pool with `DATABASE_POOL_MAX` (default 10).

## Logs

The app writes one JSON object per line to stdout (`LOG_LEVEL`, default `info`). Every request line carries `correlationId`
(the caller's `X-Correlation-Id`, or a generated one), and a submitted transaction adds `providerId`, `walletId`, `kind`,
`transactionId`, `status` and `failureCode`. A queue message produces the same line with its `messageId`. Probes on
`/health/*` are not logged.

Logs never carry amounts, balances, player ids, request bodies or error messages. The fields a line may contain are the
allowlist in `src/infrastructure/logging/log-fields.ts`; a key that is not listed is dropped, so logging more is a
deliberate edit there.

## Metrics

`GET /metrics` serves the Prometheus text format (public, like the health checks; it is not written to the request log).
Counters are per instance, so sum them across instances. The gauges are read from PostgreSQL and SQS at each scrape, so
every instance reports the same value; a gauge whose source is unreachable reads `NaN`.

| Metric | Meaning |
| --- | --- |
| `wagering_transactions_total{kind,status}` | transactions that reached a status (a pending reversal counts again when it settles) |
| `wagering_duplicates_total{source}` | deliveries that changed nothing: `idempotency_key` (replay) or `inbox` (message seen before) |
| `wagering_processing_seconds{result}` | histogram of the use case, including the wallet-lock wait; `result` is `settled`, `replay`, `duplicate_message` or `error` |
| `wagering_pending_reference_attempts_total` | attempts to resolve a reversal waiting for its reference |
| `wagering_message_retries_total`, `wagering_messages_dead_lettered_total` | queue messages left for redelivery, and sent to the DLQ as permanently invalid |
| `wagering_outbox_publish_failures_total{outcome}` | failed publish attempts; `parked` is the last one |
| `wagering_reconciliation_divergences_total` | reconciliations that found a balance different from the ledger |
| `wagering_outbox_pending_events`, `wagering_outbox_lag_seconds`, `wagering_outbox_parked_events` | events waiting, age of the oldest, and parked events (each holds its wallet's later events) |
| `wagering_dlq_messages` | messages waiting in the wager DLQ |
| `wagering_dependency_up{dependency}` | 1 when PostgreSQL or SQS answers the readiness probe |

Labels hold kinds, statuses and outcomes only, never wallet, player or provider ids. Lock conflicts and lock-wait time
arrive with the lock timeout (M10 step 3).

## Project layout

```
src/
  domain/          pure business rules, no framework or ORM imports (shared, wallet, transaction, messaging, events)
  application/     repository ports and use cases
  infrastructure/  database (MikroORM rows, mappers, repositories, migrations), messaging (SQS) and the background workers
  interfaces/      HTTP controllers and the SQS consumer
test/
  integration/     tests against real PostgreSQL and MiniStack
                   (unit tests are `*.spec.ts` next to the code they test)
  support/         test database setup and helpers
```
