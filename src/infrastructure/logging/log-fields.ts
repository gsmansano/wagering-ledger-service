/**
 * The fields a log line may carry. Everything else is dropped just before the line is written (`filterLogLine`,
 * wired in `interfaces/http/logger-params.ts`), whatever a call site or a child logger passes. To log more, add the key here; to log less, remove it.
 *
 * Money (amounts, balances, differences), player identifiers, request bodies and error messages are
 * deliberately absent: error messages can quote the values of a failing row. Call sites still pass
 * `errorMessage`, so adding it to the list below is all it takes to see it.
 */
export const LOGGABLE_FIELDS: ReadonlySet<string> = new Set([
  // Identifiers
  'correlationId',
  'messageId',
  'transactionId',
  'walletId',
  'providerId',
  'eventId',
  // What happened to the transaction
  'kind',
  'status',
  'failureCode',
  // Operational context: names and counters, no business data
  'event',
  'eventType',
  'attempt',
  'receiveCount',
  'count',
  'dependency',
  'errorName',
  'errorStack',
  // Set by the logger itself
  'context',
  'req',
  'res',
  'responseTime',
]);

// Written by pino itself on every line; not business fields, so they are not in the list above.
const STRUCTURAL_FIELDS: ReadonlySet<string> = new Set(['level', 'time', 'msg']);

/** Keeps only the allowed fields. */
export function loggable(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => LOGGABLE_FIELDS.has(key)));
}

/**
 * Applies the allowlist to one finished log line, the last step before it is written. Doing it on the line, not in
 * pino's formatters, covers every route a field can take: pino's `formatters.log` sees only the fields of a call and
 * `formatters.bindings` only the root logger, so fields added with `child` or `PinoLogger.assign` would pass.
 * A line that is not a JSON object is replaced by a fixed notice rather than written unchecked.
 */
export function filterLogLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return `${JSON.stringify({ level: 'error', msg: 'A log line that was not JSON was dropped' })}\n`;
  }
  const kept = Object.entries(parsed).filter(([key]) => STRUCTURAL_FIELDS.has(key) || LOGGABLE_FIELDS.has(key));
  return `${JSON.stringify(Object.fromEntries(kept))}\n`;
}

const MAX_STACK_FRAMES = 10;

/**
 * The fields that describe an error. The stack keeps only the `at ...` frames: the first line repeats the
 * message, which is not allowed by default.
 */
export function errorFields(error: unknown): { errorName: string; errorMessage: string; errorStack?: string } {
  if (!(error instanceof Error)) return { errorName: typeof error, errorMessage: String(error) };
  const frames = error.stack
    ?.split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .slice(0, MAX_STACK_FRAMES)
    .join('\n');
  return { errorName: error.name, errorMessage: error.message, errorStack: frames };
}
