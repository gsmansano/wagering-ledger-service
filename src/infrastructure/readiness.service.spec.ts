import { describe, expect, it } from 'bun:test';
import { ReadinessService } from './readiness.service';

const ok = () => Promise.resolve();
const fails = () => Promise.reject(new Error('refused'));
const hangs = () => new Promise<never>(() => {});

describe('ReadinessService', () => {
  it('is ready when both dependencies answer', async () => {
    const report = await new ReadinessService({ pingPostgres: ok, pingSqs: ok }).check();
    expect(report).toEqual({ ready: true, checks: { postgres: 'up', sqs: 'up' } });
  });

  it('names the dependency that is down', async () => {
    const pg = await new ReadinessService({ pingPostgres: fails, pingSqs: ok }).check();
    expect(pg).toEqual({ ready: false, checks: { postgres: 'down', sqs: 'up' } });
    const sqs = await new ReadinessService({ pingPostgres: ok, pingSqs: fails }).check();
    expect(sqs).toEqual({ ready: false, checks: { postgres: 'up', sqs: 'down' } });
  });

  it('treats a dependency that never answers as down, at the timeout', async () => {
    const started = Date.now();
    const report = await new ReadinessService({ pingPostgres: hangs, pingSqs: hangs }, 50).check();
    expect(report).toEqual({ ready: false, checks: { postgres: 'down', sqs: 'down' } });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('checks both dependencies in parallel, so one slow probe does not add to the other', async () => {
    const slow = () => new Promise((resolve) => setTimeout(resolve, 150));
    const started = Date.now();
    await new ReadinessService({ pingPostgres: slow, pingSqs: slow }, 1_000).check();
    expect(Date.now() - started).toBeLessThan(290);
  });

  it('reports each failure to the callback, with the dependency name', async () => {
    const seen: string[] = [];
    await new ReadinessService({ pingPostgres: fails, pingSqs: ok }, 100, (name) => seen.push(name)).check();
    expect(seen).toEqual(['postgres']);
  });

  it('passes an abort signal to the SQS probe that fires at the timeout', async () => {
    let aborted = false;
    await new ReadinessService(
      { pingPostgres: ok, pingSqs: (signal) => new Promise(() => signal.addEventListener('abort', () => (aborted = true))) },
      30,
    ).check();
    expect(aborted).toBe(true);
  });
});
