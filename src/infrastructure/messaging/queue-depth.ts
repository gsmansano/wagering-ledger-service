import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';

const TIMEOUT_MS = 2_000;

/** Messages waiting in a queue (the SQS figure is approximate by design). */
export async function queueDepth(sqs: SQSClient, queueName: string): Promise<number> {
  const abortSignal = AbortSignal.timeout(TIMEOUT_MS);
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }), { abortSignal });
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
    { abortSignal },
  );
  return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
}
