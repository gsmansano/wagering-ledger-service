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
| 8   | `Wallet.debit`/`credit` change the balance and return the `WalletLedgerEntry` that records it | The balance and its ledger entry cannot be separated, so the invariant holds by construction. Ids and time are passed in (`entryId`, `now`) to keep the domain deterministic. `version` and `updatedAt` change only when the balance does. | M2 |
| 9   | Insufficient funds is signalled by throwing `InsufficientFundsError` (a `DomainError`) | Keeps `debit` simple (entry or exception); the use case catches it and rejects the transaction with `INSUFFICIENT_FUNDS`. Other domain violations (currency mismatch, non-positive amount) are plain `DomainError`s. | M2 |
| 10  | `WagerTransaction` transitions: `PENDING` → any; `PENDING_REFERENCE` → `PROCESSED`/`REJECTED`/`FAILED`; terminal states → nothing (throws `InvalidTransactionStateError`). `PENDING_REFERENCE` does not transition to itself; `reject`/`fail` take a timestamp. | Retry counting and backoff belong to the M5 worker, not the entity. Passing `at` keeps the clock out of the domain (as in #8) and makes `processedAt` the time the terminal state was reached. | M2 |
| 11  | Reference rules at creation: a `BET` or `OPENING` carrying a reference is an invalid payload (`create` throws, nothing is persisted); `REFUND`/`ROLLBACK` require one; `WIN`/`LOSS` may carry one, which is kept as information and never blocks processing (not resolved, not validated). `ledgerDirectionFor` throws for `LOSS`; cross-transaction reversal checks are deferred to M5. | Interpretation of the spec ("`WIN` can reference its `BET`"): a referenced win must not wait for a reference. `LOSS` has no ledger entry, so asking for its direction is a caller bug; callers check `affectsBalance()` first. To be noted in `ARCHITECTURE.md`. | M2 |
| 12  | `FailureCode` taxonomy of 11 codes (see `src/domain/transaction/failure-code.ts`). `REFERENCE_NOT_PROCESSED` applies only when the reference is `REJECTED` or `FAILED`; a `PENDING`, `PENDING_REFERENCE` or missing reference means wait. Encoded in `referenceReadiness()` with an exhaustive status switch. | Reversing an unfinished transaction must not fail early: it may still become `PROCESSED`. `PROCESSING_FAILED` is exclusive to `FAILED`. | M2 |
| 13  | Backoff is capped exponential without jitter (`min(1s × 2^(attempt−1), 5 min)`), as the shared pure function `exponentialBackoffMs`. An `OutboxMessage` is parked (`failedAt` set, never deleted) at the 20th failed publish attempt (about an hour of retrying); parked messages are neither pending nor due and can be requeued by an operator. | Jitter would need an injected random source and is unnecessary because each row is claimed by one publisher at a time. A bounded retry stops a poison event from retrying forever; parking keeps it auditable. Parked events become a metric in M10. Whether a parked event blocks later events of the same wallet is decided in M8. | M2 |
| 14  | Payload hash: SHA-256 (hex) of the canonical JSON (keys sorted recursively, no whitespace) of `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (normalized to scale 2) and `referenceExternalTransactionId` when present. The `Idempotency-Key` header and transport metadata are excluded. | Equal business payloads hash equally regardless of key order or `"25.5"` vs `"25.50"`; the key is what the hash is compared against, and metadata changes between deliveries. To be documented in `ARCHITECTURE.md`. | M2 |
| 15  | Integration events: `aggregateId` is the `walletId` on all four; the outbox row id is the event id; `data` carries `MoneyProps`, never `Money`. Ids and time arrive through an `EventContext`. | The wallet is the unit of ordering and concurrency; the event id gives consumers a deduplication key. | M2 |
| 16  | ORM mappings are `EntitySchema` files in `src/infrastructure`, with mapper functions that call `rehydrate`. No decorators on domain classes. | Keeps `src/domain` free of the ORM, as the spec requires, at the cost of some mapping code. | M3 |
| 17  | Ledger immutability is a row-level trigger that rejects `UPDATE` and `DELETE` on the ledger table. | Holds for any writer, including a manual `psql` session, unlike a privilege revoke that a superuser bypasses. `TRUNCATE` is not blocked, so the test truncate helper keeps working. | M3 |
| 18  | Ids are `uuid` columns; money is `NUMERIC(19,2)`. | Native types, exact decimals matching `Money` scale 2 and the `"25.00"` contract. | M3 |
| 19  | `wager_transactions` has a nullable `balance_after NUMERIC(19,2)`, filled when the transaction is processed or rejected. | A replay returns the original result including the balance observed then (§7 rule 7). `LOSS` and rejections have no ledger entry to derive it from. | M3 |
| 20  | The opening credit is a real `wager_transactions` row with `kind = OPENING`, a synthetic provider id (`SYSTEM`) and `externalTransactionId = walletId`. | Every column stays `NOT NULL` and the ledger foreign key to the transaction is uniform. Settles the M2 open question about the OPENING entry's transaction. | M3 |
| 21  | Persistence uses plain row types mapped with `EntitySchema`, plus mapper functions (`rehydrate` on the way in). Reads use `refresh: true`; writes are native `insert`/`nativeUpdate`. | Domain classes have private constructors and fields, so the ORM cannot map them. Keeps MikroORM features (`LockMode`, `transactional`) for M4. Native writes avoid Unit of Work surprises on the single-transaction write path. | M3 |
| 22  | Transactions go through a `UnitOfWork` port: `run(work: (repos) => Promise<T>)` hands the work repositories bound to one transaction. No ambient context. | Explicit and easy to test; a transaction-scoped `EntityManager` avoids stale Identity Map reads (decision #1). | M3 |
| 23  | Repository ports offer only what M3 and the next milestones plainly need (insert, finders, update, ledger append and keyset page). Row locking is added in M4 when the concurrency strategy is chosen. | Avoids deciding the concurrency strategy by accident through the port shape. | M3 |
| 24  | `WagerTransactionRepository` returns a `PersistedWagerTransaction { transaction, balanceAfter }` and `update` takes the observed balance. | `balance_after` (decision #19) is a replay value, not part of the `WagerTransaction` entity, whose spec signatures stay unchanged. | M3 |
| 25  | Concurrency strategy: pessimistic row lock. The wallet row is locked with `SELECT … FOR NO KEY UPDATE` and then read, as the first step that touches the balance, inside the single SQL transaction (amended in step 2, see below). One lock per wallet, no global lock. `CHECK (balance >= 0)` stays as the backstop. | A competing transaction on the same wallet waits, then sees the committed balance, so there is no lost update and no retry loop. Wallets are independent, so only a hot wallet serializes, and per-wallet ordering is wanted anyway. Easier to reason about and defend than optimistic retries. `version` still increments with the balance (spec §6.2) but is not used for concurrency control. Amendment: plain `FOR UPDATE` deadlocked two non-duplicate requests, because inserting the transaction row takes a `FOR KEY SHARE` lock on the wallet through the foreign key; both held it and each then waited for the other's `FOR UPDATE`. `FOR NO KEY UPDATE` still serializes writers but is compatible with that share lock; the key is never changed, so it is sufficient. Found by the mixed-spam test and pinned by a deterministic test. | M4 |
| 26  | Idempotency uses `INSERT … ON CONFLICT DO NOTHING` (`insertIfAbsent`) for the transaction row. A missing row back means another delivery owns the key: read it, compare payload hashes, then replay the stored result (same hash) or report a payload conflict (different hash). Wallet creation uses the same technique on `(player_id, currency)`. | A unique violation aborts a PostgreSQL transaction; `ON CONFLICT` keeps it usable. Concurrent duplicates block on the winner's uncommitted insert and then read its committed result. | M4 |
| 27  | `CreateWallet` takes `playerId`, `currency` and an optional `initialAmount` (default `0.00`; negative is rejected). A positive amount writes, in one transaction, the wallet, a `PROCESSED` `OPENING` transaction, one `CREDIT` ledger entry and a `WalletBalanceChanged` outbox event. A zero amount writes only the wallet: no `OPENING` row, no ledger entry, no event. `version` is 1 either way. Duplicate `(playerId, currency)` is a conflict. Amends decision #20: the `OPENING` row exists only when there is an opening credit (spec §9). | The ledger forbids zero-amount entries and every balance change needs an entry, so a zero opening has nothing to record. The wallet is created already holding its opening balance (`Wallet.open`), so `version` stays 1 as the spec example shows; the entry is built directly from balance 0. | M4 |
| 28  | `ProcessWagerTransaction` order: unlocked wallet read (existence only) → `insertIfAbsent` of the `PENDING` row → wallet lock (`FOR NO KEY UPDATE`, see #25) → ownership and currency checks on the locked row → apply → ledger entry → settle with `balance_after` → outbox events, all in one SQL transaction. Settled outcomes: `PROCESSED`, or `REJECTED` (`INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`), both persisted, returned (not thrown) and replayed unchanged. `BET`/`WIN` emit `WagerTransactionProcessed` + `WalletBalanceChanged`; `LOSS` only `WagerTransactionProcessed`; a rejection only `WagerTransactionRejected`. | The first read is an unlocked fast path for a clean `WalletNotFoundError`; correctness does not depend on it (the foreign key is the real guard), and ownership and currency are checked on the locked row. Wallet deletion is not supported by the schema (foreign keys and the immutable ledger block it for any wallet with history); closing an account is designed as a soft `status` checked under the lock (to be written in `ARCHITECTURE.md`). Locking after the idempotency insert means duplicates of a settled transaction never contend for the wallet lock. | M4 |
| 29  | Requests that persist nothing: unknown wallet (`WalletNotFoundError`), `OPENING` submitted from outside, a player who does not own the wallet and any invalid payload (`DomainError`), `REFUND`/`ROLLBACK` until M5 (`UnsupportedKindError`). The `WALLET_NOT_FOUND` failure code stays unused. | These are request errors the provider must fix, not business outcomes worth an audit row; the `wager_transactions.wallet_id` foreign key forbids a row without a wallet. | M4 |
| 30  | The same `(providerId, externalTransactionId)` under a different idempotency key is a replay when the payload hash matches and an `IdempotencyConflictError` when it differs; the same key with a different payload is always a conflict. | The provider's transaction id is the business identity; one debit is guaranteed either way by both unique indexes, and a provider that regenerates keys on retry does not see errors. | M4 |
| 31  | Minimal HTTP surface for M4: `POST /wallets` with `{ playerId, initialBalance: { currency, amount? } }` (spec shape, amount optional per #27) and `POST /wagering/transactions` with a required `Idempotency-Key` header. Provisional status mapping, finalized in M6: `400` structurally malformed (missing header, field absent or not a string, unknown `kind`), `404` unknown wallet, `409` duplicate wallet or idempotency conflict, `422` well-formed but invalid (amount, `OPENING`, wrong player, kind not supported yet). A business `REJECTED` is a `200` whose body carries `status` and `failureCode`; error bodies are `{ error, message }` with a stable code. One global `ApplicationErrorFilter` does the mapping. | Lets the PoC and the end-to-end tests run over real HTTP now, while the complete and consistent table (including rejection, pending and transient-failure statuses) is decided once in M6. | M4 |
| 32  | The idempotency key is unique per provider: `UNIQUE (provider_id, idempotency_key)` replaces the global constraint (new migration `ProviderScopedIdempotencyKey`; the applied core migration is not edited), and lookups by key take the provider id. | The key is chosen by the provider (spec §9: the header is the source of truth, recommended default `providerId:externalTransactionId`; the scope is not specified), so two providers may use the same string without colliding, and a conflict can no longer name another provider's transaction. | M4 |
| 33  | Ids are UUID v7 (`Bun.randomUUIDv7()` through `infrastructure/id-generator.ts`), as in the spec examples. `insertIfAbsent` names no conflict target, because PostgreSQL accepts one per statement and two rules (key, provider transaction id) must be covered; when a conflict is not explained by either lookup, `UnresolvedConflictError` is raised (a bug, mapped to 500 later), never treated as a replay. | Matches the specification and gives index locality. The typed error replaces a generic one, so an unexpected unique rule (for example a repeated internal id, or the reversal index in M5) fails loudly and testably. | M4 |
| 34  | A wallet's ledger has an explicit order: `ledger_entries.sequence` (1, 2, 3 ... per wallet), assigned by `LedgerRepository.append` as `max + 1` while the wallet lock is held, with `UNIQUE (wallet_id, sequence)` and `CHECK (sequence > 0)`. Statements and keyset paging use it (`page(walletId, { afterSequence, limit })` returns `LedgerRecord { entry, sequence }`); the old `(created_at, id)` index is dropped. The domain entry is unchanged; the sequence is a persistence concern. Existing rows are numbered by `(created_at, id)` in the migration, which switches the immutability trigger off for that backfill only. | Timestamps have millisecond precision and the old tie-break was a random id, so two entries of one wallet in the same millisecond could be listed against the order they were applied in (reproduced with a frozen clock: the first listed entry had `balance_before` 940.00). The ledger is the audit trail of the order actually applied, and the outcome of concurrent requests depends on that order. A forgotten lock fails on the unique constraint instead of silently duplicating. | M4 |
| 35  | Only `InvalidInputError` (a `DomainError` subclass raised for caller-supplied input: malformed amount or currency, empty identifier, reference rules at creation, `OPENING` from outside, a player who does not own the wallet) maps to `422 INVALID_PAYLOAD`. Any other error, including a plain `DomainError` such as an invalid state transition, `UnresolvedConflictError` and `WalletVersionConflictError`, is a bug and answers `500` without leaking its message. | Spec §6.3 calls an invalid transition a programming error, not a business path; reporting it as the provider's fault would hide bugs from 5xx monitoring. | M4 |
| 36  | A transaction is reversed at most once, by any kind: a second REFUND or ROLLBACK of the same reference is rejected with `ALREADY_REVERSED`. Enforced by a partial unique index on `reference_transaction_id` over `PROCESSED` reversals (new migration; the applied one is not edited). | Spec §7 rule 4 only forbids the same kind twice, which would let a BET be both REFUNDed and ROLLBACKed, crediting the player twice. The spec leaves the point open and asks for added interpretations to be documented; the stricter reading protects the money. A chain still works (BET → REFUND → ROLLBACK of the REFUND). To be noted in `ARCHITECTURE.md`. | M5 |
| 37  | A reversal that would make the balance negative (a ROLLBACK of a WIN already spent) is rejected with `REVERSAL_WOULD_OVERDRAW`: persisted, audited, final, emits `WagerTransactionRejected`. | Spec §7 rule 9: distinct from `INSUFFICIENT_FUNDS` because the cause is operationally different (a reversal of money already spent vs. a bet without funds). The non-negative balance is never relaxed. | M5 |
| 38  | A reference that exists is judged at first sight, and a final failure rejects at once: other provider/player/wallet/currency/round → `REFERENCE_MISMATCH`; kind not reversible by this kind → `INVALID_REFERENCE_KIND`; `REJECTED`/`FAILED` reference → `REFERENCE_NOT_PROCESSED`; amount differs → `AMOUNT_MISMATCH`; already reversed → `ALREADY_REVERSED`. Only a missing, `PENDING` or `PENDING_REFERENCE` reference waits (decision #12). | Waiting cannot fix a mismatch; only an in-flight or not-yet-arrived reference can still become valid. | M5 |
| 39  | Pending references are retried up to 10 attempts with `exponentialBackoffMs` (1s, 2s, 4s … capped at 5 min, about 15 minutes in total), then rejected with `REFERENCE_NOT_FOUND` and `WagerTransactionRejected`. Limit and poll interval are configurable. | Covers an out-of-order delivery within a provider session and stays bounded for an orphaned reversal. | M5 |
| 40  | A pending reversal is resolved by the worker's backoff, under the same wallet lock and apply path as a first attempt; arrival of the reference does not trigger it eagerly. | Keeps one code path and no cross-transaction wake-up; the cost is a delay of up to the current backoff interval. | M5 |
| 41  | A transaction left `PENDING_REFERENCE` answers `202` with `status: PENDING_REFERENCE` (provisional, finalized in M6). | The provider must not treat it as final nor resend it as new; the same key later returns the settled result. | M5 |
| 42  | The worker claims one due row per SQL transaction with `SELECT … FOR UPDATE SKIP LOCKED` and retries it in that same transaction; lock order is always the pending row, then the wallet. A direct retry (`execute(id)`) also locks the row first. Polling interval, batch size, retry limit and backoff are environment variables (`PENDING_REFERENCE_*`); the worker runs in every instance and can be switched off per instance. | `SKIP LOCKED` lets instances share the table without waiting for or duplicating each other; claiming and retrying in one transaction means a crash releases the row untouched. A fixed lock order rules out a deadlock between a worker (holding the row) and another retry (holding the wallet), and makes the status read after the row lock authoritative. | M5 |

| 43  | One status table for every endpoint, applied by a single global filter: `200` processed; `201` wallet created; `202` `PENDING_REFERENCE` (resend the same key or poll); `400` any invalid payload, whether structurally malformed (`MALFORMED_REQUEST`) or well-formed but invalid (`INVALID_PAYLOAD`: amount, `OPENING`, wrong player), including an id that is not a UUID; `404` unknown wallet or transaction; `409` idempotency conflict or duplicate wallet (never resend with that key); `422` business rejection (final, do not resend); `503` + `Retry-After` transient infrastructure failure (resend the same key); `500` bug, message never leaked. A rejection answers `422` with the transaction view (`status: REJECTED`, `failureCode`, `balance`), and a replay of it answers `422` again with `idempotentReplay: true`. A stored `FAILED` or `PENDING` transaction (not reachable over HTTP until M7) answers `500`. Amends #31 (rejection was `200`, invalid payload `422`) and the status named in #35. | Spec §9: invalid payload, idempotency conflict, business rejection, pending acceptance and transient failure must be distinguishable by status, consistently across endpoints, so a provider decides to fix, stop, wait or resend without reading messages. `422` is reserved for "a valid request the business refused", so each status is one provider action. | M6 |
| 44  | Transient failures are recognized by `isTransientDatabaseError`: PostgreSQL classes `08` (connection), `40001`/`40P01` (serialization failure, deadlock), `53300` (too many connections), `55P03` (lock not available), `57P01`/`57P03` (shutdown, not accepting connections), Node socket errors (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`) and a pool timeout, looking through `cause`. Anything else unknown stays `500`. M10's `lock_timeout` raises `55P03`, so it needs no new mapping. | A wrong guess in either direction is costly: `503` for a bug makes providers retry forever, `500` for an outage hides it from monitoring. A closed list of known codes errs toward `500`. | M6 |
| 45  | Transactions have one response shape, `TransactionView`: `transactionId`, `providerId`, `externalTransactionId`, `walletId`, `kind`, `money`, `status`, `failureCode?`, `referenceExternalTransactionId?`, `balance?` (the balance observed at settlement; absent while pending), `createdAt`, `processedAt?`. `POST` adds `idempotentReplay`. An optional `X-Correlation-Id` header becomes the use case's `correlationId`. | A superset of the spec's example response; one shape lets a provider handle POST and GET alike. The correlation id is part of the §12 log fields and costs one header. | M6 |
| 46  | Ledger pages are keyed by sequence: `GET /wallets/:id/ledger?cursor=&limit=` returns `{ entries, nextCursor }`; the cursor is base64url of `{ sequence }`, `limit` defaults to 50 with a maximum of 200, and a malformed cursor is `400 INVALID_CURSOR` and a bad `limit` is `400 MALFORMED_REQUEST`. The cursor is not signed. | The per-wallet sequence (#34) is a stable total order, simpler and cheaper than the `(created_at, id)` pair, and unaffected by concurrent inserts. A tampered cursor only changes the page position and exposes nothing the caller could not read anyway. | M6 |
| 47  | `POST /wallets/:id/reconciliation` compares `wallets.balance` with the signed sum of the wallet's ledger in a single SQL statement (one snapshot, no lock) and answers `200` with the spec shape (`storedBalance`, `calculatedBalance`, `difference`, `consistent`, `checkedEntries`). A divergence is logged at error level and flagged in the response, never corrected; the metric arrives in M10. | A single statement sees one consistent snapshot, so a concurrent write cannot create a false divergence, and a read-only check must not queue behind hot wallets. | M6 |
| 48  | `GET /health/ready` runs `select 1` on PostgreSQL and a lightweight SQS call, each with a 2 s timeout; `200` when both answer, otherwise `503` naming the failing check. `/health/live` and `/health/ready` are public. | Spec §9 and §12: liveness and readiness are separate checks, and health endpoints never require authentication. | M6 |
| 49  | Authentication is a global `AuthGuard` that allows everything, plus a `@Public()` marker on the health endpoints. The intended design: an external identity provider (Keycloak or Zitadel) issues client-credential tokens, one client per provider; the guard validates the token and exposes the provider identity; the use cases reject a request whose `providerId` differs from the token's. Written in `ARCHITECTURE.md` at M11. | Spec §2: authentication earns no points, but the extension point must be explicit in the code and the decision documented. | M6 |

| 50  | Reads answer `200` with the stored resource whatever its status (a `REJECTED` or `PENDING_REFERENCE` transaction is returned as it is, with `status` and `failureCode` in the body); only submitting a transaction maps a rejection to `422`. Unknown transaction is `404 TRANSACTION_NOT_FOUND`. The by-provider lookup is scoped by provider, so another provider's identifier never matches. Reads run through small query classes in `src/application/query/`. | `422` describes the outcome of a request, and a read request succeeded. A provider polling a pending transaction must be able to read its state without it looking like an error. | M6 |

| 51  | Inbox dedup is `INSERT … ON CONFLICT DO NOTHING` (`InboxRepository.insertIfAbsent`), the first statement of the use case's own SQL transaction, requested through an optional `inbox: { consumerName, messageId }` argument of `ProcessWagerTransaction.execute`. The row is written already processed, so it exists only if the business change committed. A duplicate `(consumerName, messageId)` returns `{ duplicateMessage: true }` and the consumer acks it. The same message id with a different payload hash raises `InboxPayloadConflictError` (permanent). HTTP callers pass no inbox, so the use case stays shared. | A unique violation aborts a PostgreSQL transaction (#26), and a separate wrapper transaction would need ambient context (#22). Writing the row processed removes an update and any window where a received but unprocessed row could exist. | M7 |
| 52  | Error classes for a message: **business** (`REJECTED`, `PENDING_REFERENCE`, replays) are final results, ack. **Transient** (database outage or deadlock, #44) and **unknown** errors are handled alike (only the log line differs): not acked, retried through the visibility timeout, `exponentialBackoffMs(receiveCount)`; an unknown error that keeps failing reaches the DLQ through the redrive policy (`maxReceiveCount`). **Permanent** (unparseable body, wrong `type`, invalid envelope or payload, `InvalidInputError`, `WalletNotFoundError`, `IdempotencyConflictError`, `InboxPayloadConflictError`) are never retried. | Retrying cannot fix a permanent error, and acking it would lose it. An unknown error is more likely a bug than bad input, so it gets the bounded retries before parking. | M7 |
| 53  | A permanent error is sent to the DLQ explicitly (the original body plus the error code and message as message attributes) and then deleted from the main queue; if the explicit send fails, the message is left untouched and the redrive policy still applies. | Waiting for `maxReceiveCount` receives on input that can never succeed wastes work and blocks the wallet's FIFO group meanwhile (#54). The extra code path is tested on its own. | M7 |
| 54  | Messages are sent with `MessageGroupId = walletId`. A failing message blocks its group until it succeeds or reaches the DLQ; other wallets proceed. To be written in `ARCHITECTURE.md`. | Messages of one wallet are processed in order and wallets in parallel, matching the unit of concurrency. Blocking the group is the intended FIFO behaviour and a poison message leaves quickly through #53. | M7 |
| 55  | Each instance long-polls up to 10 messages and processes them concurrently (`SQS_CONSUMER_CONCURRENCY`); the consumer can be switched off per instance. On SIGTERM it stops receiving, waits for the message being handled and hands back the ones not started, and after `SQS_SHUTDOWN_TIMEOUT_MS` resets the visibility of any unfinished message to 0. | Every instance consumes (§8); unfinished messages return to the queue at once instead of waiting out the visibility timeout. | M7 |

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

## M2 — Domain model — §6

- [x] `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`
- [x] `IntegrationEvent` hierarchy (4 events), `FailureCode` taxonomy, canonical payload hash
- [x] Unit tests (§13); domain free of framework and ORM imports
- [x] PoC: `bun run poc:domain` prints the domain rules in action (no Docker needed)

## M3 — Schema and persistence — §5.9

- [x] Migrations for all tables, with uniqueness, non-negative balance and ledger immutability enforced by the database
- [x] ORM mappings outside the domain; repository ports and adapters
- [x] Integration tests proving each constraint and migration reversibility
- [x] PoC: `bun run poc:schema` runs `psql` snippets that try to violate each constraint and shows the database refusing them

## M4 — Core transaction processing — §7, §8

- [x] Concurrency strategy chosen and logged
- [x] `CreateWallet` (with OPENING entry) and `ProcessWagerTransaction` for BET/WIN/LOSS in a single SQL transaction: idempotency, payload conflict detection, wallet lock, ledger, outbox
- [x] Concurrency tests: 50 parallel duplicates, the 100.00 vs 2 × 80.00 race, parallel wallets
- [x] PoC: `bun run poc:wagering` runs a curl sequence: create a wallet, BET, duplicate BET, overdraft, 30 parallel duplicates, ledger

## M5 — Reversals and out-of-order references — §7, §7.1

- [x] REFUND / ROLLBACK rules, including the reversal-would-go-negative case
- [x] `PENDING_REFERENCE` handling with a backoff worker and a terminal rejection after the retry limit
- [x] Tests for every reversal rule and for references arriving late
- [x] PoC: `bun run poc:reversals` runs a curl sequence: REFUND before its BET, then the BET, and the pending transaction resolves

## M6 — HTTP API — §9, §2

- [x] Step 1: status table applied by one filter (decisions #43, #44), shared `TransactionView` and `X-Correlation-Id` (#45); tests per status class
- [x] Step 2: `GET` wallet, transaction by id, transaction by provider and external id, and the cursor-paginated ledger (#46)
- [x] Step 3: reconciliation (#47), readiness (#48), no-op `AuthGuard` with the intended design documented (#49)
- [x] Step 4: end-to-end tests per endpoint and per status class (`http-contract.test.ts`)
- [x] PoC: Postman collection in `docs/` covering every endpoint

## M7 — SQS consumer and inbox — §10

- [x] Consumer reusing the HTTP use case; persistent inbox dedup; ack only after commit
- [x] Business / transient / permanent error handling with retry limit and DLQ; graceful SIGTERM
- [x] Tests: redelivery, retry to DLQ, crash after commit and before ack
- [x] PoC: Send a message with the AWS CLI against MiniStack and watch the ledger change

## M8 — Transactional outbox — §11 _(current)_

- [ ] Publisher safe under concurrent instances (`FOR UPDATE SKIP LOCKED`) with retry backoff
- [ ] Tests: concurrent publishers, crash between commit and publish
- [ ] PoC: Script that shows outbox rows being published and what happens after a crash

## M9 — Multi-instance and recovery — §8, §13

- [ ] Three or more instances under mixed load on shared wallets
- [ ] Restart mid-load with verified convergence; `balance == ledger` checked for every wallet
- [ ] Hot-wallet experiment: more distinct requests on one wallet than the connection pool holds; measure how long requests for other wallets wait, and record the result as a documented limit
- [ ] PoC: Script that starts several instances, applies mixed load, kills one and prints the `balance == ledger` check

## M10 — Observability — §12

- [ ] Structured JSON logs with correlation fields and no sensitive payloads
- [ ] Metrics: status counts, duplicates, retries, DLQ, lock conflicts, outbox lag, latency, reconciliation divergences (§9 asks for them to be counted)
- [ ] Readiness (built in M6, decision #48) exposed as a metric as well; every log line carries `correlationId` (set from `X-Correlation-Id` in M6)
- [ ] Explicit connection pool size and a `lock_timeout` on the wallet lock, answered with a retryable status; lock-wait time as a metric (review finding M-2)

## M11 — Documentation and final review — §14

- [ ] `README.md` (setup, commands, multi-instance run) and `ARCHITECTURE.md` (decisions, trade-offs, limitations)
- [ ] `ARCHITECTURE.md` states the ordering semantics: concurrent requests on one wallet are applied in lock-acquisition order, not arrival order, and the ledger records the order actually applied; a provider that needs A before B must wait for A's response
- [ ] `ARCHITECTURE.md` documents the authentication decision: no-op guard now, the intended identity-provider design (decision #49) and the provider-identity check
- [ ] `ARCHITECTURE.md` documents the HTTP status table (decision #43) and the added interpretations (rule 4, decision #36)
- [ ] Final review of the transaction path
- [ ] `ARCHITECTURE.md` limitations name the hot-wallet behaviour: requests queued on one wallet each hold a connection, so a large burst on one wallet can delay others until the pool is tuned or the load is spread (SQS groups per wallet, scaling out)

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
