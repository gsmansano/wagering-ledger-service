import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { loadConfig } from './config';
import { createOrmConfig } from './infrastructure/database/mikro-orm.config';
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
})
export class AppModule {}
