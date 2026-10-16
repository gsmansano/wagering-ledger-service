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
| `bun run poc:schema` | Try to break each database constraint and show PostgreSQL refusing it (needs `docker compose up`; leaves no data) |
| `bun run typecheck` | Type-check with `tsc --noEmit` |
| `bun run migration:up` | Apply pending migrations |
| `bun run migration:down` | Revert the most recent migration |

Configuration is read from environment variables; see `.env.example`. The SQS emulator accepts any credentials, so the app falls back to placeholder ones (`test`/`test`) when `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are not set; they are never used against real AWS.

## HTTP API (so far)

Endpoints so far; the read endpoints, reconciliation and readiness arrive in the next M6 steps. Errors are `{ error, message }` with a stable code.

| Endpoint | Success |
|---|---|
| `POST /wallets` `{ playerId, initialBalance: { currency, amount? } }` | `201` wallet with balance and `version`; an omitted or `"0.00"` amount opens an empty wallet |
| `POST /wagering/transactions` with an `Idempotency-Key` header (unique per provider) and an optional `X-Correlation-Id` | the transaction view plus `idempotentReplay` (see below) |

The transaction view is `{ transactionId, providerId, externalTransactionId, walletId, kind, money, status, failureCode?, referenceExternalTransactionId?, balance?, createdAt, processedAt? }`; `balance` is the balance observed at settlement and is absent while the transaction is pending.

### Status codes

One table for every endpoint, so a provider can decide from the status alone:

| Status | Meaning | What the provider does |
|---|---|---|
| `200` / `201` | Processed (`201`: wallet created) | Nothing |
| `202` | `PENDING_REFERENCE`: a REFUND/ROLLBACK waiting for its reference | Resend the same request later, or wait |
| `400` | Invalid payload: `MALFORMED_REQUEST` (missing header, wrong type, unknown kind, id not a UUID) or `INVALID_PAYLOAD` (bad amount, `OPENING`, wrong player) | Fix it and send as a new request |
| `404` | `WALLET_NOT_FOUND` | Fix the id |
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

### Reversals waiting for their reference

A REFUND or ROLLBACK whose referenced transaction has not arrived (or is itself still pending) is stored as `PENDING_REFERENCE`
and answers `202`. A background worker, running in every app instance, retries due rows with exponential backoff
(1s, 2s, 4s, ... capped at 5 min) up to 10 times; after that the transaction is `REJECTED` with `REFERENCE_NOT_FOUND`. Send the
same request (same `Idempotency-Key`) to read the settled result. The worker and the limits are set through the
`PENDING_REFERENCE_*` variables in `.env.example` (`PENDING_REFERENCE_WORKER=off` disables the worker in one instance).

## Project layout

```
src/
  domain/          pure business rules, no framework or ORM imports (shared, wallet, transaction, messaging, events)
  application/     repository ports and use cases
  infrastructure/  database (MikroORM rows, mappers, repositories, migrations) and messaging (SQS)
  interfaces/      HTTP controllers and the SQS consumer
test/
  integration/     tests against real PostgreSQL and MiniStack
                   (unit tests are `*.spec.ts` next to the code they test)
  support/         test database setup and helpers
```
