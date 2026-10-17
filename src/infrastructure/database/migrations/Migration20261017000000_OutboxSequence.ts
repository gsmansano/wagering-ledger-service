import { Migration } from '@mikro-orm/migrations';

// Decision #58 publishes a wallet's events in order, which needs an order the database assigns. `occurred_at` is
// stamped by the application, can tie within a millisecond and can differ from the order the wallet lock applied the
// changes (cf. the ledger sequence). An identity column is assigned at insert time, and inserts for one wallet are
// serialized by the wallet lock, so one wallet's sequence follows the order of its changes. Across wallets it is only
// a unique number.
export class Migration20261017000000_OutboxSequence extends Migration {
  override up(): void {
    this.addSql('alter table outbox_messages add column sequence bigint;');
    // Rows written before this migration keep the order they would have been published in.
    this.addSql(`
      update outbox_messages o set sequence = numbered.n
        from (select id, row_number() over (order by occurred_at, id) as n from outbox_messages) numbered
       where o.id = numbered.id;
    `);
    // The identity must start after the numbers just assigned, which DDL cannot compute, hence the DO block.
    this.addSql(`
      do $$
      declare first_free bigint;
      begin
        select coalesce(max(sequence), 0) + 1 into first_free from outbox_messages;
        execute format(
          'alter table outbox_messages
             alter column sequence set not null,
             alter column sequence add generated always as identity (start with %s)',
          first_free
        );
      end $$;
    `);
    this.addSql('alter table outbox_messages add constraint outbox_messages_sequence_key unique (sequence);');
    this.addSql('alter table outbox_messages add constraint outbox_messages_sequence_positive check (sequence > 0);');

    this.addSql('drop index outbox_messages_due;');
    this.addSql('drop index outbox_messages_aggregate;');
    // Candidates for publication, oldest first.
    this.addSql(`
      create index outbox_messages_pending
        on outbox_messages (sequence)
        where published_at is null and failed_at is null;
    `);
    // "Is there an earlier unpublished event of this wallet?" (parked ones count, decision #58) and per-wallet inspection.
    this.addSql(`
      create index outbox_messages_unpublished
        on outbox_messages (aggregate_id, sequence)
        where published_at is null;
    `);
    this.addSql('create index outbox_messages_aggregate on outbox_messages (aggregate_id, sequence);');
  }

  override down(): void {
    this.addSql('drop index outbox_messages_aggregate;');
    this.addSql('drop index outbox_messages_unpublished;');
    this.addSql('drop index outbox_messages_pending;');
    this.addSql('alter table outbox_messages drop column sequence;');
    this.addSql(`
      create index outbox_messages_due
        on outbox_messages (next_attempt_at nulls first, occurred_at)
        where published_at is null and failed_at is null;
    `);
    this.addSql('create index outbox_messages_aggregate on outbox_messages (aggregate_id, occurred_at);');
  }
}
