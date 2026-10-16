import { EntitySchema } from '@mikro-orm/core';

// Persistence shape of a wallet. The domain `Wallet` has private state, so the
// ORM maps this plain row and `wallet.mapper.ts` converts to and from the domain.
export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  /** NUMERIC(19,2) comes back as a decimal string, never a number. */
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRow>({
  name: 'WalletRow',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { type: 'string', columnType: 'numeric(19,2)' },
    version: { type: 'number' },
    createdAt: { type: Date, columnType: 'timestamptz' },
    updatedAt: { type: Date, columnType: 'timestamptz' },
  },
});
