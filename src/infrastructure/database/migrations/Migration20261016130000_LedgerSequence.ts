import { Migration } from '@mikro-orm/migrations';

// A wallet's statement must follow the order entries were applied in. Timestamps cannot guarantee it: the JS
// clock has millisecond precision, so entries of one wallet can tie, and the old tie-break was a random id.
// `sequence` is the position of an entry in its wallet's ledger (1, 2, 3 ...), assigned under the wallet lock;
// the unique constraint makes a duplicate or a lost lock fail loudly, and it replaces the old paging index.
export class Migration20261016130000_LedgerSequence extends Migration {
  override up(): void {
    this.addSql('alter table ledger_entries add column sequence integer;');

    // Existing rows are numbered by (created_at, id), the best order known for them. The immutability trigger
    // forbids UPDATE, so it is switched off for this backfill only (inside the migration's transaction).
    this.addSql('alter table ledger_entries disable trigger ledger_entries_immutable;');
    this.addSql(`
      update ledger_entries e set sequence = numbered.position
        from (
          select id, row_number() over (partition by wallet_id order by created_at, id) as position
            from ledger_entries
        ) numbered
       where e.id = numbered.id;
    `);
    this.addSql('alter table ledger_entries enable trigger ledger_entries_immutable;');

    this.addSql('alter table ledger_entries alter column sequence set not null;');
    this.addSql('alter table ledger_entries add constraint ledger_entries_sequence_positive check (sequence > 0);');
    this.addSql('alter table ledger_entries add constraint ledger_entries_wallet_sequence_key unique (wallet_id, sequence);');
    // The unique constraint's index serves keyset paging by (wallet_id, sequence).
    this.addSql('drop index ledger_entries_wallet_page;');
  }

  override down(): void {
    this.addSql('create index ledger_entries_wallet_page on ledger_entries (wallet_id, created_at, id);');
    this.addSql('alter table ledger_entries drop constraint ledger_entries_wallet_sequence_key;');
    this.addSql('alter table ledger_entries drop constraint ledger_entries_sequence_positive;');
    this.addSql('alter table ledger_entries drop column sequence;');
  }
}
