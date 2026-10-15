// SQS attribute values are strings, including numbers and booleans.

export function dlqAttributes(): Record<string, string> {
  return {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'false',
    // 14 days, the SQS maximum: dead letters wait for a person to inspect them.
    MessageRetentionPeriod: '1209600',
  };
}

export function mainQueueAttributes(dlqArn: string, maxReceiveCount: number): Record<string, string> {
  if (!Number.isInteger(maxReceiveCount) || maxReceiveCount < 1) {
    throw new Error(`maxReceiveCount must be a positive integer, got ${maxReceiveCount}`);
  }
  return {
    FifoQueue: 'true',
    // Producers must send an explicit MessageDeduplicationId; we never rely on body hashing.
    ContentBasedDeduplication: 'false',
    // After this many failed receives, SQS moves the message to the DLQ.
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount }),
  };
}
