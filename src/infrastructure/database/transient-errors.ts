import { WalletLockTimeoutError } from '../../application/wallet/wallet-lock-timeout.error';

// Decision #44: errors after which the same request is expected to succeed once the database recovers or the
// contention passes. A closed list on purpose: an unknown error is treated as a bug (500), never as retryable.
const TRANSIENT_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '55P03', // lock_not_available (a lock_timeout, or NOWAIT)
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
]);

// Messages of connection failures that carry no usable code (node-postgres and its pool).
const TRANSIENT_MESSAGES = [
  /timeout exceeded when trying to connect/i,
  /connection terminated/i,
  /connection (?:refused|reset)/i,
];

const MAX_CAUSE_DEPTH = 5;

/** True when the error, or one of its causes, carries this PostgreSQL error code. */
export function hasDatabaseCode(error: unknown, expected: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if ((current as { code?: unknown }).code === expected) return true; // pg errors carry a string `code`; Error does not declare it
    current = current.cause;
  }
  return false;
}

export function isTransientDatabaseError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (current instanceof WalletLockTimeoutError) return true; // its cause is a cancelled statement (57014), too generic to list
    const code = (current as { code?: unknown }).code; // pg and Node errors carry a string `code`; Error does not declare it
    if (typeof code === 'string' && (TRANSIENT_CODES.has(code) || code.startsWith('08'))) return true; // class 08: connection exception
    if (TRANSIENT_MESSAGES.some((pattern) => pattern.test(current instanceof Error ? current.message : ''))) return true;
    current = current.cause;
  }
  return false;
}
