import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { loadConfig } from './config';

// bufferLogs holds Nest's start-up lines until the JSON logger replaces the default one.
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(app.get(Logger));
// Runs Nest's shutdown hooks on SIGTERM, which closes the ORM connection pool.
app.enableShutdownHooks();
await app.listen(loadConfig().port);
