import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261015000000_SkeletonProbe } from './Migration20261015000000_SkeletonProbe';

// Order matters: migrations are applied top to bottom.
export const migrationsList: MigrationObject[] = [
  { name: 'Migration20261015000000_SkeletonProbe', class: Migration20261015000000_SkeletonProbe },
];
