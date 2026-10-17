import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { expect } from 'bun:test';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ConvergenceTarget {
  /** Distinct transactions the load submitted; the database must end up with exactly this many (OPENING excluded). */
  expectedTransactions: number;
  wagerQueueUrl: string;
  dlqUrl: string;
}

interface Snapshot {
  transactions: number;
  unsettled: number;
  unpublished: number;
  queueMessages: number;
  dlqMessages: number;
}

async function snapshot(orm: MikroORM, sqs: SQSClient, target: ConvergenceTarget): Promise<Snapshot> {
  const [row] = await orm.em.getConnection().execute<{ transactions: string; unsettled: string; unpublished: string }[]>(
    `select (select count(*) from wager_transactions where kind <> 'OPENING') as transactions,
            (select count(*) from wager_transactions where status in ('PENDING', 'PENDING_REFERENCE')) as unsettled,
            (select count(*) from outbox_messages where published_at is null and failed_at is null) as unpublished`,
  );
  const depth = async (url: string) => {
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'],
      }),
    );
    return Object.values(Attributes ?? {}).reduce((sum, n) => sum + Number(n), 0);
  };
  return {
    transactions: Number(row!.transactions),
    unsettled: Number(row!.unsettled),
    unpublished: Number(row!.unpublished),
    queueMessages: await depth(target.wagerQueueUrl),
    dlqMessages: await depth(target.dlqUrl),
  };
}

/**
 * Polls until the system is quiet: every submitted transaction has a row and none is still pending, the wager queue
 * is empty (nothing visible, nothing in flight) and the outbox has nothing left to publish. Conditions, never a
 * fixed sleep. The state must hold on two consecutive looks, because the queue counters are approximate.
 */
export async function waitForConvergence(orm: MikroORM, sqs: SQSClient, target: ConvergenceTarget, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let quiet = 0;
  let last: Snapshot | undefined;
  while (Date.now() < deadline) {
    last = await snapshot(orm, sqs, target);
    const done =
      last.transactions === target.expectedTransactions &&
      last.unsettled === 0 &&
      last.unpublished === 0 &&
      last.queueMessages === 0;
    quiet = done ? quiet + 1 : 0;
    if (quiet >= 2) return;
    await sleep(250);
  }
  throw new Error(`No convergence in ${timeoutMs} ms; expected ${target.expectedTransactions} transactions, last look: ${JSON.stringify(last)}`);
}

/**
 * The invariants that must hold for every wallet once the system is quiet (§6.4, §8, §11). Each check is a single
 * SQL statement over the whole database and returns the offending wallets, so a failure names them.
 */
export async function assertInvariants(orm: MikroORM, sqs: SQSClient, target: ConvergenceTarget): Promise<void> {
  const db = orm.em.getConnection();
  const rows = <T>(sql: string) => db.execute<T[]>(sql);

  // balance == the signed sum of the ledger
  expect(
    await rows(`select w.id from wallets w left join ledger_entries e on e.wallet_id = w.id
                 group by w.id, w.balance
                having w.balance <> coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)`),
    'wallets whose balance differs from their ledger',
  ).toEqual([]);

  // the ledger is a gapless chain: sequence 1..n, each entry starts where the previous one ended, the first at 0.00
  expect(
    await rows(`select wallet_id from (
                  select wallet_id, sequence, balance_before,
                         lag(balance_after) over (partition by wallet_id order by sequence) as previous_after,
                         lag(sequence) over (partition by wallet_id order by sequence) as previous_sequence
                    from ledger_entries) chain
                 where balance_before <> coalesce(previous_after, 0)
                    or sequence <> coalesce(previous_sequence, 0) + 1`),
    'wallets whose ledger chain is broken',
  ).toEqual([]);

  // every processed transaction that moves money has exactly one entry, and nothing else has one
  expect(
    await rows(`select t.id from wager_transactions t left join ledger_entries e on e.transaction_id = t.id
                 group by t.id, t.status, t.kind
                having count(e.id) <> case when t.status = 'PROCESSED' and t.kind <> 'LOSS' then 1 else 0 end`),
    'transactions whose ledger entries do not match their outcome',
  ).toEqual([]);

  // no transaction ended in an unexpected state: no FAILED, nothing still waiting
  expect(
    await rows(`select id, status from wager_transactions where status not in ('PROCESSED', 'REJECTED')`),
    'transactions that are not settled',
  ).toEqual([]);

  // one row per submitted transaction: duplicates created nothing, nothing was lost
  const [counts] = await rows<{ n: string; distinct_keys: string }>(
    `select count(*) as n, count(distinct (provider_id, external_transaction_id)) as distinct_keys
       from wager_transactions where kind <> 'OPENING'`,
  );
  expect(Number(counts!.n)).toBe(target.expectedTransactions);
  expect(Number(counts!.distinct_keys)).toBe(target.expectedTransactions);

  // the outbox: everything published, nothing parked, and each wallet's balance events form an unbroken chain
  expect(await rows(`select id from outbox_messages where published_at is null`), 'unpublished events').toEqual([]);
  expect(await rows(`select id from outbox_messages where failed_at is not null`), 'parked events').toEqual([]);
  expect(
    await rows(`select aggregate_id from (
                  select aggregate_id,
                         (payload->'data'->>'walletVersion')::int as version,
                         payload->'data'->'balanceBefore'->>'amount' as before_amount,
                         lag(payload->'data'->'balanceAfter'->>'amount') over w as previous_after,
                         lag((payload->'data'->>'walletVersion')::int) over w as previous_version
                    from outbox_messages where event_type = 'WalletBalanceChanged'
                  window w as (partition by aggregate_id order by sequence)) chain
                 where (previous_version is not null and version <> previous_version + 1)
                    or (previous_after is not null and before_amount::numeric <> previous_after::numeric)`),
    'wallets whose balance events are out of order or have a gap',
  ).toEqual([]);
  // ...and the last event of each wallet agrees with the stored wallet
  expect(
    await rows(`select w.id from wallets w
                 where (select (payload->'data'->>'walletVersion')::int from outbox_messages
                         where aggregate_id = w.id and event_type = 'WalletBalanceChanged'
                         order by sequence desc limit 1) is distinct from w.version
                   and exists (select 1 from outbox_messages where aggregate_id = w.id and event_type = 'WalletBalanceChanged')`),
    'wallets whose last balance event disagrees with the wallet',
  ).toEqual([]);

  // the dead-letter queue is empty: no message was parked as poison
  expect((await snapshot(orm, sqs, target)).dlqMessages, 'messages in the DLQ').toBe(0);
}
