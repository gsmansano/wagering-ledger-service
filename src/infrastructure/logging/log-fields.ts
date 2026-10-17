/**
 * The fields a log line may carry. Everything else is dropped by the logger before it is written (see
 * `interfaces/http/logger-params.ts`), whatever a call site passes. To log more, add the key here; to log less, remove it.
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

/** Keeps only the allowed fields. */
export function loggable(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => LOGGABLE_FIELDS.has(key)));
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
