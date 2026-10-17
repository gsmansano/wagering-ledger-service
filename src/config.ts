export interface AppConfig {
  port: number;
  databaseUrl: string;
  /** Connections one instance may hold. A request waiting for the wallet lock holds one for the whole wait. */
  databasePoolMax: number;
  sqs: {
    endpoint: string;
    region: string;
    maxReceiveCount: number;
    /** The queue consumer (decisions #52 to #55). */
    consumer: {
      enabled: boolean;
      batchSize: number;
      pollers: number;
      waitTimeSeconds: number;
      retryBaseMs: number;
      retryCapMs: number;
      shutdownTimeoutMs: number;
    };
  };
  /** Retry of reversals waiting for their reference (decisions #39 and #40). */
  pendingReference: {
    workerEnabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
    maxAttempts: number;
    backoffBaseMs: number;
    backoffCapMs: number;
  };
  /** Publication of outbox events (decisions #56 to #59). */
  outbox: {
    workerEnabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
    maxAttempts: number;
    backoffBaseMs: number;
    backoffCapMs: number;
    sendTimeoutMs: number;
  };
}

// Defaults match the host-mapped ports in docker-compose.yml. Inside Compose,
// the app overrides them with service names (postgres:5432, ministack:4566).
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering',
    databasePoolMax: Number(env.DATABASE_POOL_MAX ?? 10),
    sqs: {
      endpoint: env.SQS_ENDPOINT ?? 'http://localhost:4566',
      region: env.AWS_REGION ?? 'us-east-1',
      maxReceiveCount: Number(env.SQS_MAX_RECEIVE_COUNT ?? 5),
      consumer: {
        enabled: (env.SQS_CONSUMER ?? 'on') !== 'off',
        batchSize: Number(env.SQS_CONSUMER_BATCH_SIZE ?? 10),
        pollers: Number(env.SQS_CONSUMER_CONCURRENCY ?? 1),
        waitTimeSeconds: Number(env.SQS_WAIT_TIME_SECONDS ?? 20),
        retryBaseMs: Number(env.SQS_RETRY_BASE_MS ?? 1_000),
        retryCapMs: Number(env.SQS_RETRY_CAP_MS ?? 300_000),
        shutdownTimeoutMs: Number(env.SQS_SHUTDOWN_TIMEOUT_MS ?? 20_000),
      },
    },
    pendingReference: {
      workerEnabled: (env.PENDING_REFERENCE_WORKER ?? 'on') !== 'off',
      pollIntervalMs: Number(env.PENDING_REFERENCE_POLL_MS ?? 1_000),
      batchSize: Number(env.PENDING_REFERENCE_BATCH_SIZE ?? 50),
      maxAttempts: Number(env.PENDING_REFERENCE_MAX_ATTEMPTS ?? 10),
      backoffBaseMs: Number(env.PENDING_REFERENCE_BACKOFF_BASE_MS ?? 1_000),
      backoffCapMs: Number(env.PENDING_REFERENCE_BACKOFF_CAP_MS ?? 300_000),
    },
    outbox: {
      workerEnabled: (env.OUTBOX_WORKER ?? 'on') !== 'off',
      pollIntervalMs: Number(env.OUTBOX_POLL_MS ?? 500),
      batchSize: Number(env.OUTBOX_BATCH_SIZE ?? 50),
      maxAttempts: Number(env.OUTBOX_MAX_ATTEMPTS ?? 20),
      backoffBaseMs: Number(env.OUTBOX_BACKOFF_BASE_MS ?? 1_000),
      backoffCapMs: Number(env.OUTBOX_BACKOFF_CAP_MS ?? 300_000),
      sendTimeoutMs: Number(env.OUTBOX_SEND_TIMEOUT_MS ?? 10_000),
    },
  };
}
