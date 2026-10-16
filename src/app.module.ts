import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/unit-of-work';
import type { ReferenceRetryPolicy } from './application/transaction/reference-retry-policy';
import { GetLedger } from './application/query/get-ledger';
import { GetTransaction } from './application/query/get-transaction';
import { GetWallet } from './application/query/get-wallet';
import { ProcessWagerTransaction } from './application/transaction/process-wager-transaction';
import { ResolvePendingReference } from './application/transaction/resolve-pending-reference';
import { CreateWallet } from './application/wallet/create-wallet';
import { loadConfig } from './config';
import { createOrmConfig } from './infrastructure/database/mikro-orm.config';
import { newId } from './infrastructure/id-generator';
import { MikroOrmUnitOfWork } from './infrastructure/database/repositories/mikro-orm-unit-of-work';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { ApplicationErrorFilter } from './interfaces/http/application-error.filter';
import { HealthController } from './interfaces/http/health.controller';
import { ProvidersController } from './interfaces/http/providers.controller';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';

const REFERENCE_RETRY = Symbol('ReferenceRetryPolicy');

@Module({
  imports: [
    // forRootAsync reads config at module init, so tests can set env vars before booting the app.
    MikroOrmModule.forRootAsync({
      useFactory: () => createOrmConfig(loadConfig().databaseUrl),
      // Lets Nest inject the PostgreSQL-specific EntityManager.
      driver: PostgreSqlDriver,
    }),
    SqsModule,
  ],
  controllers: [HealthController, WalletsController, WageringController, ProvidersController],
  providers: [
    { provide: APP_FILTER, useClass: ApplicationErrorFilter },
    { provide: UNIT_OF_WORK, useFactory: (em: EntityManager) => new MikroOrmUnitOfWork(em), inject: [EntityManager] },
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
      useFactory: (unitOfWork: UnitOfWork, referenceRetry: ReferenceRetryPolicy) =>
        new ProcessWagerTransaction({ unitOfWork, now: () => new Date(), newId, referenceRetry }),
      inject: [UNIT_OF_WORK, REFERENCE_RETRY],
    },
    {
      provide: ResolvePendingReference,
      useFactory: (unitOfWork: UnitOfWork, referenceRetry: ReferenceRetryPolicy) =>
        new ResolvePendingReference({ unitOfWork, now: () => new Date(), newId, referenceRetry }),
      inject: [UNIT_OF_WORK, REFERENCE_RETRY],
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
