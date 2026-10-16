import type { ProcessWagerTransactionCommand } from '../../application/transaction/process-wager-transaction';
import { WagerTransactionKind } from '../../domain/transaction/wager-transaction';

export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

/** The message can never be processed, however often it is retried (it goes to the DLQ, decision #53). */
export class InvalidMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMessageError';
  }
}

export interface WagerTransactionMessage {
  messageId: string;
  occurredAt: Date;
  command: ProcessWagerTransactionCommand;
}

const KINDS = new Set<string>(Object.values(WagerTransactionKind));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidMessageError(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>; // narrowed to a non-null, non-array object just above
}

function requiredString(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidMessageError(`${name} is required and must be a non-empty string`);
  }
  return value;
}

function optionalString(source: Record<string, unknown>, name: string): string | undefined {
  return source[name] === undefined ? undefined : requiredString(source, name);
}

/**
 * Structural checks only, like the HTTP controller: business validation stays in the domain. The idempotency key
 * comes from the body (the HTTP header's counterpart) and the message id doubles as the correlation id.
 * Throws InvalidMessageError for anything that cannot be a `WagerTransactionRequested` message.
 */
export function parseWagerTransactionMessage(body: string): WagerTransactionMessage {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new InvalidMessageError('The message body is not valid JSON');
  }
  const envelope = asObject(json, 'message');
  const type = requiredString(envelope, 'type');
  if (type !== WAGER_TRANSACTION_REQUESTED) {
    throw new InvalidMessageError(`Unsupported message type ${type}`);
  }
  const messageId = requiredString(envelope, 'messageId');
  const occurredAt = new Date(requiredString(envelope, 'occurredAt'));
  if (Number.isNaN(occurredAt.getTime())) {
    throw new InvalidMessageError('occurredAt must be an ISO 8601 date');
  }

  const data = asObject(envelope.data, 'data');
  const kind = requiredString(data, 'kind');
  if (!KINDS.has(kind)) {
    throw new InvalidMessageError(`kind must be one of ${[...KINDS].join(', ')}`);
  }
  const walletId = requiredString(data, 'walletId');
  if (!UUID.test(walletId)) {
    throw new InvalidMessageError('walletId must be a UUID');
  }
  const money = asObject(data.money, 'money');

  return {
    messageId,
    occurredAt,
    command: {
      idempotencyKey: requiredString(data, 'idempotencyKey'),
      providerId: requiredString(data, 'providerId'),
      externalTransactionId: requiredString(data, 'externalTransactionId'),
      playerId: requiredString(data, 'playerId'),
      walletId,
      roundId: requiredString(data, 'roundId'),
      gameId: requiredString(data, 'gameId'),
      kind: kind as WagerTransactionKind, // checked against the enum values just above
      money: { amount: requiredString(money, 'amount'), currency: requiredString(money, 'currency') },
      referenceExternalTransactionId: optionalString(data, 'referenceExternalTransactionId'),
      correlationId: messageId,
    },
  };
}
