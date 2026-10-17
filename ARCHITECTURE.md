# Architecture

Design decisions, trade-offs and known limitations of the wagering ledger service. Numbers in parentheses (`#25`) refer to the decisions log in [`PLAN.md`](PLAN.md), which records the alternatives that were weighed. Setup and commands are in [`README.md`](README.md).

## 1. Shape of the system

The service keeps a wallet per player and currency and applies BET, WIN, LOSS, REFUND and ROLLBACK operations to it. Operations arrive over HTTP and over an SQS FIFO queue and go through the same use case. Every balance change is recorded in an append-only ledger, and every change is announced to other systems through a transactional outbox.

```
src/
  domain/          rules and invariants; no NestJS, no ORM
  application/     use cases and the ports they need (repositories, unit of work, metrics, event publisher)
  infrastructure/  MikroORM rows, mappers, repositories, migrations; SQS adapters; background workers
  interfaces/      HTTP controllers, the SQS consumer, the error filter
```

- **Domain.** `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage` and the integration events. Constructors are private and entities are built through static factories (`create`, `open`, `from`, `rehydrate`); `rehydrate` does not re-validate, because stored rows were validated when they were written. A state change that is not allowed throws, so an entity cannot be put in an invalid state from outside.
- **Application.** One class per use case (`CreateWallet`, `ProcessWagerTransaction`, `ResolvePendingReference`, `PublishOutbox`, `ReconcileWallet` and the queries). Use cases talk to ports; `UnitOfWork.run(work)` hands the work repositories bound to one SQL transaction, with no ambient context (#22).
- **Infrastructure.** The ORM is confined here. Mappings are `EntitySchema` files over plain row types, with mapper functions that call `rehydrate` (#16, #21). Domain classes carry no decorators.
- **Interfaces.** Controllers parse and validate the transport shape, call a use case and let one global filter turn errors into statuses.

The dependency direction is interfaces and infrastructure towards application towards domain. The domain imports nothing outside itself.

## 2. Money

Money is never a `number`. In code it is `Money`, built on `decimal.js` and normalized to scale 2 (#7); in the database it is `NUMERIC(19,2)` (#18); in contracts it is a decimal string such as `"25.00"`. A malformed amount or a currency mismatch is rejected when the value is built, so arithmetic on `Money` cannot silently mix currencies or lose precision. Amounts in a currency other than the wallet's are rejected with `CURRENCY_MISMATCH`.

## 3. Invariants and where they are enforced

The rules that matter for money are enforced by PostgreSQL as well as by the code, so that a bug, a second writer or a manual session cannot break them.

| Invariant | Enforcement |
|---|---|
| Balance is never negative | `CHECK (balance >= 0)` on `wallets`, besides `Wallet.debit` |
| One wallet per player and currency | unique index on `(player_id, currency)` |
| A provider transaction is applied once | `UNIQUE (provider_id, external_transaction_id)` |
| An idempotency key is used once per provider | `UNIQUE (provider_id, idempotency_key)` (#32) |
| A message is handled once per consumer | primary key `(consumer_name, message_id)` on the inbox |
| A transaction is reversed at most once | partial unique index on `reference_transaction_id` over `PROCESSED` reversals (#36) |
| The ledger is immutable | row-level trigger rejecting `UPDATE` and `DELETE` (#17) |
| A wallet's ledger has one explicit order | `ledger_entries.sequence`, `UNIQUE (wallet_id, sequence)` (#34) |
| A wallet's events have one explicit order | `outbox_messages.sequence`, an identity column (#60) |

The immutability trigger was chosen over revoking privileges because a superuser bypasses privileges and nobody bypasses a trigger without altering it. `TRUNCATE` is not blocked; the test helper relies on that. Each constraint has an integration test that tries to violate it, and `bun run poc:schema` shows PostgreSQL refusing each one.

Ids are UUID v7 (#33), which keeps index locality while staying globally unique.

## 4. The write path

Applying a transaction is one SQL transaction (#28). In order:

1. An unlocked read of the wallet, for existence only, so an unknown wallet answers a clean `404`.
2. `INSERT … ON CONFLICT DO NOTHING` of the transaction as `PENDING` (see section 6). If another delivery owns the key, the stored result is replayed or a payload conflict is reported, and the wallet is never touched.
3. The wallet is locked with `SELECT … FOR NO KEY UPDATE`.
4. Ownership and currency are checked on the locked row.
5. The rules are applied: `Wallet.debit` or `credit` changes the balance and returns the ledger entry that records it (#8), so the two cannot be separated.
6. The ledger entry is appended with the next `sequence`.
7. The transaction is settled (`PROCESSED` or `REJECTED`) with the observed `balance_after` (#19), so a replay returns the original balance.
8. The outbox events are inserted.
9. For a queue message, the inbox row is written (as the first statement, see section 6).

Commit makes all of it visible at once. Events are written inside the transaction but published by a separate worker after the commit, so an event never describes a change that was rolled back.

Business outcomes that are final (`PROCESSED`, and `REJECTED` for insufficient funds, currency mismatch and the reversal rules) are stored, so they can be audited and replayed unchanged. Requests the provider must correct (unknown wallet, wrong player, malformed input) store nothing (#29).

## 5. Concurrency

**Strategy: a pessimistic row lock per wallet** (#25). The wallet row is locked before the balance is read, so a competing transaction on the same wallet waits, then sees the committed balance. There is no lost update and no retry loop.

Alternatives weighed:

- *Optimistic locking with a bounded retry* would need a retry policy, and under a hot wallet it wastes work on conflicts that a queue would resolve in order.
- *A conditional atomic update* (`UPDATE … SET balance = balance - x WHERE balance >= x`) protects the balance but not the ledger sequence, the outbox order or the reversal rules, which read several rows.

Properties:

- The unit of concurrency is the wallet. Different wallets never wait for each other; there is no global lock. The system is correct with any number of instances because all coordination happens in PostgreSQL.
- `FOR NO KEY UPDATE` rather than `FOR UPDATE`: inserting the transaction row takes a `FOR KEY SHARE` lock on the wallet through the foreign key, and two requests holding that share lock and asking for `FOR UPDATE` deadlock each other. `FOR NO KEY UPDATE` still serializes writers and is compatible with the share lock. This was found by a concurrent test and is pinned by a deterministic one.
- The lock is taken after the idempotency insert, so duplicates of a settled transaction never contend for it.
- `CHECK (balance >= 0)` stays as the backstop: if the locking were ever forgotten, the database would still refuse a negative balance, and the unique `(wallet_id, sequence)` would refuse a ledger that forks.
- The total wait for the lock is bounded by `WALLET_LOCK_TIMEOUT_MS` and answered with a retryable `503` (#65).

Tests that cover this run against real PostgreSQL with separate connections: 50 parallel duplicates, the race of one 100.00 balance against two 80.00 bets, parallel wallets, and the multi-process tests with random kills.

### Ordering semantics

Concurrent requests on one wallet are applied in **lock-acquisition order, not arrival order**. The ledger records the order that was actually applied, and `sequence` makes that order explicit, so the ledger and the events of a wallet always agree with each other. A provider that needs operation A applied before operation B must wait for A's response before sending B. Over SQS, messages of one wallet share a `MessageGroupId`, which gives that guarantee without the provider waiting. Exact balances under concurrent load therefore depend on the order the lock was granted; what the tests assert is the invariants (balance equals ledger, no gaps, no duplicates), not a particular interleaving.

## 6. Idempotency

Idempotency is persisted and never held in memory (#26, #30, #32).

- **HTTP.** The `Idempotency-Key` header is required and unique per provider. The transaction row is inserted with `ON CONFLICT DO NOTHING`: a unique violation would abort the PostgreSQL transaction, while `DO NOTHING` keeps it usable. When no row comes back, another delivery owns the key; the row is read and its payload hash compared with the new request's. Same hash: the stored result is replayed (`idempotentReplay: true`). Different hash: `409 IDEMPOTENCY_CONFLICT`. Concurrent duplicates block on the winner's uncommitted insert and then read its committed result.
- **Payload hash.** SHA-256 of the canonical JSON of the business fields: keys sorted recursively, money normalized so `"25.5"` and `"25.50"` hash equally, and the key and transport metadata excluded (#14).
- **Provider identity.** The same `(providerId, externalTransactionId)` under a different key is a replay when the payload matches and a conflict when it differs (#30), so a provider that regenerates keys on retry does not see errors and still cannot debit twice.
- **Queue.** A message is deduplicated by an inbox row `(consumer_name, message_id)` inserted with `ON CONFLICT DO NOTHING` as the first statement of the same SQL transaction, written already processed (#51). The row therefore exists only if the business change committed, and a message redelivered after a crash between commit and ack has no second effect. The same message id with a different payload hash is a permanent error.
- **Wallet creation** uses the same technique on `(player_id, currency)`.

## 7. Reversals and the interpretations added to the specification

REFUND and ROLLBACK reference an earlier transaction and credit back what it moved. The rules are decided when the reference is first seen (#38): another provider, player, wallet, currency or round gives `REFERENCE_MISMATCH`; a kind this reversal cannot undo gives `INVALID_REFERENCE_KIND`; a `REJECTED` or `FAILED` reference gives `REFERENCE_NOT_PROCESSED`; a different amount gives `AMOUNT_MISMATCH`. Only a missing, `PENDING` or `PENDING_REFERENCE` reference waits, because only an in-flight reference can still become valid.

A waiting reversal is stored as `PENDING_REFERENCE` and answers `202`. A worker in every instance retries it with exponential backoff, claiming rows with `FOR UPDATE SKIP LOCKED` so instances neither wait for nor duplicate each other (#42). After 10 attempts (about 15 minutes) it is rejected with `REFERENCE_NOT_FOUND` (#39). The retry runs under the same wallet lock and apply path as a first attempt (#40), with a fixed lock order (the pending row, then the wallet) that rules out deadlock between a worker and a direct retry.

Interpretations where the specification is open or ambiguous:

- **A transaction is reversed at most once, by any kind** (#36). Rule 4 of the specification only forbids the same kind twice, which would let a BET be both REFUNDed and ROLLBACKed and credit the player twice. The stricter reading is enforced by a partial unique index. A chain still works (BET, REFUND, then ROLLBACK of the REFUND).
- **A reversal that would overdraw is rejected** (#37) with `REVERSAL_WOULD_OVERDRAW`, distinct from `INSUFFICIENT_FUNDS` because the operational cause differs (reversing money already spent). It is persisted, final, and the balance is never allowed to go negative.
- **References on WIN and LOSS** are kept as information and never block processing (#11); `BET` and `OPENING` with a reference are invalid.
- **Opening balance.** A positive initial amount writes the wallet, a `PROCESSED` `OPENING` transaction, one credit entry and an event in one transaction; a zero amount writes only the wallet (#27).
- **Payload hash fields** are the business fields listed in section 6 (#14).

## 8. HTTP contract

One status table for every endpoint, applied by a single global filter (#43), so a provider decides to fix, stop, wait or resend from the status alone.

| Status | Meaning | Provider action |
|---|---|---|
| `200` / `201` | Processed / wallet created | none |
| `202` | `PENDING_REFERENCE` | resend the same key or poll |
| `400` | invalid payload (`MALFORMED_REQUEST`, `INVALID_PAYLOAD`, `INVALID_CURSOR`) | fix and send as new |
| `404` | unknown wallet or transaction | fix the id |
| `409` | idempotency conflict, duplicate wallet | never resend with that key |
| `422` | business rejection, with `status: REJECTED` and `failureCode` | final, do not resend |
| `503` + `Retry-After` | transient infrastructure failure, including a wallet-lock timeout | resend the same key |
| `500` | bug; the message is never leaked | report it |

Notes on the choices:

- `422` is reserved for a valid request the business refused. Reads (`GET`) answer `200` with the stored resource whatever its status, because the read itself succeeded (#50). A replay of a rejection answers `422` again.
- A transient failure is recognized from a closed list of PostgreSQL error classes and socket errors (#44). A wrong guess is costly in both directions: `503` for a bug makes providers retry forever, `500` for an outage hides it from monitoring, so unknown errors stay `500`.
- Only an error raised for caller-supplied input (`InvalidInputError`) is a `400`. Any other domain error, such as an invalid state transition, is a bug and answers `500` (#35).
- One response shape, `TransactionView`, serves submit and read (#45). An optional `X-Correlation-Id` header becomes the correlation id of the request log line and of the events it writes.
- Ledger pages use a cursor over the per-wallet `sequence` (#46). The cursor is not signed; tampering only moves the page position.
- Reconciliation compares the stored balance with the signed sum of the ledger in a single SQL statement, so it sees one snapshot and a concurrent write cannot produce a false divergence (#47). A divergence is flagged and logged, never corrected.
- Liveness and readiness are separate; readiness checks PostgreSQL and SQS with a 2 s timeout each (#48).

## 9. Authentication

Authentication is not implemented. A global `AuthGuard` allows every request, and health endpoints are marked `@Public()`, so the extension point is explicit in the code (#49).

The intended design:

1. An external identity provider (Keycloak or Zitadel) issues client-credential tokens, one client per game provider.
2. The guard validates the token (signature, expiry, audience) and attaches the provider identity to the request.
3. Use cases reject a request whose `providerId` differs from the token's identity, so one provider cannot read or write another's transactions. Idempotency keys and transaction lookups are already scoped by provider (#32, #50).
4. Queue messages are authenticated by IAM on the queue rather than by the guard.
5. `/metrics` and an operator endpoint for requeueing parked events would then sit behind a separate operator role. Until then, `/metrics` is deliberately open and documented, and requeue is a documented SQL statement.

The service stores no secrets and trusts the `providerId` in the payload today. That is acceptable only behind a trusted network boundary, and it is the first thing to close before real use.

## 10. Queue consumer

Every instance long-polls `wager-transactions.fifo` and runs each `WagerTransactionRequested` message through the same use case as the HTTP endpoint, so the rules exist once. The message id is the dedup key (section 6) and also the correlation id.

**Ack only after commit.** The message is deleted after the SQL transaction commits. A crash between commit and ack redelivers the message, and the inbox row turns the redelivery into a no-op that is acked.

**Errors fall in three classes** (#52):

| Class | Examples | Handling |
|---|---|---|
| Business | `REJECTED`, `PENDING_REFERENCE`, a replay, a duplicate message | a final result: ack |
| Transient or unknown | database outage, deadlock, lock timeout, a bug | not acked; the visibility timeout is reset with `exponentialBackoffMs(receiveCount)`; after `maxReceiveCount` receives the redrive policy moves it to the DLQ |
| Permanent | unparseable body, wrong `type`, invalid payload, unknown wallet, idempotency conflict, message id reused with another payload | never retried |

An unknown error is handled like a transient one because it is more likely a bug than bad input, so it gets the bounded retries before it is parked. A permanent error is sent to the DLQ explicitly, with the error code and reason as message attributes, and then deleted from the main queue (#53). Waiting for `maxReceiveCount` receives on input that can never succeed would waste work and block the wallet's FIFO group meanwhile. If the explicit send fails, the message is left untouched and the redrive policy still applies. A message that timed out on the wallet lock is retried four times later than other transient errors (#66): the wallet is busy, and coming back after one second only rejoins the queue.

**Per-wallet order.** Messages are sent with `MessageGroupId = walletId` (#54). SQS delivers a group in order and hides the rest of a group while one of its messages is in flight, so the messages of one wallet apply in order and wallets run in parallel. The consequence is intended: a failing message blocks its group until it succeeds or reaches the DLQ.

**One message per receive** (#67). A receive of several messages can return later messages of the same wallet. If the first one fails, the later ones are handed back, but each receive still counts towards `maxReceiveCount`, so they could reach the DLQ without ever being processed (found by a test). The consumer therefore receives one message per call (`SQS_CONSUMER_BATCH_SIZE=1`) and gets its parallelism from several receive loops (`SQS_CONSUMER_CONCURRENCY=10`). The cost is one SQS call per message.

**Shutdown.** On SIGTERM an instance stops receiving, waits for the message it is handling, hands back the ones it has not started and, after `SQS_SHUTDOWN_TIMEOUT_MS`, resets the visibility of anything unfinished to 0 so it returns to the queue at once (#55).

## 11. Transactional outbox and the event contract

Events are rows in `outbox_messages`, inserted in the same SQL transaction as the change they describe (section 4). A worker in every instance publishes them to the FIFO queue `wager-events.fifo` after the commit, so an event is never published for a change that was rolled back, and a change is never committed without its event.

| Event | When |
|---|---|
| `WagerTransactionProcessed` | any applied transaction, including `LOSS` |
| `WagerTransactionRejected` | a business rejection |
| `WalletBalanceChanged` | only when the balance moves, including the opening credit |
| `WagerTransactionPendingReference` | a reversal whose reference is missing |

**Publisher.** It claims and publishes one row per SQL transaction with `SELECT … FOR UPDATE SKIP LOCKED` (#56), the same shape as the pending-reference worker. A crash before the commit releases the row untouched, so another instance publishes it. The cost, a connection and a row lock held during the SQS call, is accepted (section 13). The send has a timeout.

**Target.** `MessageGroupId = aggregateId` (the wallet) and `MessageDeduplicationId = eventId` (#57). The queue's five-minute deduplication window absorbs most repeats; it is a courtesy, and the `eventId` is the real key.

**Order and the parked event.** A wallet's rows are ordered by `outbox_messages.sequence`, a database identity column (#60). Timestamps can tie and need not match lock order; an identity needs no extra query on the write path. Inserts for one wallet run under the wallet lock, so its sequence follows the order its changes were applied in, and a test pins this (20 concurrent requests: outbox order equals ledger order). A row is claimable only when it is due and no earlier unpublished row of the same wallet exists (#58, #59). After 20 failed sends (about an hour of backoff, #13) the event is parked: `failed_at` is set and the row is kept for audit. A parked event holds the later events of its wallet; other wallets are unaffected. Publishing past a parked `WIN` would leave consumers a silent hole in a stream that carries `balanceBefore`, `balanceAfter` and `walletVersion`, whereas holding the stream costs only notification delay: the balance and ledger of the wallet keep working. A stuck wallet is loud (error log, `parked` gauge, rising lag) and recoverable; a gap is neither.

**Requeue.** `OutboxMessage.requeue()` clears `failedAt`, resets the attempts and makes the event due (#61). There is no HTTP endpoint, because it would need an authorization design that the no-op guard cannot provide; the README documents the operator's SQL.

**What a consumer can rely on:**

- *At-least-once delivery.* A crash after the send and before the row is marked published sends the event again. Deduplicate by `eventId`.
- *Order per wallet.* Events of one wallet arrive in the order the changes were applied. Events of different wallets have no order between them.
- *Detectable gaps.* The `walletVersion` of a wallet's `WalletBalanceChanged` events rises by one, and each `balanceBefore` equals the previous `balanceAfter`. A consumer that sees a jump knows it missed an event. The multi-instance tests assert this chain under concurrent load.
- *A held stream is possible.* A parked event holds its wallet's stream until an operator requeues it.
- *A correlation id.* Every event carries the id of the request or message that caused it (the log line has the same one).

## 12. Observability

- **Logs** are JSON lines, one per HTTP request and one per queue message, written by `nestjs-pino` (#63). Only fields in an allowlist are written, applied to each finished line just before it is written, so a field added by any call, child logger or `assign` is covered; this was found by a test, because pino's own formatters let `assign` through. Amounts, balances, player ids, bodies, idempotency keys and error messages are not in the list, because database errors quote the failing row. The list fails closed: a forgotten field leaks nothing, and a new one needs a deliberate edit.
- **Metrics** are Prometheus text at `GET /metrics` (#64): transactions by kind and status, duplicates by source, retries, dead letters, outbox failures, reconciliation divergences, a processing histogram and a wallet-lock-wait histogram, plus gauges read at scrape time for outbox pending, lag and parked events, DLQ depth and dependency health. Counters are per instance and are summed by the scraper; gauges are shared values, cached for `METRICS_CACHE_MS` so an open endpoint cannot be used to hammer PostgreSQL and SQS. A source that fails reads `NaN`, so a broken SQS does not look like an empty DLQ. Metrics are reported after the commit, so a rolled-back attempt never counts. Labels hold kinds, statuses and outcomes, never identifiers.
- **Lock conflicts** are the `timeout` outcomes and the upper buckets of the lock-wait histogram (#65).
- **Health.** Liveness and readiness are separate (#48), and readiness is also exposed as `wagering_dependency_up`.
- **Reconciliation** compares the stored balance with the ledger on demand and counts divergences (#47).

## 13. Limitations

These are known and accepted, with what would be done about them.

1. **A hot wallet is serialized, by design.** One wallet applies about 15 to 45 requests per second on the development laptop, whatever the pool size, because its requests run one after another under its lock (#62; an order of magnitude on one machine, not a promise). A request waiting for the lock holds a database connection, so a burst on one wallet larger than the pool makes requests for other wallets wait in the pool queue: pool 10 with a burst of 200 delayed other wallets by about 4 seconds, and pool 50 by about 3.5 seconds. Every request settled and the ledger stayed consistent. Mitigations not built: a larger pool, spreading the load (a queue group per wallet, more instances), and a limit on in-flight requests per wallet before they take a connection.
2. **The lock timeout bounds the wait for the lock, not for a connection** (#65). With pool 50 and a burst of 200 the timeout shed 16 requests with `503`; with pool 10 it shed none, and other wallets still waited about 6 seconds queued for a connection. `statement_timeout` scoped to the lock statement was chosen over `lock_timeout` because the latter limits each wait step, and in a queue every step is short (measured: 150 concurrent requests, a 500 ms limit, a 1.5 s mean wait, no timeout). A shed request persisted nothing, so resending the same key is safe. A queue message that keeps timing out can still reach the DLQ after the configured receives.
3. **The SQS call runs inside a database transaction** (#56). A slow broker holds a connection and a row lock for up to the send timeout (10 s). The alternative, a lease column and a second transaction, adds a state to recover from. Publication latency is up to `OUTBOX_POLL_MS`, and throughput is one send per transaction per instance. Measured under load (`docs/LOAD_TEST.md`): three instances published roughly 30 to 50 events per second while the HTTP side accepted 40 to 110 requests per second at about two events each, so the backlog grew during the load and needed 12 to 55 seconds to drain afterwards. Nothing was lost or reordered; notifications were late. Publishing several events per claim, within the per-wallet order, is the first thing to try.
4. **A parked event holds its wallet's event stream** (#58) until an operator requeues it with SQL. That is the intended trade (no gaps), but it needs someone to watch the `parked` gauge.
5. **Ordering on one wallet follows the lock, not arrival** (section 5). A provider that needs A before B over HTTP must wait for A's response.
6. **Authentication is a stub** (section 9). The service trusts the `providerId` in the payload, and `/metrics` is open.
7. **The ledger cursor is not signed** (#46). Tampering only moves the page position.
8. **A closed account is not modelled.** The schema blocks deleting a wallet with history; closing an account would be a soft `status` checked under the lock.
9. **Reversals resolve by polling** (#40). A pending reversal waits for its next backoff after its reference arrives, up to the current interval, instead of being woken by the arrival.
10. **Tests restart the application processes, not PostgreSQL or the SQS emulator.** Recovery from a database restart is covered by the transient-error mapping and the retry paths, not by a test that stops PostgreSQL.
11. **SQS emulator.** Tests and the demo use MiniStack. The FIFO, redrive and visibility behaviour the service depends on was exercised against it, but nothing was run against real SQS, so the deduplication window and timing figures are those of the emulator.
12. **Single database.** PostgreSQL is the point of coordination and a single point of failure; the design scales out the application, not the database. Partitioning wallets across databases would be the next step, and the wallet being the unit of concurrency makes that possible.
