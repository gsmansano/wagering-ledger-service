# CLAUDE.md

Guidance for AI coding assistants (Claude Code) working in this repository. Human contributors will find the same conventions useful.

## Project

A distributed wagering processor: a wallet and ledger service that applies betting operations (BET, WIN, LOSS, REFUND, ROLLBACK) received over HTTP and SQS, and stays correct under duplicate delivery, out-of-order messages, concurrent instances and crashes.

Stack: Bun 1.x, TypeScript (strict), NestJS, PostgreSQL, AWS SQS (local emulator), Docker Compose.

## Documentation map

| Path | Purpose |
|---|---|
| `PLAN.md` | Milestones, progress checkboxes and the decisions log |
| `docs/devlog/` | Session logs: what was done, files touched, decisions, next steps |
| `ARCHITECTURE.md` | Design decisions, trade-offs and known limitations (from M11) |
| `README.md` | Setup and commands (from M1) |

At the start of a session, read `PLAN.md` and the most recent file in `docs/devlog/`. Older logs are history; read them only when a task needs that context.

## Working conventions

- Work milestone by milestone, following `PLAN.md`. Do not start work from a later milestone without agreement.
- Design decisions (concurrency strategy, schema, HTTP status mapping, failure codes, interpretations of ambiguous requirements) are proposed with options and a recommendation, then confirmed before implementation. Every confirmed decision is recorded in the `PLAN.md` decisions log.
- Each milestone with observable behaviour ends with a hands-on PoC that can be run from the terminal or Postman. Its commands are documented in `README.md` and it is listed as a checkbox in the milestone.
- When a milestone is complete, tick its checkboxes in `PLAN.md`.
- At the end of a session, write a devlog entry (`/log`).

## Code rules

These are hard requirements of the specification.

- Money is never `number` or a float: a decimal library in code, `NUMERIC(…, 2)` in the database, decimal strings (`"25.00"`) in contracts.
- The domain layer (`src/domain`) is grouped by concept: `shared/` (money, errors, hashing, backoff), `wallet/`, `transaction/`, `messaging/` (inbox, outbox) and `events/`. Unit tests (`*.spec.ts`) sit next to the code they test; integration tests live in `test/integration/`. New domain files go in the matching folder.
- The domain layer (`src/domain`) imports nothing from NestJS or the ORM. Entities use private constructors and static factories (`create`, `open`, `from`, `rehydrate`); `rehydrate` does not re-validate.
- Invariants (uniqueness, non-negative balance, ledger immutability) are enforced by database constraints, not only in application code.
- The balance change, ledger entry, transaction status, inbox record and outbox event are written in a single SQL transaction. Events are never published before commit.
- Idempotency is persisted, never held in memory. The unit of concurrency is the wallet; no global lock.
- The system must be correct with several instances running at once.
- Integration and concurrency tests run against real PostgreSQL and the SQS emulator; they are never fully mocked.
- No `any` without a comment explaining why.

## Git

- Conventional Commits in English (`feat(wallet): add debit operation`).
- Never run `git add`, `git commit` or `git push` unless explicitly asked. Changes are reviewed in the IDE before staging; leave them unstaged.
- Committed content is written in a neutral, professional tone. Files under `local/` are untracked and not part of the project.

## Commands

```bash
docker compose up -d --build   # PostgreSQL, MiniStack, one-shot migrate, app on :3000
bun test                       # all tests; needs postgres and ministack running
bun test <path>                # a single file
bun run typecheck              # tsc --noEmit
bun run start                  # app on the host, against the Compose services
bun run migration:up           # apply pending migrations
bun run migration:down         # revert the most recent migration
```

Tests use the `wagering_test` database, created and migrated by `test/support/setup.ts` (preloaded via `bunfig.toml`). Migrations are hand-written classes registered in `src/infrastructure/database/migrations/index.ts`.
