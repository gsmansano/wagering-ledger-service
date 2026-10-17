import { describe, expect, it } from 'bun:test';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('uses the defaults when nothing is set', () => {
    const config = loadConfig({});
    expect(config.walletLockTimeoutMs).toBe(5_000);
    expect(config.databasePoolMax).toBe(10);
  });

  it('reads numeric settings, and treats an empty value as unset', () => {
    const config = loadConfig({ WALLET_LOCK_TIMEOUT_MS: '250', DATABASE_POOL_MAX: '', OUTBOX_POLL_MS: '0' });
    expect(config.walletLockTimeoutMs).toBe(250);
    expect(config.databasePoolMax).toBe(10);
    expect(config.outbox.pollIntervalMs).toBe(0);
  });

  it.each(['abc', '-1', 'NaN', 'Infinity', '5s'])('rejects %p, naming the variable, instead of failing later', (value) => {
    expect(() => loadConfig({ WALLET_LOCK_TIMEOUT_MS: value })).toThrow(/WALLET_LOCK_TIMEOUT_MS/);
  });
});
