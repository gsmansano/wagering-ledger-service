/** A queue message id was redelivered with a different payload: a producer bug, never retried. */
export class InboxPayloadConflictError extends Error {
  constructor(
    public readonly consumerName: string,
    public readonly messageId: string,
  ) {
    super(`Message ${messageId} was already received by ${consumerName} with a different payload`);
    this.name = 'InboxPayloadConflictError';
  }
}
