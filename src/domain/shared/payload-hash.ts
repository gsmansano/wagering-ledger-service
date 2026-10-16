import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';
import { Money, type MoneyProps } from './money';
import type { WagerTransactionKind } from '../transaction/wager-transaction';

/**
 * The business fields of a submitted transaction. The Idempotency-Key header and transport
 * metadata (SQS message id, correlation ids) are not part of it: the key is what the hash is
 * compared against, and metadata changes between deliveries of the same payload.
 */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * SHA-256 (lowercase hex) of the canonical JSON of the business fields. Only the listed fields
 * are read, so extra properties never change the hash, and money is normalized to scale 2.
 */
export function payloadHash(payload: WagerPayload): string {
  const canonical = canonicalJson({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: Money.from(payload.money).toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
