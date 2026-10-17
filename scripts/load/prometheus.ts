// Just enough of the Prometheus text format to read this service's own /metrics output.

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export function parseMetrics(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z_:][\w:]*)(?:\{([^}]*)\})?\s+(\S+)$/.exec(line);
    if (match === null) continue; // comments and blank lines
    const labels: Record<string, string> = {};
    for (const pair of (match[2] ?? '').matchAll(/(\w+)="([^"]*)"/g)) labels[pair[1]!] = pair[2]!;
    samples.push({ name: match[1]!, labels, value: Number(match[3]!.toLowerCase() === 'nan' ? Number.NaN : match[3]) });
  }
  return samples;
}

export interface HistogramSnapshot {
  count: number;
  sum: number;
  /** Cumulative counts by upper bound (`Infinity` for +Inf). */
  buckets: Map<number, number>;
}

/** One histogram (optionally one label value) summed over the scraped instances. */
export function histogramOf(scrapes: Sample[][], name: string, label?: { key: string; value: string }): HistogramSnapshot {
  const out: HistogramSnapshot = { count: 0, sum: 0, buckets: new Map() };
  for (const samples of scrapes) {
    for (const sample of samples) {
      if (label !== undefined && sample.labels[label.key] !== label.value) continue;
      if (sample.name === `${name}_count`) out.count += sample.value;
      else if (sample.name === `${name}_sum`) out.sum += sample.value;
      else if (sample.name === `${name}_bucket`) {
        const bound = sample.labels.le === '+Inf' ? Number.POSITIVE_INFINITY : Number(sample.labels.le);
        out.buckets.set(bound, (out.buckets.get(bound) ?? 0) + sample.value);
      }
    }
  }
  return out;
}

export function histogramDelta(after: HistogramSnapshot, before: HistogramSnapshot): HistogramSnapshot {
  const buckets = new Map<number, number>();
  for (const [bound, value] of after.buckets) buckets.set(bound, value - (before.buckets.get(bound) ?? 0));
  return { count: after.count - before.count, sum: after.sum - before.sum, buckets };
}

/** The upper bound of the bucket holding the quantile: a histogram cannot say more than "at most this". */
export function quantileUpperBound(histogram: HistogramSnapshot, quantile: number): number | undefined {
  if (histogram.count <= 0) return undefined;
  const target = histogram.count * quantile;
  for (const bound of [...histogram.buckets.keys()].sort((a, b) => a - b)) {
    if (histogram.buckets.get(bound)! >= target) return bound;
  }
  return undefined;
}

export function gaugeOf(samples: Sample[], name: string): number | undefined {
  return samples.find((sample) => sample.name === name)?.value;
}
