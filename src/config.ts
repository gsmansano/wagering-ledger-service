export interface AppConfig {
  port: number;
  databaseUrl: string;
  sqs: {
    endpoint: string;
    region: string;
    maxReceiveCount: number;
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
}

// Defaults match the host-mapped ports in docker-compose.yml. Inside Compose,
// the app overrides them with service names (postgres:5432, ministack:4566).
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering',
    sqs: {
      endpoint: env.SQS_ENDPOINT ?? 'http://localhost:4566',
      region: env.AWS_REGION ?? 'us-east-1',
      maxReceiveCount: Number(env.SQS_MAX_RECEIVE_COUNT ?? 5),
    },
    pendingReference: {
      workerEnabled: (env.PENDING_REFERENCE_WORKER ?? 'on') !== 'off',
      pollIntervalMs: Number(env.PENDING_REFERENCE_POLL_MS ?? 1_000),
      batchSize: Number(env.PENDING_REFERENCE_BATCH_SIZE ?? 50),
      maxAttempts: Number(env.PENDING_REFERENCE_MAX_ATTEMPTS ?? 10),
      backoffBaseMs: Number(env.PENDING_REFERENCE_BACKOFF_BASE_MS ?? 1_000),
      backoffCapMs: Number(env.PENDING_REFERENCE_BACKOFF_CAP_MS ?? 300_000),
    },
  };
}
