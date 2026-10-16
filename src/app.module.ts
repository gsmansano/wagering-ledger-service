import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/unit-of-work';
import { ProcessWagerTransaction } from './application/transaction/process-wager-transaction';
import { CreateWallet } from './application/wallet/create-wallet';
import { loadConfig } from './config';
import { createOrmConfig } from './infrastructure/database/mikro-orm.config';
import { MikroOrmUnitOfWork } from './infrastructure/database/repositories/mikro-orm-unit-of-work';
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { HealthController } from './interfaces/http/health.controller';

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
  controllers: [HealthController],
  providers: [
    { provide: UNIT_OF_WORK, useFactory: (em: EntityManager) => new MikroOrmUnitOfWork(em), inject: [EntityManager] },
    {
      provide: CreateWallet,
      useFactory: (unitOfWork: UnitOfWork) =>
        new CreateWallet({ unitOfWork, now: () => new Date(), newId: () => crypto.randomUUID() }),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: ProcessWagerTransaction,
      useFactory: (unitOfWork: UnitOfWork) =>
        new ProcessWagerTransaction({ unitOfWork, now: () => new Date(), newId: () => crypto.randomUUID() }),
      inject: [UNIT_OF_WORK],
    },
  ],
})
export class AppModule {}
