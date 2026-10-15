# PLAN — Distributed Wagering Processor

Living document. Checkboxes and the decisions log are updated as work progresses.
Section references (§) point to the original requirements document.

## Decisions log

| #   | Decision | Why | Milestone |
| --- | -------- | --- | --------- |
| 1   | ORM: MikroORM | Preferred by the spec; explicit Unit of Work (`em.transactional()`) and `LockMode` fit the single-transaction write path. A forked `EntityManager` per request/message avoids stale Identity Map reads. Mappings live outside `src/domain`. | M0 |
| 2   | SQS emulator: MiniStack | Free, lightweight, no account token, so a clean clone runs with `docker compose up`. FIFO and DLQ behaviour to be verified in M1; LocalStack is the fallback. | M0 |
| 3   | Language: English for code, docs and commits | Matches existing docs and conventions; standard for technical work. | M0 |
| 4   | SQS queues created by the app at startup | `CreateQueue` is idempotent, so concurrent instances are safe; the same code path provisions queues in Compose, tests and local runs. | M1 |
| 5   | Migrations run by a one-shot `migrate` Compose service | App instances start only after it succeeds, so several instances never race to migrate the schema. | M1 |
| 6   | Tests use a separate `wagering_test` database, migrated once per run and truncated between tests | Commits are real, which the concurrency tests need (parallel requests on separate connections); rollback-per-test cannot exercise that. | M1 |
| 7   | Decimal library: `decimal.js` | Exact decimal arithmetic with string input/output, mapping directly to `NUMERIC(…, 2)` and the `"25.00"` contract. `Money` normalizes to scale 2. | M2 |

---

## M0 — Preflight

- [x] Working conventions and documentation structure (`CLAUDE.md`, `docs/devlog/`)
- [x] Toolchain verified (Bun 1.x, Docker Compose, git); repository initialized
- [x] Decisions logged: ORM (MikroORM vs TypeORM), SQS emulator (LocalStack vs MiniStack), documentation language

## M1 — Walking skeleton

- [x] NestJS on Bun with strict TypeScript; Docker Compose with PostgreSQL and the SQS emulator
- [x] ORM connected; reversible migrations; FIFO queue + DLQ provisioned on startup
- [x] `bun test` running unit and integration tests against real PostgreSQL; `GET /health/live`

**Done when:** a clean clone runs `docker compose up` and `bun test` green.

## M2 — Domain model — §6 _(current)_

- [ ] `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`
- [ ] `IntegrationEvent` hierarchy (4 events), `FailureCode` taxonomy, canonical payload hash
- [ ] Unit tests (§13); domain free of framework and ORM imports
- [ ] PoC: `bun run poc:domain` prints the domain rules in action (no Docker needed)

## M3 — Schema and persistence — §5.9

- [ ] Migrations for all tables, with uniqueness, non-negative balance and ledger immutability enforced by the database
- [ ] ORM mappings outside the domain; repository ports and adapters
- [ ] Integration tests proving each constraint and migration reversibility
- [ ] PoC: `psql` snippets that try to violate each constraint and show the database refusing them

## M4 — Core transaction processing — §7, §8

- [ ] Concurrency strategy chosen and logged
- [ ] `CreateWallet` (with OPENING entry) and `ProcessWagerTransaction` for BET/WIN/LOSS in a single SQL transaction: idempotency, payload conflict detection, wallet lock, ledger, outbox
- [ ] Concurrency tests: 50 parallel duplicates, the 100.00 vs 2 × 80.00 race, parallel wallets
- [ ] PoC: curl sequence: create a wallet, BET, duplicate BET, overdraft

## M5 — Reversals and out-of-order references — §7, §7.1

- [ ] REFUND / ROLLBACK rules, including the reversal-would-go-negative case
- [ ] `PENDING_REFERENCE` handling with a backoff worker and a terminal rejection after the retry limit
- [ ] Tests for every reversal rule and for references arriving late
- [ ] PoC: curl sequence: REFUND before its BET, then the BET, and the pending transaction resolves

## M6 — HTTP API — §9, §2

- [ ] All endpoints, including cursor-paginated ledger, reconciliation and readiness
- [ ] Consistent HTTP status mapping (logged); `Idempotency-Key` enforcement
- [ ] Authentication extension point (no-op guard) with the intended design documented
- [ ] End-to-end tests per endpoint and per status class
- [ ] PoC: Postman collection in `docs/` covering every endpoint

## M7 — SQS consumer and inbox — §10

- [ ] Consumer reusing the HTTP use case; persistent inbox dedup; ack only after commit
- [ ] Business / transient / permanent error handling with retry limit and DLQ; graceful SIGTERM
- [ ] Tests: redelivery, retry to DLQ, crash after commit and before ack
- [ ] PoC: Send a message with the AWS CLI against MiniStack and watch the ledger change

## M8 — Transactional outbox — §11

- [ ] Publisher safe under concurrent instances (`FOR UPDATE SKIP LOCKED`) with retry backoff
- [ ] Tests: concurrent publishers, crash between commit and publish
- [ ] PoC: Script that shows outbox rows being published and what happens after a crash

## M9 — Multi-instance and recovery — §8, §13

- [ ] Three or more instances under mixed load on shared wallets
- [ ] Restart mid-load with verified convergence; `balance == ledger` checked for every wallet
- [ ] PoC: Script that starts several instances, applies mixed load, kills one and prints the `balance == ledger` check

## M10 — Observability — §12

- [ ] Structured JSON logs with correlation fields and no sensitive payloads
- [ ] Metrics: status counts, duplicates, retries, DLQ, lock conflicts, outbox lag, latency
- [ ] Readiness reflecting PostgreSQL and SQS availability

## M11 — Documentation and final review — §14

- [ ] `README.md` (setup, commands, multi-instance run) and `ARCHITECTURE.md` (decisions, trade-offs, limitations)
- [ ] Final review of the transaction path

## M12 — Optional extras

- [ ] Load test (`bun run test:load`) with methodology and results
- [ ] External identity provider (Keycloak / Zitadel)
- [ ] Double-entry ledger

---

## Spec coverage

| Spec area                                     | Milestone             |
| --------------------------------------------- | --------------------- |
| Domain model (§6)                             | M2, M3                |
| Database-enforced invariants (§5.9)           | M3                    |
| BET / WIN / LOSS, idempotency, concurrency    | M4                    |
| REFUND / ROLLBACK, pending references (§7.1)  | M5                    |
| HTTP API (§9)                                 | M6                    |
| SQS processing (§10)                          | M7                    |
| Transactional outbox (§11)                    | M8                    |
| Multi-instance correctness (§8, §13)          | M9                    |
| Observability (§12)                           | M10                   |
| Documentation (§14)                           | M11                   |
| Authentication (§2)                           | M6 (stub), M12 (real) |
| Load test                                     | M12                   |
