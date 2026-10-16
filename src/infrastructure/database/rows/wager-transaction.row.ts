import { EntitySchema } from '@mikro-orm/core';
import type { FailureCode } from '../../../domain/transaction/failure-code';
import type { WagerTransactionKind, WagerTransactionStatus } from '../../../domain/transaction/wager-transaction';

export interface WagerTransactionRow {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  status: WagerTransactionStatus;
  referenceTransactionId: string | null;
  failureCode: FailureCode | null;
  balanceAfter: string | null;
  createdAt: Date;
  processedAt: Date | null;
}

// The retry columns of the pending-reference worker (reference_attempts,
// reference_next_attempt_at) are left unmapped until M5 uses them.
export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  name: 'WagerTransactionRow',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    walletId: { type: 'uuid' },
    playerId: { type: 'string' },
    roundId: { type: 'string' },
    gameId: { type: 'string' },
    kind: { type: 'string' },
    amount: { type: 'string', columnType: 'numeric(19,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'string', nullable: true },
    status: { type: 'string' },
    referenceTransactionId: { type: 'uuid', nullable: true },
    failureCode: { type: 'string', nullable: true },
    balanceAfter: { type: 'string', columnType: 'numeric(19,2)', nullable: true },
    createdAt: { type: Date, columnType: 'timestamptz' },
    processedAt: { type: Date, columnType: 'timestamptz', nullable: true },
  },
});
