export interface AppConfig {
  port: number;
  databaseUrl: string;
  sqs: {
    endpoint: string;
    region: string;
    maxReceiveCount: number;
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
  };
}
