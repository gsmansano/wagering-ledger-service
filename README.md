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
| `bun run typecheck` | Type-check with `tsc --noEmit` |
| `bun run migration:up` | Apply pending migrations |
| `bun run migration:down` | Revert the most recent migration |

Configuration is read from environment variables; see `.env.example`.

## Project layout

```
src/
  domain/          pure business rules, no framework or ORM imports
  application/     use cases
  infrastructure/  database (MikroORM, migrations) and messaging (SQS)
  interfaces/      HTTP controllers and the SQS consumer
test/
  integration/     tests against real PostgreSQL and MiniStack
  support/         test database setup and helpers
```
