/**
 * Placing annotations on a time chart. A chart's points carry their bucket
 * (`2026-03-01`, `2026-03-01T10:00:00Z`): the start of the hour, day, week or
 * month they count. An annotation belongs to the bucket it falls in, read as
 * UTC like the chart's labels.
 */

const DAY_MS = 86_400_000;

/** A bucket's start in ms (UTC), or null when it is not a date. */
export function bucketTime(bucket: string): number | null {
  const [datePart = '', timePart] = bucket.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  if (!y || !m || !d) return null;
  const hour = timePart ? Number(timePart.slice(0, 2)) : 0;
  return Date.UTC(y, m - 1, d, Number.isFinite(hour) ? hour : 0);
}

/** Bucket starts in ms, in order; buckets that are not dates are left out. */
function times(buckets: readonly string[]): number[] {
  return buckets.map(bucketTime).filter((t): t is number => t !== null);
}

/** How long one bucket lasts: the gap between the first two, else a day. */
function bucketWidth(starts: readonly number[]): number {
  const width = starts.length >= 2 ? starts[1]! - starts[0]! : DAY_MS;
  return width > 0 ? width : DAY_MS;
}

/** The moments a chart covers (from its first bucket to the end of its last), for the annotations request. */
export function bucketRange(buckets: readonly string[]): { from: string; to: string } | null {
  const starts = times(buckets);
  if (starts.length === 0) return null;
  const first = Math.min(...starts);
  const last = Math.max(...starts);
  return { from: new Date(first).toISOString(), to: new Date(last + bucketWidth(starts) - 1).toISOString() };
}

/**
 * The index of the bucket each annotation falls in. Annotations outside the
 * chart are left out; buckets keep the order they have on the chart.
 */
export function annotationsByBucket<T extends { occurredAt: string }>(buckets: readonly string[], annotations: readonly T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  const indexed = buckets.map((bucket, index) => ({ index, start: bucketTime(bucket) })).filter((b): b is { index: number; start: number } => b.start !== null);
  if (indexed.length === 0) return out;
  const sorted = [...indexed].sort((a, b) => a.start - b.start);
  const width = bucketWidth(sorted.map((b) => b.start));
  const end = sorted[sorted.length - 1]!.start + width;
  for (const annotation of annotations) {
    const at = Date.parse(annotation.occurredAt);
    if (!Number.isFinite(at) || at < sorted[0]!.start || at >= end) continue;
    let match = sorted[0]!;
    for (const bucket of sorted) {
      if (bucket.start <= at) match = bucket;
      else break;
    }
    out.set(match.index, [...(out.get(match.index) ?? []), annotation]);
  }
  return out;
}

/** The moment to suggest for an annotation made by clicking a bucket: its start, or noon when it is a whole day or longer. */
export function annotationTimeForBucket(bucket: string): string | null {
  const start = bucketTime(bucket);
  if (start === null) return null;
  return new Date(bucket.includes('T') ? start : start + DAY_MS / 2).toISOString();
}
