import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261015000000_SkeletonProbe } from './Migration20261015000000_SkeletonProbe';
import { Migration20261016000000_CoreSchema } from './Migration20261016000000_CoreSchema';

// Order matters: migrations are applied top to bottom.
export const migrationsList: MigrationObject[] = [
  { name: 'Migration20261015000000_SkeletonProbe', class: Migration20261015000000_SkeletonProbe },
  { name: 'Migration20261016000000_CoreSchema', class: Migration20261016000000_CoreSchema },
];
