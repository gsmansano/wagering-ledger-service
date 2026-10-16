/** What the consumer must do with a message once the handler has judged it (decisions #52 and #53). */
export type MessageDisposition =
  /** A final result, including a business rejection and a message that was already processed: delete it. */
  | { kind: 'ack'; outcome: 'processed' | 'duplicate' }
  /** Might succeed later: keep it, hidden for `delayMs`. After `maxReceiveCount` receives SQS moves it to the DLQ. */
  | { kind: 'retry'; delayMs: number; cause: unknown }
  /** Can never succeed: send it to the DLQ with the reason, then delete it. */
  | { kind: 'dead-letter'; code: string; reason: string };
