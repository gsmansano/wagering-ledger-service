import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { initTestOrm, truncateAll } from '../support/database';

// Every test here writes with raw SQL on purpose: the point is to prove that the
// database refuses bad data no matter what the application code does.
type Row = Record<string, unknown>;

const NOW = new Date('2026-10-16T12:00:00Z');
const HASH = 'a'.repeat(64);

describe('schema constraints (real PostgreSQL)', () => {
  let orm: MikroORM;

  const run = <T extends Row[] = Row[]>(sql: string, params: unknown[] = []) =>
    orm.em.getConnection().execute<T>(sql, params);

  const insert = async (table: string, row: Row): Promise<Row> => {
    const columns = Object.keys(row);
    await run(
      `insert into ${table} (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
      Object.values(row),
    );
    return row;
  };

  const wallet = (o: Row = {}) =>
    insert('wallets', {
      id: crypto.randomUUID(),
      player_id: 'player-1',
      currency: 'BRL',
      balance: '100.00',
      version: 1,
      created_at: NOW,
      updated_at: NOW,
      ...o,
    });

  // A valid PROCESSED BET by default; overrides turn it into whatever a test needs.
  const tx = (walletId: unknown, o: Row = {}) => {
    const id = crypto.randomUUID();
    return insert('wager_transactions', {
      id,
      provider_id: 'provider-1',
      external_transaction_id: `ext-${id}`,
      idempotency_key: `key-${id}`,
      payload_hash: HASH,
      wallet_id: walletId,
      player_id: 'player-1',
      round_id: 'round-1',
      game_id: 'game-1',
      kind: 'BET',
      amount: '10.00',
      currency: 'BRL',
      status: 'PROCESSED',
      created_at: NOW,
      processed_at: NOW,
      ...o,
    });
  };

  const entry = (walletId: unknown, transactionId: unknown, o: Row = {}) =>
    insert('ledger_entries', {
      id: crypto.randomUUID(),
      wallet_id: walletId,
      transaction_id: transactionId,
      direction: 'DEBIT',
      amount: '10.00',
      balance_before: '100.00',
      balance_after: '90.00',
      created_at: NOW,
      sequence: 1,
      ...o,
    });

  beforeAll(async () => {
    orm = await initTestOrm();
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
  });

  describe('wallets', () => {
    it('rejects a negative balance', async () => {
      await expect(wallet({ balance: '-0.01' })).rejects.toThrow(/wallets_balance_non_negative/);
    });

    it('rejects a version below 1', async () => {
      await expect(wallet({ version: 0 })).rejects.toThrow(/wallets_version_positive/);
    });

    it('rejects a second wallet for the same player and currency, but allows another currency', async () => {
      await wallet();
      await expect(wallet()).rejects.toThrow(/wallets_player_currency_key/);
      await wallet({ currency: 'USD' });
    });

    it('rejects a malformed currency', async () => {
      await expect(wallet({ currency: 'brl' })).rejects.toThrow(/currency/);
    });

    it('refuses an update that would take the balance below zero', async () => {
      const w = await wallet({ balance: '50.00' });
      await expect(run('update wallets set balance = balance - 80 where id = ?', [w.id])).rejects.toThrow(
        /wallets_balance_non_negative/,
      );
    });
  });

  describe('wager_transactions', () => {
    let walletId: unknown;

    beforeEach(async () => {
      walletId = (await wallet()).id;
    });

    it('rejects a repeated idempotency key of the same provider, and accepts it for another provider', async () => {
      await tx(walletId, { idempotency_key: 'k1' });
      await expect(tx(walletId, { idempotency_key: 'k1' })).rejects.toThrow(
        /wager_transactions_provider_idempotency_key_key/,
      );
      await tx(walletId, { provider_id: 'provider-2', idempotency_key: 'k1' });
    });

    it('rejects a repeated (provider, external transaction id) under a different key', async () => {
      await tx(walletId, { external_transaction_id: 'ext-1' });
      await expect(tx(walletId, { external_transaction_id: 'ext-1' })).rejects.toThrow(
        /wager_transactions_provider_external_key/,
      );
      await tx(walletId, { provider_id: 'provider-2', external_transaction_id: 'ext-1' });
    });

    it('lets exactly one of many concurrent inserts of the same idempotency key win', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => tx(walletId, { idempotency_key: 'same-key' })),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(19);
    });

    it('rejects an unknown kind, status or failure code', async () => {
      await expect(tx(walletId, { kind: 'DEPOSIT' })).rejects.toThrow(/wager_transactions_kind_valid/);
      await expect(tx(walletId, { status: 'DONE', processed_at: null })).rejects.toThrow(
        /wager_transactions_status_valid/,
      );
      await expect(
        tx(walletId, { status: 'REJECTED', failure_code: 'NOPE' }),
      ).rejects.toThrow(/wager_transactions_failure_code_valid/);
    });

    it('rejects a zero amount except for LOSS', async () => {
      await expect(tx(walletId, { amount: '0.00' })).rejects.toThrow(/wager_transactions_amount_valid/);
      await tx(walletId, { kind: 'LOSS', amount: '0.00' });
      await expect(tx(walletId, { kind: 'LOSS', amount: '-1.00' })).rejects.toThrow(
        /wager_transactions_amount_valid/,
      );
    });

    it('enforces the reference rules by kind', async () => {
      await expect(tx(walletId, { kind: 'BET', reference_external_transaction_id: 'x' })).rejects.toThrow(
        /wager_transactions_reference_by_kind/,
      );
      await expect(
        tx(walletId, { kind: 'REFUND', status: 'PENDING', processed_at: null }),
      ).rejects.toThrow(/wager_transactions_reference_by_kind/);
      await tx(walletId, { kind: 'WIN', reference_external_transaction_id: 'x' });
    });

    it('requires a failure code exactly when the transaction ended REJECTED or FAILED', async () => {
      await expect(tx(walletId, { status: 'REJECTED' })).rejects.toThrow(
        /wager_transactions_failure_code_coherent/,
      );
      await expect(tx(walletId, { failure_code: 'INSUFFICIENT_FUNDS' })).rejects.toThrow(
        /wager_transactions_failure_code_coherent/,
      );
      await expect(
        tx(walletId, { status: 'REJECTED', failure_code: 'PROCESSING_FAILED' }),
      ).rejects.toThrow(/wager_transactions_failure_code_coherent/);
      await tx(walletId, { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
      await tx(walletId, { status: 'FAILED', failure_code: 'PROCESSING_FAILED' });
    });

    it('sets processed_at only on terminal states', async () => {
      await expect(tx(walletId, { status: 'PENDING' })).rejects.toThrow(
        /wager_transactions_processed_at_coherent/,
      );
      await expect(tx(walletId, { processed_at: null })).rejects.toThrow(
        /wager_transactions_processed_at_coherent/,
      );
      await tx(walletId, { status: 'PENDING', processed_at: null });
    });

    it('records the observed balance only for PROCESSED or REJECTED, never negative', async () => {
      await tx(walletId, { balance_after: '90.00' });
      await expect(tx(walletId, { balance_after: '-1.00' })).rejects.toThrow(
        /wager_transactions_balance_after_valid/,
      );
      await expect(
        tx(walletId, { status: 'PENDING', processed_at: null, balance_after: '90.00' }),
      ).rejects.toThrow(/wager_transactions_balance_after_valid/);
    });

    describe('reversals', () => {
      const reversal = (kind: string, referenceId: unknown, o: Row = {}) =>
        tx(walletId, {
          kind,
          reference_external_transaction_id: 'bet-1',
          reference_transaction_id: referenceId,
          ...o,
        });

      it('allows only one PROCESSED reversal per reference, whatever its kind', async () => {
        const bet = await tx(walletId);
        await reversal('REFUND', bet.id);
        await expect(reversal('REFUND', bet.id)).rejects.toThrow(
          /wager_transactions_one_reversal_per_reference/,
        );
        // Another kind of reversal of the same reference is refused too (decision #36).
        await expect(reversal('ROLLBACK', bet.id)).rejects.toThrow(
          /wager_transactions_one_reversal_per_reference/,
        );
      });

      it('does not let a REJECTED reversal block a later valid one', async () => {
        const bet = await tx(walletId);
        await reversal('REFUND', null, { status: 'REJECTED', failure_code: 'AMOUNT_MISMATCH' });
        await reversal('REFUND', bet.id);
      });

      it('requires a resolved reference on a PROCESSED reversal, and only on PROCESSED ones', async () => {
        await expect(reversal('REFUND', null)).rejects.toThrow(/wager_transactions_reference_resolved/);
        const bet = await tx(walletId);
        await expect(
          reversal('REFUND', bet.id, { status: 'PENDING_REFERENCE', processed_at: null }),
        ).rejects.toThrow(/wager_transactions_reference_resolved/);
      });
    });

    it('allows a single OPENING per wallet', async () => {
      const opening = (o: Row = {}) =>
        tx(walletId, { kind: 'OPENING', provider_id: 'SYSTEM', amount: '100.00', ...o });
      await opening();
      await expect(opening()).rejects.toThrow(/wager_transactions_one_opening_per_wallet/);
    });

    it('rejects a transaction for a wallet that does not exist', async () => {
      await expect(tx(crypto.randomUUID())).rejects.toThrow(/foreign key/);
    });
  });

  describe('ledger_entries', () => {
    let walletId: unknown;
    let transactionId: unknown;

    beforeEach(async () => {
      walletId = (await wallet()).id;
      transactionId = (await tx(walletId)).id;
    });

    it('refuses a repeated or non-positive sequence within a wallet, and numbers wallets independently', async () => {
      await entry(walletId, transactionId, { sequence: 1 });
      const second = (await tx(walletId)).id;
      await expect(entry(walletId, second, { sequence: 1 })).rejects.toThrow(/ledger_entries_wallet_sequence_key/);
      await expect(entry(walletId, second, { sequence: 0 })).rejects.toThrow(/ledger_entries_sequence_positive/);
      await entry(walletId, second, { sequence: 2 });

      const otherWallet = (await wallet({ player_id: 'player-2' })).id;
      await entry(otherWallet, (await tx(otherWallet)).id, { sequence: 1 });
    });

    it('accepts a balanced entry', async () => {
      await entry(walletId, transactionId);
      await entry(walletId, (await tx(walletId)).id, {
        direction: 'CREDIT',
        balance_before: '90.00',
        balance_after: '100.00',
        sequence: 2,
      });
    });

    it('rejects entries whose arithmetic does not add up', async () => {
      await expect(entry(walletId, transactionId, { balance_after: '80.00' })).rejects.toThrow(
        /ledger_entries_balanced/,
      );
      await expect(entry(walletId, transactionId, { direction: 'CREDIT' })).rejects.toThrow(
        /ledger_entries_balanced/,
      );
    });

    it('rejects a non-positive amount and negative balances', async () => {
      await expect(entry(walletId, transactionId, { amount: '0.00', balance_after: '100.00' })).rejects.toThrow(
        /amount/,
      );
      await expect(
        entry(walletId, transactionId, { amount: '10.00', balance_before: '5.00', balance_after: '-5.00' }),
      ).rejects.toThrow(/balance_after/);
    });

    it('allows only one entry per wallet for a transaction', async () => {
      await entry(walletId, transactionId);
      await expect(entry(walletId, transactionId)).rejects.toThrow(/ledger_entries_transaction_wallet_key/);
    });

    it('refuses UPDATE and DELETE, even for a superuser', async () => {
      const e = await entry(walletId, transactionId);
      await expect(run(`update ledger_entries set amount = 1 where id = ?`, [e.id])).rejects.toThrow(
        /ledger_entries is immutable: UPDATE/,
      );
      await expect(run(`delete from ledger_entries where id = ?`, [e.id])).rejects.toThrow(
        /ledger_entries is immutable: DELETE/,
      );
      const rows = await run('select amount from ledger_entries where id = ?', [e.id]);
      expect(rows).toHaveLength(1);
    });
  });

  describe('inbox_messages', () => {
    const inbox = (o: Row = {}) =>
      insert('inbox_messages', {
        consumer_name: 'wager-consumer',
        message_id: 'msg-1',
        payload_hash: HASH,
        received_at: NOW,
        ...o,
      });

    it('records a message once per consumer', async () => {
      await inbox();
      await expect(inbox()).rejects.toThrow(/inbox_messages_pkey/);
      await inbox({ consumer_name: 'other-consumer' });
      await inbox({ message_id: 'msg-2' });
    });
  });

  describe('outbox_messages', () => {
    const outbox = (o: Row = {}) =>
      insert('outbox_messages', {
        id: crypto.randomUUID(),
        aggregate_id: crypto.randomUUID(),
        event_type: 'WalletBalanceChanged',
        payload: JSON.stringify({ ok: true }),
        occurred_at: NOW,
        ...o,
      });

    it('rejects a message that is both published and parked', async () => {
      await expect(outbox({ published_at: NOW, failed_at: NOW })).rejects.toThrow(
        /outbox_messages_one_outcome/,
      );
      await outbox({ published_at: NOW });
      await outbox({ failed_at: NOW });
    });

    it('rejects negative attempts', async () => {
      await expect(outbox({ attempts: -1 })).rejects.toThrow(/attempts/);
    });

    it('numbers messages itself: a caller cannot choose the sequence', async () => {
      await expect(outbox({ sequence: 5 })).rejects.toThrow(/sequence/);
    });
  });

  describe('indexes', () => {
    it('has the partial indexes the workers and pagination rely on', async () => {
      const rows = await run<{ indexname: string }[]>(
        `select indexname from pg_indexes where schemaname = 'public'`,
      );
      const names = rows.map((r) => r.indexname);
      expect(names).toEqual(
        expect.arrayContaining([
          'outbox_messages_pending',
          'outbox_messages_unpublished',
          'wager_transactions_pending_reference_due',
          'ledger_entries_wallet_sequence_key',
        ]),
      );
    });
  });
});
