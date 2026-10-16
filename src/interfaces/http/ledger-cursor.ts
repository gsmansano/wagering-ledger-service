import { BadRequestException } from '@nestjs/common';

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

// Decision #46: the cursor is base64url of {"sequence": n}. It is opaque to clients (they only hand it back) and
// unsigned: a forged cursor can only move the page position within the wallet's own ledger.

export function encodeLedgerCursor(sequence: number): string {
  return Buffer.from(JSON.stringify({ sequence })).toString('base64url');
}

export function decodeLedgerCursor(cursor: string): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const sequence = (parsed as { sequence?: unknown } | null)?.sequence;
    if (Number.isSafeInteger(sequence) && (sequence as number) > 0) return sequence as number;
  } catch {
    // falls through to the error below
  }
  throw new BadRequestException({ error: 'INVALID_CURSOR', message: 'cursor is not a cursor issued by this API' });
}

/** `limit` from the query string: absent means the default; anything but an integer in [1, 200] is a 400. */
export function parseLedgerLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LEDGER_LIMIT;
  const limit = /^\d{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(limit >= 1 && limit <= MAX_LEDGER_LIMIT)) {
    throw new BadRequestException({
      error: 'MALFORMED_REQUEST',
      message: `limit must be an integer between 1 and ${MAX_LEDGER_LIMIT}`,
    });
  }
  return limit;
}
