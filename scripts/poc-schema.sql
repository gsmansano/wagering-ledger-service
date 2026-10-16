-- PoC for M3: tries to break each database-enforced rule and shows the database refusing it.
--
--   bun run poc:schema
--
-- Runs against the Compose PostgreSQL (migrations applied). Everything happens inside one
-- transaction that is rolled back at the end, so no data is left behind.
-- Each attempt runs in its own sub-transaction: a refusal is recorded and the script goes on.

\set QUIET on
\pset border 2
\pset format wrapped
begin;

create temp table results (n serial, rule text, expected text, outcome text, reason text);

create function pg_temp.attempt(p_rule text, p_expected text, p_sql text) returns void
language plpgsql as $$
begin
  execute p_sql;
  insert into results (rule, expected, outcome, reason) values (p_rule, p_expected, 'accepted', '');
exception when others then
  insert into results (rule, expected, outcome, reason) values (p_rule, p_expected, 'refused', sqlerrm);
end $$;

-- A transaction row with sensible defaults, for the attempts below.
create function pg_temp.add_tx(
  p_id uuid, p_key text, p_ext text, p_kind text default 'BET', p_amount numeric default 10,
  p_status text default 'PROCESSED', p_failure text default null, p_ref_ext text default null,
  p_ref_id uuid default null, p_provider text default 'poc-provider') returns void
language sql as $$
  insert into wager_transactions
    (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
     round_id, game_id, kind, amount, currency, reference_external_transaction_id, status,
     reference_transaction_id, failure_code, created_at, processed_at)
  values
    (p_id, p_provider, p_ext, p_key, repeat('a', 64), '00000000-0000-0000-0000-0000000000a1',
     'poc-player', 'round-1', 'game-1', p_kind, p_amount, 'BRL', p_ref_ext, p_status, p_ref_id,
     p_failure, now(), case when p_status in ('PROCESSED', 'REJECTED', 'FAILED') then now() end)
$$;

\o /dev/null

-- Fixture: one wallet with 100.00 BRL and one processed BET.
insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
values ('00000000-0000-0000-0000-0000000000a1', 'poc-player', 'BRL', 100.00, 1, now(), now());
select pg_temp.add_tx('00000000-0000-0000-0000-0000000000b1', 'key-1', 'ext-1');

-- ---- wallets ----------------------------------------------------------------
select pg_temp.attempt('wallet: negative balance', 'refused',
  $$insert into wallets values (gen_random_uuid(), 'p2', 'BRL', -0.01, 1, now(), now())$$);
select pg_temp.attempt('wallet: overdraft by UPDATE', 'refused',
  $$update wallets set balance = balance - 500 where id = '00000000-0000-0000-0000-0000000000a1'$$);
select pg_temp.attempt('wallet: second wallet, same player and currency', 'refused',
  $$insert into wallets values (gen_random_uuid(), 'poc-player', 'BRL', 0, 1, now(), now())$$);
select pg_temp.attempt('wallet: same player, other currency (control)', 'accepted',
  $$insert into wallets values (gen_random_uuid(), 'poc-player', 'USD', 0, 1, now(), now())$$);

-- ---- idempotency ------------------------------------------------------------
select pg_temp.attempt('transaction: repeated idempotency key (same provider)', 'refused',
  $$select pg_temp.add_tx(gen_random_uuid(), 'key-1', 'ext-other')$$);
select pg_temp.attempt('transaction: repeated (provider, external id)', 'refused',
  $$select pg_temp.add_tx(gen_random_uuid(), 'key-other', 'ext-1')$$);
select pg_temp.attempt('transaction: same idempotency key, other provider (control)', 'accepted',
  $$select pg_temp.add_tx(gen_random_uuid(), 'key-1', 'ext-3', p_provider => 'other-provider')$$);
select pg_temp.attempt('transaction: new key and external id (control)', 'accepted',
  $$select pg_temp.add_tx(gen_random_uuid(), 'key-2', 'ext-2')$$);

-- ---- transaction rules ------------------------------------------------------
select pg_temp.attempt('transaction: zero-amount BET', 'refused',
  $$select pg_temp.add_tx(gen_random_uuid(), 'key-3', 'ext-3', p_amount => 0)$$);
