import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { Cluster } from './instances';

export const PROVIDER_ID = 'provider-1';
export const CURRENCY = 'BRL';

export interface LoadWallet {
  id: string;
  playerId: string;
}

export interface WagerRequest {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/** One delivery of a request. A duplicate delivers the same request again, over either channel. */
export interface Operation {
  index: number;
  channel: 'http' | 'sqs';
  request: WagerRequest;
  /** The SQS message id; a duplicate may repeat the original's, which is what the inbox deduplicates. */
  messageId: string;
  /** Index of the operation this one repeats, if it is a duplicate. */
  duplicateOf?: number;
}

export interface LoadPlan {
  seed: number;
  operations: Operation[];
  /** Distinct transactions the plan submits (duplicates excluded). */
  distinctTransactions: number;
}

/** mulberry32: small, seedable and good enough to shuffle a test load; a failing seed is printed and replayable. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cents = (value: number): string => `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;

/**
 * Builds the whole load up front, from the seed alone, so a failure can be replayed. Mix: BET/WIN/LOSS, about 10%
 * duplicates (half over the other channel), reversals of earlier bets and wins, and a few reversals deliberately
 * placed before their reference (§7.1).
 */
export function planLoad(seed: number, wallets: LoadWallet[], size: number): LoadPlan {
  const rng = createRng(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(rng() * items.length)]!;
  const between = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
  const operations: Operation[] = [];
  const originals: Operation[] = [];
  const reversible: Operation[] = [];
  const reversed = new Set<number>();
  let distinct = 0;

  const add = (request: WagerRequest, channel: Operation['channel'], extra: Partial<Operation> = {}): Operation => {
    const index = operations.length;
    const operation: Operation = { index, channel, request, messageId: `msg-${seed}-${index}`, ...extra };
    operations.push(operation);
    return operation;
  };
  const request = (index: number, wallet: LoadWallet, kind: WagerRequest['kind'], amount: string, reference?: string): WagerRequest => ({
    providerId: PROVIDER_ID,
    externalTransactionId: `ext-${seed}-${index}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${between(1, 20)}`,
    gameId: 'game-1',
    kind,
    money: { amount, currency: CURRENCY },
    ...(reference !== undefined && { referenceExternalTransactionId: reference }),
  });
  const channel = (): Operation['channel'] => (rng() < 0.7 ? 'http' : 'sqs');
  const walletOf = (operation: Operation) => wallets.find((w) => w.id === operation.request.walletId)!;

  while (operations.length < size) {
    const roll = rng();
    const next = operations.length;
    if (roll < 0.1 && originals.length > 0) {
      const original = pick(originals);
      const other: Operation['channel'] = original.channel === 'http' ? 'sqs' : 'http';
      const sameMessage = original.channel === 'sqs' && rng() < 0.5;
      add(original.request, rng() < 0.5 ? original.channel : other, {
        duplicateOf: original.index,
        ...(sameMessage && { messageId: original.messageId }),
      });
    } else if (roll < 0.18 && reversible.length > 0) {
      const target = pick(reversible.filter((op) => !reversed.has(op.index)));
      if (target === undefined) continue;
      reversed.add(target.index);
      const kind = target.request.kind === 'BET' && rng() < 0.6 ? 'REFUND' : 'ROLLBACK';
      const op = add(
        request(next, walletOf(target), kind, target.request.money.amount, target.request.externalTransactionId),
        channel(),
      );
      originals.push(op);
      distinct += 1;
    } else if (roll < 0.22 && operations.length + 2 <= size) {
      // The reversal is planned first, its reference right after: it may arrive before what it reverses.
      const wallet = pick(wallets);
      const amount = cents(between(500, 6000));
      const referenceId = `ext-${seed}-${next + 1}`;
      originals.push(add(request(next, wallet, 'REFUND', amount, referenceId), channel()));
      const bet = add(request(next + 1, wallet, 'BET', amount), channel());
      originals.push(bet);
      reversed.add(bet.index);
      distinct += 2;
    } else {
      const wallet = pick(wallets);
      const kindRoll = rng();
      const kind: WagerRequest['kind'] = kindRoll < 0.55 ? 'BET' : kindRoll < 0.85 ? 'WIN' : 'LOSS';
      const op = add(request(next, wallet, kind, cents(between(500, kind === 'WIN' ? 9000 : 6000))), channel());
      originals.push(op);
      if (kind !== 'LOSS') reversible.push(op);
      distinct += 1;
    }
  }
  return { seed, operations, distinctTransactions: distinct };
}

export interface DeliveryRecord {
  operation: Operation;
  /** The instance that answered (HTTP) or `undefined` for a queue message. */
  instance?: number;
  httpStatus?: number;
  transactionId?: string;
  transactionStatus?: string;
  /** Extra attempts after a transient answer (503 or a refused connection); the same key is always resent. */
  retries: number;
}

export interface LoadOptions {
  concurrency: number;
  sqs: SQSClient;
  wagerQueueUrl: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_RETRIES = 8;

/**
 * Plays the plan with `concurrency` operations in flight. HTTP deliveries rotate over the running instances, and a
 * duplicate goes to a different instance than its original, so the same key meets two processes at once.
 */
export async function playLoad(cluster: Cluster, plan: LoadPlan, options: LoadOptions): Promise<DeliveryRecord[]> {
  const records: DeliveryRecord[] = new Array(plan.operations.length);
  let next = 0;

  const deliverHttp = async (operation: Operation): Promise<DeliveryRecord> => {
    const record: DeliveryRecord = { operation, retries: 0 };
    const base = operation.duplicateOf === undefined ? operation.index : operation.duplicateOf + 1 + operation.index;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const running = cluster.alive;
      if (running.length === 0) throw new Error('No running instance to deliver to');
      const target = running[(base + attempt) % running.length]!;
      try {
        const res = await fetch(`${target.url}/wagering/transactions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `${operation.request.providerId}:${operation.request.externalTransactionId}`,
          },
          body: JSON.stringify(operation.request),
          signal: AbortSignal.timeout(15_000),
        });
        const body = (await res.json()) as { transactionId?: string; status?: string }; // test-only: fields read one by one
        Object.assign(record, {
          instance: target.index,
          httpStatus: res.status,
          transactionId: body.transactionId,
          transactionStatus: body.status,
        });
        if (res.status !== 503) return record;
      } catch {
        // connection refused or reset: the instance is gone; the same key goes to another one
      }
      record.retries += 1;
      await sleep(50 * (attempt + 1));
    }
    return record;
  };

  const deliverSqs = async (operation: Operation): Promise<DeliveryRecord> => {
    await options.sqs.send(
      new SendMessageCommand({
        QueueUrl: options.wagerQueueUrl,
        MessageGroupId: operation.request.walletId,
        // FIFO drops a repeated deduplication id for five minutes; a redelivery must reach the consumer.
        MessageDeduplicationId: `d-${operation.index}-${crypto.randomUUID()}`,
        MessageBody: JSON.stringify({
          messageId: operation.messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            ...operation.request,
            idempotencyKey: `${operation.request.providerId}:${operation.request.externalTransactionId}`,
          },
        }),
      }),
    );
    return { operation, retries: 0 };
  };

  const worker = async () => {
    for (let i = next++; i < plan.operations.length; i = next++) {
      const operation = plan.operations[i]!;
      records[i] = operation.channel === 'http' ? await deliverHttp(operation) : await deliverSqs(operation);
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, worker));
  return records;
}

/** Creates the wallets through the first running instance, each with an opening balance that bets can exhaust. */
export async function openWallets(cluster: Cluster, count: number, openingAmount: string, tag: string): Promise<LoadWallet[]> {
  const wallets: LoadWallet[] = [];
  for (let i = 0; i < count; i += 1) {
    const instance = cluster.alive[i % cluster.alive.length]!;
    const playerId = `${tag}-player-${i}`;
    const res = await fetch(`${instance.url}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { currency: CURRENCY, amount: openingAmount } }),
    });
    if (res.status !== 201) throw new Error(`Could not open wallet ${playerId}: ${res.status} ${await res.text()}`);
    wallets.push({ id: ((await res.json()) as { id: string }).id, playerId });
  }
  return wallets;
}
