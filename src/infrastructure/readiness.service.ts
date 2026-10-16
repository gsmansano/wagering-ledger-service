export interface ReadinessProbes {
  /** Resolves when PostgreSQL answers a trivial query. */
  pingPostgres(): Promise<unknown>;
  /** Resolves when the SQS emulator answers; receives a signal that aborts the call at the timeout. */
  pingSqs(signal: AbortSignal): Promise<unknown>;
}

export type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  ready: boolean;
  checks: { postgres: DependencyStatus; sqs: DependencyStatus };
}

/**
 * Readiness (spec §9, decision #48): can this instance do useful work right now? Each dependency gets the same
 * short timeout, so a hung one reads as down instead of hanging the probe. Liveness is separate and checks nothing.
 */
export class ReadinessService {
  constructor(
    private readonly probes: ReadinessProbes,
    private readonly timeoutMs = 2_000,
    private readonly onFailure: (dependency: string, error: unknown) => void = () => {},
  ) {}

  async check(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([
      this.probe('postgres', (signal) => this.probes.pingPostgres().then(() => signal.throwIfAborted())),
      this.probe('sqs', (signal) => this.probes.pingSqs(signal)),
    ]);
    return { ready: postgres === 'up' && sqs === 'up', checks: { postgres, sqs } };
  }

  private async probe(name: string, run: (signal: AbortSignal) => Promise<unknown>): Promise<DependencyStatus> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      // The race makes a probe that ignores the signal (a hung pool) still end at the timeout.
      await Promise.race([
        run(signal),
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
      ]);
      return 'up';
    } catch (error) {
      this.onFailure(name, error);
      return 'down';
    }
  }
}
