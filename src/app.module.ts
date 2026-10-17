import { Logger, Module } from '@nestjs/common';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { LoggerModule } from 'nestjs-pino';
import { EntityManager, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/unit-of-work';
import type { ReferenceRetryPolicy } from './application/transaction/reference-retry-policy';
import { GetLedger } from './application/query/get-ledger';
import { GetTransaction } from './application/query/get-transaction';
import { GetWallet } from './application/query/get-wallet';
import { PublishOutbox } from './application/outbox/publish-outbox';
import { ProcessWagerTransaction } from './application/transaction/process-wager-transaction';
import { ResolvePendingReference } from './application/transaction/resolve-pending-reference';
import { CreateWallet } from './application/wallet/create-wallet';
import { ReconcileWallet } from './application/wallet/reconcile-wallet';
import { loadConfig } from './config';
import { createOrmConfig } from './infrastructure/database/mikro-orm.config';
import { newId } from './infrastructure/id-generator';
import { errorFields } from './infrastructure/logging/log-fields';
import { MikroOrmUnitOfWork } from './infrastructure/database/repositories/mikro-orm-unit-of-work';
import { readOutboxStats } from './infrastructure/database/outbox-stats';
import { PrometheusMetrics } from './infrastructure/metrics/prometheus-metrics';
import { queueDepth } from './infrastructure/messaging/queue-depth';
import { MetricsController } from './interfaces/http/metrics.controller';
import { ReadinessService } from './infrastructure/readiness.service';
import { OutboxWorker } from './infrastructure/workers/outbox.worker';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { EVENTS_QUEUE, WAGER_DLQ, WAGER_QUEUE } from './infrastructure/messaging/queue-names';
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { SqsConsumer } from './interfaces/sqs/sqs-consumer';
import { WagerMessageHandler } from './interfaces/sqs/wager-message.handler';
import { AuthGuard } from './interfaces/http/auth/auth.guard';
import { ApplicationErrorFilter } from './interfaces/http/application-error.filter';
import { createLoggerParams } from './interfaces/http/logger-params';
import { HealthController } from './interfaces/http/health.controller';
import { ProvidersController } from './interfaces/http/providers.controller';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';

const REFERENCE_RETRY = Symbol('ReferenceRetryPolicy');

@Module({
  imports: [
    // forRootAsync reads config at module init, so tests can set env vars before booting the app.
    MikroOrmModule.forRootAsync({
      useFactory: () => {
        const { databaseUrl, databasePoolMax } = loadConfig();
        return createOrmConfig(databaseUrl, databasePoolMax);
      },
      // Lets Nest inject the PostgreSQL-specific EntityManager.
      driver: PostgreSqlDriver,
    }),
    LoggerModule.forRootAsync({ imports: [], providers: [], useFactory: () => createLoggerParams(loadConfig().logLevel) }),
    SqsModule,
  ],
  controllers: [HealthController, MetricsController, WalletsController, WageringController, ProvidersController],
  providers: [
    { provide: APP_FILTER, useClass: ApplicationErrorFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
    {
      provide: ReadinessService,
      useFactory: (em: EntityManager, sqs: SQSClient) =>
        new ReadinessService(
          {
            pingPostgres: () => em.getConnection().execute('select 1'),
            pingSqs: (signal) => sqs.send(new GetQueueUrlCommand({ QueueName: WAGER_QUEUE }), { abortSignal: signal }),
          },
          2_000,
          (dependency, error) =>
            new Logger(ReadinessService.name).warn(
              { event: 'dependency_not_ready', dependency, ...errorFields(error) },
              'A dependency is not ready',
            ),
        ),
      inject: [EntityManager, SQSClient],
    },
    {
      provide: PrometheusMetrics,
      useFactory: (em: EntityManager, sqs: SQSClient, readiness: ReadinessService) =>
        new PrometheusMetrics(
          {
            outbox: () => readOutboxStats(em),
            dlqDepth: () => queueDepth(sqs, WAGER_DLQ),
            readiness: () => readiness.check(),
          },
          loadConfig().metricsCacheMs,
        ),
      inject: [EntityManager, SQSClient, ReadinessService],
    },
    {
      provide: ReconcileWallet,
      useFactory: (unitOfWork: UnitOfWork, metrics: PrometheusMetrics) => new ReconcileWallet(unitOfWork, metrics),
      inject: [UNIT_OF_WORK, PrometheusMetrics],
    },
    {
      provide: UNIT_OF_WORK,
      useFactory: (em: EntityManager) => new MikroOrmUnitOfWork(em, loadConfig().walletLockTimeoutMs),
      inject: [EntityManager],
    },
    {
      provide: CreateWallet,
      useFactory: (unitOfWork: UnitOfWork) =>
        new CreateWallet({ unitOfWork, now: () => new Date(), newId }),
      inject: [UNIT_OF_WORK],
    },
    { provide: GetWallet, useFactory: (unitOfWork: UnitOfWork) => new GetWallet(unitOfWork), inject: [UNIT_OF_WORK] },
    { provide: GetLedger, useFactory: (unitOfWork: UnitOfWork) => new GetLedger(unitOfWork), inject: [UNIT_OF_WORK] },
    {
      provide: GetTransaction,
      useFactory: (unitOfWork: UnitOfWork) => new GetTransaction(unitOfWork),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: REFERENCE_RETRY,
      useFactory: (): ReferenceRetryPolicy => {
        const { maxAttempts, backoffBaseMs, backoffCapMs } = loadConfig().pendingReference;
        return { maxAttempts, baseMs: backoffBaseMs, capMs: backoffCapMs };
      },
    },
    {
      provide: ProcessWagerTransaction,
      useFactory: (unitOfWork: UnitOfWork, referenceRetry: ReferenceRetryPolicy, metrics: PrometheusMetrics) =>
        new ProcessWagerTransaction({ unitOfWork, now: () => new Date(), newId, referenceRetry, metrics }),
      inject: [UNIT_OF_WORK, REFERENCE_RETRY, PrometheusMetrics],
    },
    {
      provide: ResolvePendingReference,
      useFactory: (unitOfWork: UnitOfWork, referenceRetry: ReferenceRetryPolicy, metrics: PrometheusMetrics) =>
        new ResolvePendingReference({ unitOfWork, now: () => new Date(), newId, referenceRetry, metrics }),
      inject: [UNIT_OF_WORK, REFERENCE_RETRY, PrometheusMetrics],
    },
    {
      provide: SqsConsumer,
      useFactory: (sqs: SQSClient, processTransaction: ProcessWagerTransaction, metrics: PrometheusMetrics) => {
        const { consumer } = loadConfig().sqs;
        const handler = new WagerMessageHandler(processTransaction, { baseMs: consumer.retryBaseMs, capMs: consumer.retryCapMs });
        return new SqsConsumer(
          sqs,
          handler,
          {
            enabled: consumer.enabled,
            queueName: WAGER_QUEUE,
            dlqName: WAGER_DLQ,
            batchSize: consumer.batchSize,
            pollers: consumer.pollers,
            waitTimeSeconds: consumer.waitTimeSeconds,
            shutdownTimeoutMs: consumer.shutdownTimeoutMs,
          },
          metrics,
        );
      },
      inject: [SQSClient, ProcessWagerTransaction, PrometheusMetrics],
    },
    {
      provide: SqsEventPublisher,
      useFactory: (sqs: SQSClient) => new SqsEventPublisher(sqs, EVENTS_QUEUE, loadConfig().outbox.sendTimeoutMs),
      inject: [SQSClient],
    },
    {
      provide: PublishOutbox,
      useFactory: (unitOfWork: UnitOfWork, publisher: SqsEventPublisher) => {
        const { maxAttempts, backoffBaseMs, backoffCapMs } = loadConfig().outbox;
        return new PublishOutbox({
          unitOfWork,
          publisher,
          now: () => new Date(),
          retry: { maxAttempts, baseMs: backoffBaseMs, capMs: backoffCapMs },
        });
      },
      inject: [UNIT_OF_WORK, SqsEventPublisher],
    },
    {
      provide: OutboxWorker,
      useFactory: (publishOutbox: PublishOutbox, metrics: PrometheusMetrics) => {
        const { workerEnabled, pollIntervalMs, batchSize } = loadConfig().outbox;
        return new OutboxWorker(publishOutbox, { enabled: workerEnabled, pollIntervalMs, batchSize }, metrics);
      },
      inject: [PublishOutbox, PrometheusMetrics],
    },
    {
      provide: PendingReferenceWorker,
      useFactory: (resolvePending: ResolvePendingReference) => {
        const { workerEnabled, pollIntervalMs, batchSize } = loadConfig().pendingReference;
        return new PendingReferenceWorker(resolvePending, { enabled: workerEnabled, pollIntervalMs, batchSize });
      },
      inject: [ResolvePendingReference],
    },
  ],
})
export class AppModule {}
