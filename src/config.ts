export interface AppConfig {
  port: number;
  /** Minimum level of the JSON log: trace, debug, info, warn, error, fatal or silent. */
  logLevel: string;
  databaseUrl: string;
  /** Connections one instance may hold. A request waiting for the wallet lock holds one for the whole wait. */
  databasePoolMax: number;
  /** Longest total wait for a wallet lock before the request gets a retryable 503; 0 waits without limit (#65). */
  walletLockTimeoutMs: number;
  /** How long the scrape-time gauges of `/metrics` are reused; 0 reads PostgreSQL and SQS on every scrape. */
  metricsCacheMs: number;
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

/**
 * A non-negative number from the environment. A typo fails at start-up with the variable's name, instead of becoming
 * NaN and failing at the first request that uses it.
 */
function numberFrom(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  return value;
}

// Defaults match the host-mapped ports in docker-compose.yml. Inside Compose,
// the app overrides them with service names (postgres:5432, ministack:4566).
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    port: numberFrom(env, 'PORT', 3000),
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl: env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering',
    databasePoolMax: numberFrom(env, 'DATABASE_POOL_MAX', 10),
    walletLockTimeoutMs: numberFrom(env, 'WALLET_LOCK_TIMEOUT_MS', 5_000),
    metricsCacheMs: numberFrom(env, 'METRICS_CACHE_MS', 5_000),
    sqs: {
      endpoint: env.SQS_ENDPOINT ?? 'http://localhost:4566',
      region: env.AWS_REGION ?? 'us-east-1',
      maxReceiveCount: numberFrom(env, 'SQS_MAX_RECEIVE_COUNT', 5),
      consumer: {
        enabled: (env.SQS_CONSUMER ?? 'on') !== 'off',
        // One message per receive (decision #67): a batch can hold later messages of a wallet, and handing them back
        // after an earlier one fails still spends their receives, so they could reach the DLQ without being processed.
        batchSize: numberFrom(env, 'SQS_CONSUMER_BATCH_SIZE', 1),
        pollers: numberFrom(env, 'SQS_CONSUMER_CONCURRENCY', 10),
        waitTimeSeconds: numberFrom(env, 'SQS_WAIT_TIME_SECONDS', 20),
        retryBaseMs: numberFrom(env, 'SQS_RETRY_BASE_MS', 1_000),
        retryCapMs: numberFrom(env, 'SQS_RETRY_CAP_MS', 300_000),
        shutdownTimeoutMs: numberFrom(env, 'SQS_SHUTDOWN_TIMEOUT_MS', 20_000),
      },
    },
    pendingReference: {
      workerEnabled: (env.PENDING_REFERENCE_WORKER ?? 'on') !== 'off',
      pollIntervalMs: numberFrom(env, 'PENDING_REFERENCE_POLL_MS', 1_000),
      batchSize: numberFrom(env, 'PENDING_REFERENCE_BATCH_SIZE', 50),
      maxAttempts: numberFrom(env, 'PENDING_REFERENCE_MAX_ATTEMPTS', 10),
      backoffBaseMs: numberFrom(env, 'PENDING_REFERENCE_BACKOFF_BASE_MS', 1_000),
      backoffCapMs: numberFrom(env, 'PENDING_REFERENCE_BACKOFF_CAP_MS', 300_000),
    },
    outbox: {
      workerEnabled: (env.OUTBOX_WORKER ?? 'on') !== 'off',
      pollIntervalMs: numberFrom(env, 'OUTBOX_POLL_MS', 500),
      batchSize: numberFrom(env, 'OUTBOX_BATCH_SIZE', 50),
      maxAttempts: numberFrom(env, 'OUTBOX_MAX_ATTEMPTS', 20),
      backoffBaseMs: numberFrom(env, 'OUTBOX_BACKOFF_BASE_MS', 1_000),
      backoffCapMs: numberFrom(env, 'OUTBOX_BACKOFF_CAP_MS', 300_000),
      sendTimeoutMs: numberFrom(env, 'OUTBOX_SEND_TIMEOUT_MS', 10_000),
    },
  };
}
