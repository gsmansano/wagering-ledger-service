import { DeleteQueueCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/config';
import type { ConvergenceTarget } from './convergence';
import { Cluster } from './instances';

const QUEUES = ['wager-transactions.fifo', 'wager-transactions-dlq.fifo', 'wager-events.fifo'];

export interface ClusterFixture {
  cluster: Cluster;
  sqs: SQSClient;
  target: Pick<ConvergenceTarget, 'wagerQueueUrl' | 'dlqUrl'>;
  /** Stops the instances and deletes the run's queues. */
  dispose(): Promise<void>;
}

/**
 * A cluster that owns its queues (a per-run prefix), so a running development stack cannot take its messages, with
 * every worker on and short intervals so retries and publication show up within a test's time.
 */
export async function startClusterFixture(instances: number, overrides: Record<string, string> = {}): Promise<ClusterFixture> {
  const prefix = `mi${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}-`;
  const { sqs: sqsConfig } = loadConfig();
  const sqs = new SQSClient({
    endpoint: sqsConfig.endpoint,
    region: sqsConfig.region,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const queueUrl = async (name: string) => (await sqs.send(new GetQueueUrlCommand({ QueueName: `${prefix}${name}` }))).QueueUrl!;

  const cluster = await Cluster.start(instances, {
    env: {
      SQS_QUEUE_PREFIX: prefix,
      PENDING_REFERENCE_WORKER: 'on',
      PENDING_REFERENCE_POLL_MS: '200',
      PENDING_REFERENCE_BACKOFF_BASE_MS: '100',
      PENDING_REFERENCE_BACKOFF_CAP_MS: '1000',
      OUTBOX_WORKER: 'on',
      OUTBOX_POLL_MS: '100',
      SQS_CONSUMER: 'on',
      SQS_CONSUMER_CONCURRENCY: '2',
      SQS_WAIT_TIME_SECONDS: '1',
      SQS_RETRY_BASE_MS: '200',
      SQS_SHUTDOWN_TIMEOUT_MS: '3000',
      ...overrides,
    },
  });
  return {
    cluster,
    sqs,
    target: { wagerQueueUrl: await queueUrl(QUEUES[0]!), dlqUrl: await queueUrl(QUEUES[1]!) },
    async dispose() {
      await cluster.stopAll();
      for (const name of QUEUES) {
        await sqs.send(new DeleteQueueCommand({ QueueUrl: await queueUrl(name) })).catch(() => undefined);
      }
    },
  };
}
