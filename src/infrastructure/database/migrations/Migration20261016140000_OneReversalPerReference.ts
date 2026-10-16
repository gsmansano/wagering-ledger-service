import { Migration } from '@mikro-orm/migrations';

// Spec §7 rule 4 forbids reversing a reference twice "by the same kind", which would still allow a BET to be both
// REFUNDed and ROLLBACKed (a double credit). Decision #36 is stricter: a transaction is reversed at most once, by
// any kind. The index stays partial, so a REJECTED or pending reversal does not block a later valid one.
export class Migration20261016140000_OneReversalPerReference extends Migration {
  override up(): void {
    this.addSql('drop index wager_transactions_one_reversal_per_reference;');
    this.addSql(`
      create unique index wager_transactions_one_reversal_per_reference
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
  }

  // Fails if the data already holds two processed reversals of one reference (a REFUND and a ROLLBACK).
  override down(): void {
    this.addSql('drop index wager_transactions_one_reversal_per_reference;');
    this.addSql(`
      create unique index wager_transactions_one_reversal_per_reference
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
  }
}