select pg_temp.attempt('transaction: BET carrying a reference', 'refused',
  $$select pg_temp.add_tx(gen_random_uuid(), 'key-4', 'ext-4', p_ref_ext => 'ext-1')$$);
select pg_temp.attempt('transaction: REFUND without a reference', 'refused',
  $$select pg_temp.add_tx(gen_random_uuid(), 'key-5', 'ext-5', 'REFUND', p_status => 'PENDING')$$);
select pg_temp.attempt('transaction: REJECTED without a failure code', 'refused',
  $$select pg_temp.add_tx(gen_random_uuid(), 'key-6', 'ext-6', p_status => 'REJECTED')$$);
select pg_temp.attempt('transaction: unknown status', 'refused',
  $$select pg_temp.add_tx(gen_random_uuid(), 'key-7', 'ext-7', p_status => 'DONE')$$);

-- ---- one reversal per reference, any kind -----------------------------------------
select pg_temp.attempt('reversal: first REFUND of the BET (control)', 'accepted',
  $$select pg_temp.add_tx(gen_random_uuid(), 'key-8', 'ext-8', 'REFUND', p_ref_ext => 'ext-1',
      p_ref_id => '00000000-0000-0000-0000-0000000000b1')$$);
select pg_temp.attempt('reversal: second REFUND of the same BET', 'refused',
  $$select pg_temp.add_tx(gen_random_uuid(), 'key-9', 'ext-9', 'REFUND', p_ref_ext => 'ext-1',
      p_ref_id => '00000000-0000-0000-0000-0000000000b1')$$);
select pg_temp.attempt('reversal: ROLLBACK of the same BET (other kind)', 'refused',
  $$select pg_temp.add_tx(gen_random_uuid(), 'key-10', 'ext-10', 'ROLLBACK', p_ref_ext => 'ext-1',
      p_ref_id => '00000000-0000-0000-0000-0000000000b1')$$);

-- ---- ledger ------------------------------------------------------------------
select pg_temp.attempt('ledger: balanced debit (control)', 'accepted',
  $$insert into ledger_entries values ('00000000-0000-0000-0000-0000000000c1',
      '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
      'DEBIT', 10, 100, 90, now(), 1)$$);
select pg_temp.attempt('ledger: entry whose arithmetic does not add up', 'refused',
  $$insert into ledger_entries values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1',
      (select id from wager_transactions where idempotency_key = 'key-2'), 'DEBIT', 10, 100, 80, now(), 2)$$);
select pg_temp.attempt('ledger: second entry for the same transaction and wallet', 'refused',
  $$insert into ledger_entries values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1',
      '00000000-0000-0000-0000-0000000000b1', 'DEBIT', 10, 90, 80, now(), 2)$$);
select pg_temp.attempt('ledger: repeated sequence within the wallet', 'refused',
  $$insert into ledger_entries values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1',
      (select id from wager_transactions where idempotency_key = 'key-2'), 'DEBIT', 10, 90, 80, now(), 1)$$);
select pg_temp.attempt('ledger: UPDATE an entry', 'refused',
  $$update ledger_entries set amount = 1 where id = '00000000-0000-0000-0000-0000000000c1'$$);
select pg_temp.attempt('ledger: DELETE an entry', 'refused',
  $$delete from ledger_entries where id = '00000000-0000-0000-0000-0000000000c1'$$);

-- ---- inbox and outbox ----------------------------------------------------------
select pg_temp.attempt('inbox: first delivery of a message (control)', 'accepted',
  $$insert into inbox_messages values ('consumer', 'msg-1', repeat('a', 64), now(), null)$$);
select pg_temp.attempt('inbox: same message again, same consumer', 'refused',
  $$insert into inbox_messages values ('consumer', 'msg-1', repeat('a', 64), now(), null)$$);
select pg_temp.attempt('outbox: message both published and parked', 'refused',
  $$insert into outbox_messages values (gen_random_uuid(), gen_random_uuid(), 'Evt', '{}', now(), 0, null, now(), now())$$);

\o

-- ---- verdict -------------------------------------------------------------------
select n as "#", rule, outcome,
       case when outcome = expected then 'OK' else '*** UNEXPECTED ***' end as verdict,
       left(regexp_replace(reason, E'\\s+', ' ', 'g'), 110) as "database said"
from results order by n;

rollback;
