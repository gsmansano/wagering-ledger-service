import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Controller, Get, Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger as PinoNestLogger, LoggerModule, PinoLogger } from 'nestjs-pino';
import { errorFields } from '../../src/infrastructure/logging/log-fields';
import { createLoggerParams } from '../../src/interfaces/http/logger-params';

// The allowlist is applied by the logger configuration, not by the call sites. This sends forbidden fields through
// every route a field can take (an `assign` on the request, a log call, an error) with the real configuration and
// reads what was written. It found that pino's own formatters let `assign` through; the line filter closes that.
const SECRET_AMOUNT = '987.65';
const lines: Record<string, unknown>[] = [];

@Controller('probe')
class ProbeController {
  constructor(private readonly requestLog: PinoLogger) {}
  private readonly logger = new Logger('Probe');

  @Get()
  probe() {
    this.requestLog.assign({ walletId: 'wallet-1', amount: SECRET_AMOUNT, balance: SECRET_AMOUNT });
    this.logger.warn({ event: 'probe', status: 'REJECTED', amount: SECRET_AMOUNT, playerId: 'player-secret' }, 'A log call');
    this.logger.error({ event: 'probe_error', ...errorFields(new Error(`Failing row contains (${SECRET_AMOUNT})`)) }, 'An error');
    return { ok: true };
  }
}

describe('log allowlist through the real logger configuration', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const params = createLoggerParams('info', (line) => void lines.push(JSON.parse(line) as Record<string, unknown>));
    const moduleRef = await Test.createTestingModule({ imports: [LoggerModule.forRoot(params)], controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication();
    app.useLogger(app.get(PinoNestLogger));
    await app.listen(0);
  });
  afterAll(async () => {
    await app.close();
  });

  it('writes the allowed fields and drops money, player data and the error message, on every route', async () => {
    const res = await fetch(`${await app.getUrl()}/probe`, { headers: { 'x-correlation-id': 'corr-allow-1' } });
    expect(res.status).toBe(200);
    await Bun.sleep(50);

    const request = lines.find((line) => line.msg === 'request completed');
    expect(request).toMatchObject({ correlationId: 'corr-allow-1', walletId: 'wallet-1', res: { statusCode: 200 } });
    const call = lines.find((line) => line.event === 'probe');
    expect(call).toMatchObject({ status: 'REJECTED', walletId: 'wallet-1' }); // allowed fields survive, bindings included
    const failure = lines.find((line) => line.event === 'probe_error');
    expect(failure).toMatchObject({ errorName: 'Error' });
    expect(failure!.errorStack).toContain('at ');

    const everything = JSON.stringify(lines);
    for (const forbidden of [SECRET_AMOUNT, 'player-secret', '"amount"', '"balance"', '"playerId"', '"errorMessage"']) {
      expect(everything).not.toContain(forbidden);
    }
  });
});
