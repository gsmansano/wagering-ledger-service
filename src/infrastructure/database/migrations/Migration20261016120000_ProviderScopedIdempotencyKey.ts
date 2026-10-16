import { Migration } from '@mikro-orm/migrations';

// The idempotency key is chosen by the provider, so it is unique per provider, not across all of them: two
// providers may send the same key string without colliding, and a conflict never reveals another provider's
// transaction. A separate migration because the core schema was already applied and applied migrations are
// never edited. `down` restores the global constraint and fails if two providers already reuse a key.
export class Migration20261016120000_ProviderScopedIdempotencyKey extends Migration {
  override up(): void {
    this.addSql('alter table wager_transactions drop constraint wager_transactions_idempotency_key_key;');
    this.addSql(`
      alter table wager_transactions
        add constraint wager_transactions_provider_idempotency_key_key unique (provider_id, idempotency_key);
    `);
  }

  override down(): void {
    this.addSql('alter table wager_transactions drop constraint wager_transactions_provider_idempotency_key_key;');
    this.addSql(`
      alter table wager_transactions
        add constraint wager_transactions_idempotency_key_key unique (idempotency_key);
    `);
  }
}
