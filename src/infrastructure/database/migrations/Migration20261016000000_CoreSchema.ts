import { Migration } from '@mikro-orm/migrations';

// The real schema (M3). The database, not only the application, enforces the
// invariants of the specification (§5.9): uniqueness, non-negative balance,
// coherent states and an immutable ledger.
//
// Enum-like columns are `text` + CHECK instead of Postgres enum types: adding a
// value later is a one-line constraint change, not an `ALTER TYPE`.
export class Migration20261016000000_CoreSchema extends Migration {
  override up(): void {
    // Placeholder from M1, no longer needed.
    this.addSql('drop table skeleton_probe;');

    // ---- wallets ---------------------------------------------------------
    this.addSql(`
      create table wallets (
        id         uuid           primary key,
        player_id  text           not null check (btrim(player_id) <> ''),
        currency   char(3)        not null check (currency ~ '^[A-Z]{3}$'),
        balance    numeric(19, 2) not null,
        version    integer        not null,
        created_at timestamptz    not null,
        updated_at timestamptz    not null,
        -- Last line of defence against overdraft: even a lost-update bug
        -- cannot persist a negative balance.
        constraint wallets_balance_non_negative check (balance >= 0),
        -- Starts at 1 and only grows (it changes only when the balance does).
        constraint wallets_version_positive check (version >= 1),
        -- At most one wallet per player and currency.
        constraint wallets_player_currency_key unique (player_id, currency)
      );
    `);

    // ---- wager_transactions ----------------------------------------------
    this.addSql(`
      create table wager_transactions (
        id                                uuid           primary key,
        provider_id                       text           not null check (btrim(provider_id) <> ''),
        external_transaction_id           text           not null check (btrim(external_transaction_id) <> ''),
        idempotency_key                   text           not null check (btrim(idempotency_key) <> ''),
        payload_hash                      char(64)       not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id                         uuid           not null references wallets (id),
        player_id                         text           not null,
        round_id                          text           not null,
        game_id                           text           not null,
        kind                              text           not null,
        amount                            numeric(19, 2) not null,
        currency                          char(3)        not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text,
        status                            text           not null,
        reference_transaction_id          uuid           references wager_transactions (id),
        failure_code                      text,
        -- Balance observed when the transaction was settled, so a replay can
        -- return the original result (§7 rule 7). LOSS has no ledger entry.
        balance_after                     numeric(19, 2),
        created_at                        timestamptz    not null,
        processed_at                      timestamptz,
        -- Retry state of the PENDING_REFERENCE worker (M5).
        reference_attempts                integer        not null default 0,
        reference_next_attempt_at         timestamptz,

        constraint wager_transactions_kind_valid
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_status_valid
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_failure_code_valid
          check (failure_code is null or failure_code in (
            'INSUFFICIENT_FUNDS', 'REVERSAL_WOULD_OVERDRAW', 'REFERENCE_NOT_FOUND',
            'REFERENCE_NOT_PROCESSED', 'REFERENCE_MISMATCH', 'INVALID_REFERENCE_KIND',
            'ALREADY_REVERSED', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'WALLET_NOT_FOUND',
            'PROCESSING_FAILED')),

        -- Money: positive for every kind except LOSS, which may be 0.00.
        constraint wager_transactions_amount_valid
          check (amount > 0 or (kind = 'LOSS' and amount = 0)),

        -- Reference rules by kind: BET and OPENING never carry one, REFUND and
        -- ROLLBACK always do, WIN and LOSS may.
        constraint wager_transactions_reference_by_kind
          check ((kind not in ('BET', 'OPENING') or reference_external_transaction_id is null)
             and (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null)),

        -- A failure code exists exactly when the transaction ended REJECTED or
        -- FAILED, and PROCESSING_FAILED is exclusive to FAILED.
        constraint wager_transactions_failure_code_coherent
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)
             and ((status = 'FAILED') = coalesce(failure_code = 'PROCESSING_FAILED', false))),

        -- processed_at records when the terminal state was reached.
        constraint wager_transactions_processed_at_coherent
          check ((status in ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at is not null)),

        -- The resolved reference exists only on PROCESSED transactions, and a
        -- PROCESSED reversal always has one.
        constraint wager_transactions_reference_resolved
          check ((reference_transaction_id is null or status = 'PROCESSED')
             and (not (kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED')
                  or reference_transaction_id is not null)),

        constraint wager_transactions_balance_after_valid
          check (balance_after is null
             or (balance_after >= 0 and status in ('PROCESSED', 'REJECTED'))),

        constraint wager_transactions_attempts_non_negative check (reference_attempts >= 0),

        -- Idempotency: the same key, or the same provider transaction, cannot
        -- be stored twice. Concurrent inserts race here and exactly one wins.
        constraint wager_transactions_idempotency_key_key unique (idempotency_key),
        constraint wager_transactions_provider_external_key unique (provider_id, external_transaction_id)
      );
    `);

    // One processed reversal per reference and kind (§7 rule 4). Partial, so a
    // REJECTED or pending ROLLBACK does not block a later valid one.
    this.addSql(`
      create unique index wager_transactions_one_reversal_per_reference
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
    // A wallet is opened exactly once.
    this.addSql(`
      create unique index wager_transactions_one_opening_per_wallet
        on wager_transactions (wallet_id) where kind = 'OPENING';
    `);
    // PENDING_REFERENCE transactions that are due for the retry worker, and
    // lookups of transactions waiting on a given provider reference.
    this.addSql(`
      create index wager_transactions_pending_reference_due
        on wager_transactions (reference_next_attempt_at) where status = 'PENDING_REFERENCE';
    `);
    this.addSql('create index wager_transactions_wallet_id_idx on wager_transactions (wallet_id);');
    this.addSql(`
      create index wager_transactions_reference_lookup
        on wager_transactions (provider_id, reference_external_transaction_id)
        where reference_external_transaction_id is not null;
    `);

    // ---- ledger_entries --------------------------------------------------
    this.addSql(`
      create table ledger_entries (
        id             uuid           primary key,
        wallet_id      uuid           not null references wallets (id),
        transaction_id uuid           not null references wager_transactions (id),
        direction      text           not null check (direction in ('DEBIT', 'CREDIT')),
        amount         numeric(19, 2) not null check (amount > 0),
        balance_before numeric(19, 2) not null check (balance_before >= 0),
        balance_after  numeric(19, 2) not null check (balance_after >= 0),
        created_at     timestamptz    not null,
        -- The arithmetic of the entry is verified by the database as well.
        constraint ledger_entries_balanced
          check ((direction = 'DEBIT'  and balance_after = balance_before - amount)
              or (direction = 'CREDIT' and balance_after = balance_before + amount)),
        -- At most one entry per wallet for a financial transaction.
        constraint ledger_entries_transaction_wallet_key unique (transaction_id, wallet_id)
      );
    `);
    // Keyset pagination of a wallet's statement.
    this.addSql('create index ledger_entries_wallet_page on ledger_entries (wallet_id, created_at, id);');

    // Ledger rows are never rewritten or removed, whoever the writer is. This
    // does not block TRUNCATE, which the test helper relies on.
    this.addSql(`
      create function ledger_entries_forbid_change() returns trigger
      language plpgsql as $$
      begin
        raise exception 'ledger_entries is immutable: % is not allowed', tg_op
          using errcode = 'restrict_violation';
      end;
      $$;
    `);
    this.addSql(`
      create trigger ledger_entries_immutable
        before update or delete on ledger_entries
        for each row execute function ledger_entries_forbid_change();
    `);

    // ---- inbox_messages --------------------------------------------------
    this.addSql(`
      create table inbox_messages (
        consumer_name text        not null check (btrim(consumer_name) <> ''),
        message_id    text        not null check (btrim(message_id) <> ''),
        payload_hash  char(64)    not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        received_at   timestamptz not null,
        processed_at  timestamptz,
        -- A consumer records each message once: the dedup guarantee.
        constraint inbox_messages_pkey primary key (consumer_name, message_id)
      );
    `);

    // ---- outbox_messages -------------------------------------------------
    this.addSql(`
      create table outbox_messages (
        id              uuid        primary key,
        aggregate_id    uuid        not null,
        event_type      text        not null check (btrim(event_type) <> ''),
        payload         jsonb       not null,
        occurred_at     timestamptz not null,
        attempts        integer     not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz,
        published_at    timestamptz,
        -- Set when the message is parked after too many failed attempts.
        failed_at       timestamptz,
        -- A message ends published or parked, never both.
        constraint outbox_messages_one_outcome check (published_at is null or failed_at is null)
      );
    `);
    // The publisher's query: unpublished, unparked and due, oldest first.
    this.addSql(`
      create index outbox_messages_due
        on outbox_messages (next_attempt_at nulls first, occurred_at)
        where published_at is null and failed_at is null;
    `);
    // Per-wallet ordering and inspection of a wallet's events.
    this.addSql('create index outbox_messages_aggregate on outbox_messages (aggregate_id, occurred_at);');
  }

  override down(): void {
    this.addSql('drop table outbox_messages;');
    this.addSql('drop table inbox_messages;');
    this.addSql('drop trigger ledger_entries_immutable on ledger_entries;');
    this.addSql('drop function ledger_entries_forbid_change();');
    this.addSql('drop table ledger_entries;');
    this.addSql('drop table wager_transactions;');
    this.addSql('drop table wallets;');
    this.addSql('create table skeleton_probe (id int primary key);');
  }
}
