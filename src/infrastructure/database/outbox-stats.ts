import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxStats } from '../metrics/prometheus-metrics';

/**
 * One statement over the unpublished rows (the partial indexes of the claim query cover them). The lag is the age of
 * the oldest event that has not gone out and is not itself parked. Events held behind a parked event of the same
 * wallet (decision #58) are not parked, so they count: while a wallet is held the lag keeps growing and `pending`
 * includes its held events. That is deliberate (a stuck wallet is loud); `parked` is the count that tells a held
 * wallet apart from a slow publisher.
 */
export async function readOutboxStats(em: EntityManager): Promise<OutboxStats> {
  const rows = await em.getConnection().execute<{ pending: string; parked: string; lag_seconds: string }[]>(
    `select count(*) filter (where failed_at is null) as pending,
            count(*) filter (where failed_at is not null) as parked,
            coalesce(extract(epoch from now() - min(occurred_at) filter (where failed_at is null)), 0) as lag_seconds
       from outbox_messages
      where published_at is null`,
  );
  const row = rows[0]!; // an aggregate without GROUP BY always returns one row
  return { pending: Number(row.pending), parked: Number(row.parked), lagSeconds: Math.max(0, Number(row.lag_seconds)) };
}
