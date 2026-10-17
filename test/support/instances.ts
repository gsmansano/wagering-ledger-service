import type { Subprocess } from 'bun';

const READY_TIMEOUT_MS = 30_000;
const LOG_TAIL_LINES = 200;

export interface InstanceOptions {
  /** Extra environment for every instance, on top of the test process's own (which already targets the test database). */
  env?: Record<string, string>;
}

/** One real application process: its own event loop, its own connection pool, its own workers and consumer. */
class Instance {
  proc: Subprocess | undefined;
  readonly logs: string[] = [];

  constructor(
    readonly index: number,
    readonly port: number,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get alive(): boolean {
    return this.proc !== undefined && this.proc.exitCode === null && this.proc.signalCode === null;
  }
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const { port } = probe;
  await probe.stop(true);
  return port!;
}

/**
 * Starts the application several times as separate OS processes against the same database and queues (§8, §13).
 * Promise.all inside one process cannot show what happens when two instances take the same wallet lock or poll the
 * same queue; this can. Instances can be killed and started again, which the restart tests use.
 */
export class Cluster {
  private constructor(
    readonly instances: Instance[],
    private readonly env: Record<string, string>,
  ) {}

  static async start(count: number, options: InstanceOptions = {}): Promise<Cluster> {
    const ports = await Promise.all(Array.from({ length: count }, freePort));
    const cluster = new Cluster(
      ports.map((port, index) => new Instance(index, port)),
      options.env ?? {},
    );
    try {
      await Promise.all(cluster.instances.map((instance) => cluster.spawn(instance)));
    } catch (error) {
      await cluster.stopAll();
      throw error;
    }
    return cluster;
  }

  /** The instances currently running, in index order. */
  get alive(): Instance[] {
    return this.instances.filter((instance) => instance.alive);
  }

  /** Starts a stopped instance again on the same port and waits until it is ready. */
  async restart(index: number): Promise<void> {
    const instance = this.instances[index]!;
    if (instance.alive) throw new Error(`Instance ${index} is still running`);
    await this.spawn(instance);
  }

  /** SIGKILL is a crash: no shutdown hooks, nothing handed back to the queue. SIGTERM is the graceful stop. */
  async kill(index: number, signal: 'SIGKILL' | 'SIGTERM' = 'SIGKILL'): Promise<void> {
    const instance = this.instances[index]!;
    if (!instance.proc || !instance.alive) return;
    instance.proc.kill(signal);
    await instance.proc.exited;
  }

  async stopAll(signal: 'SIGKILL' | 'SIGTERM' = 'SIGTERM'): Promise<void> {
    await Promise.all(this.instances.map((instance) => this.kill(instance.index, signal)));
  }

  /** The last log lines of an instance, for a failure message. */
  tail(index: number, lines = 30): string {
    return this.instances[index]!.logs.slice(-lines).join('\n');
  }

  private async spawn(instance: Instance): Promise<void> {
    instance.logs.length = 0;
    instance.proc = Bun.spawn(['bun', 'src/main.ts'], {
      env: { ...process.env, ...this.env, PORT: String(instance.port) },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    for (const stream of [instance.proc.stdout, instance.proc.stderr] as ReadableStream<Uint8Array>[]) {
      void collect(stream, instance.logs);
    }
    await this.waitUntilReady(instance);
  }

  private async waitUntilReady(instance: Instance): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!instance.alive) throw new Error(`Instance ${instance.index} exited while starting:\n${this.tail(instance.index)}`);
      try {
        const res = await fetch(`${instance.url}/health/ready`, { signal: AbortSignal.timeout(2_000) });
        if (res.status === 200) return;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Instance ${instance.index} was not ready in ${READY_TIMEOUT_MS} ms:\n${this.tail(instance.index)}`);
  }
}

async function collect(stream: ReadableStream<Uint8Array>, into: string[]): Promise<void> {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    into.push(...lines);
    if (into.length > LOG_TAIL_LINES * 2) into.splice(0, into.length - LOG_TAIL_LINES);
  }
}
