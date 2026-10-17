import { describe, expect, it } from 'bun:test';
import { dlqAttributes, eventsQueueAttributes, mainQueueAttributes } from './queue-attributes';

describe('queue attributes', () => {
  it('declares every queue as FIFO without content-based deduplication', () => {
    for (const attrs of [dlqAttributes(), mainQueueAttributes('arn:dlq', 5), eventsQueueAttributes()]) {
      expect(attrs.FifoQueue).toBe('true');
      expect(attrs.ContentBasedDeduplication).toBe('false');
    }
  });

  it('points the redrive policy at the DLQ with the receive limit', () => {
    const attrs = mainQueueAttributes('arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo', 5);
    expect(JSON.parse(attrs.RedrivePolicy!)).toEqual({
      deadLetterTargetArn: 'arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo',
      maxReceiveCount: 5,
    });
  });

  it('rejects a receive limit that is not a positive integer', () => {
    expect(() => mainQueueAttributes('arn:dlq', 0)).toThrow();
    expect(() => mainQueueAttributes('arn:dlq', 2.5)).toThrow();
  });
});
