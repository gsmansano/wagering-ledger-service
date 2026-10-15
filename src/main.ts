import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';

const app = await NestFactory.create(AppModule);
// Runs Nest's shutdown hooks on SIGTERM, which closes the ORM connection pool.
app.enableShutdownHooks();
await app.listen(loadConfig().port);
