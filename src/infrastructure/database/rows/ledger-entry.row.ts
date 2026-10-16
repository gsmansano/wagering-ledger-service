import { EntitySchema } from '@mikro-orm/core';
import type { LedgerDirection } from '../../../domain/wallet/wallet-ledger-entry';

export interface LedgerEntryRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
  /** Position in the wallet's ledger, assigned on append. */
  sequence: number;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRow>({
  name: 'LedgerEntryRow',
  tableName: 'ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'string' },
    amount: { type: 'string', columnType: 'numeric(19,2)' },
    balanceBefore: { type: 'string', columnType: 'numeric(19,2)' },
    balanceAfter: { type: 'string', columnType: 'numeric(19,2)' },
    createdAt: { type: Date, columnType: 'timestamptz' },
    sequence: { type: 'number', columnType: 'integer' },
  },
});
