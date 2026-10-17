import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { migrationsList } from './migrations';
import { InboxMessageSchema } from './rows/inbox-message.row';
import { LedgerEntrySchema } from './rows/ledger-entry.row';
import { OutboxMessageSchema } from './rows/outbox-message.row';
import { WagerTransactionSchema } from './rows/wager-transaction.row';
import { WalletSchema } from './rows/wallet.row';

export function createOrmConfig(databaseUrl: string, poolMax?: number) {
  return defineConfig({
    clientUrl: databaseUrl,
    ...(poolMax !== undefined && { pool: { max: poolMax } }),
    // Persistence rows only; the domain classes are never registered with the ORM.
    entities: [
      WalletSchema,
      WagerTransactionSchema,
      LedgerEntrySchema,
      InboxMessageSchema,
      OutboxMessageSchema,
    ],
    extensions: [Migrator],
    migrations: {
      // Listed explicitly instead of discovered by glob, so the set of
      // migrations is visible in code and does not depend on file layout.
      migrationsList,
      transactional: true,
      allOrNothing: true,
      // Migrations are hand-written SQL, so the schema snapshot used for diffing is not needed.
      snapshot: false,
    },
  });
}
