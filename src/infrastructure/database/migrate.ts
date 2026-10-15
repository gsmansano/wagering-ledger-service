import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../config';
import { createOrmConfig } from './mikro-orm.config';

// Usage: bun src/infrastructure/database/migrate.ts <up|down>
// `down` reverts the most recent migration only.
const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error('Usage: migrate.ts <up|down>');
  process.exit(1);
}

const orm = await MikroORM.init(createOrmConfig(loadConfig().databaseUrl));
try {
  const applied = direction === 'up' ? await orm.migrator.up() : await orm.migrator.down();
  console.log(`migrate ${direction}: ${applied.map((m) => m.name).join(', ') || 'nothing to do'}`);
} finally {
  await orm.close();
}
