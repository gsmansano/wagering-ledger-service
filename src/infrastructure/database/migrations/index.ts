import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261015000000_SkeletonProbe } from './Migration20261015000000_SkeletonProbe';
import { Migration20261016000000_CoreSchema } from './Migration20261016000000_CoreSchema';
import { Migration20261016130000_LedgerSequence } from './Migration20261016130000_LedgerSequence';
import { Migration20261016120000_ProviderScopedIdempotencyKey } from './Migration20261016120000_ProviderScopedIdempotencyKey';

import { Migration20261016140000_OneReversalPerReference } from './Migration20261016140000_OneReversalPerReference';

// Order matters: migrations are applied top to bottom.
export const migrationsList: MigrationObject[] = [
  { name: 'Migration20261015000000_SkeletonProbe', class: Migration20261015000000_SkeletonProbe },
  { name: 'Migration20261016000000_CoreSchema', class: Migration20261016000000_CoreSchema },
  {
    name: 'Migration20261016120000_ProviderScopedIdempotencyKey',
    class: Migration20261016120000_ProviderScopedIdempotencyKey,
  },
  { name: 'Migration20261016130000_LedgerSequence', class: Migration20261016130000_LedgerSequence },
  {
    name: 'Migration20261016140000_OneReversalPerReference',
    class: Migration20261016140000_OneReversalPerReference,
  },
];
