import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { migrationsList } from './migrations';

export function createOrmConfig(databaseUrl: string) {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: [],
    // Entities arrive in M3; until then an empty list is expected.
    discovery: { warnWhenNoEntities: false },
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
