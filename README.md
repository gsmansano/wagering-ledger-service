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
| `bun run poc:schema` | Try to break each database constraint and show PostgreSQL refusing it (needs `docker compose up`; leaves no data) |
| `bun run typecheck` | Type-check with `tsc --noEmit` |
| `bun run migration:up` | Apply pending migrations |
| `bun run migration:down` | Revert the most recent migration |

Configuration is read from environment variables; see `.env.example`. The SQS emulator accepts any credentials, so the app falls back to placeholder ones (`test`/`test`) when `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are not set; they are never used against real AWS.

## HTTP API (so far)

Minimal endpoints of M4; the full API and its status table arrive in M6.

| Endpoint | Success | Errors |
|---|---|---|
| `POST /wallets` `{ playerId, initialBalance: { currency, amount? } }` | `201` wallet with balance and `version`; an omitted or `"0.00"` amount opens an empty wallet | `400` malformed body, `409 WALLET_ALREADY_EXISTS`, `422 INVALID_PAYLOAD` |
| `POST /wagering/transactions` with an `Idempotency-Key` header (unique per provider) | `200` `{ transactionId, status, failureCode?, balance, idempotentReplay }` for `PROCESSED` and for a business `REJECTED` (see `failureCode`) | `400` missing header or malformed body, `404 WALLET_NOT_FOUND`, `409 IDEMPOTENCY_CONFLICT`, `422` (`INVALID_PAYLOAD`, `UNSUPPORTED_KIND` for REFUND/ROLLBACK until M5) |

```bash
docker compose up -d postgres ministack migrate && bun run start   # in one terminal
bun run poc:wagering                                                                      # in another
```

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
