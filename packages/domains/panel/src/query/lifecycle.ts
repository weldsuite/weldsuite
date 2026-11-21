/**
 * `lifecycle`: per bucket, who did the event for the first time (`new`),
 * again after doing it in the previous bucket (`returning`), again after a
 * gap (`resurrecting`), and who did it in the previous bucket but not in this
 * one (`dormant`).
 *
 * One scan from the retention floor (so "first time" means as far back as
 * the plan keeps data) to the end of the range: active buckets per person,
 * then `LAG` / `LEAD` over them give the previous and next active bucket.
 * A person whose next active bucket is not the following one is dormant in
 * the following one.
 */

import type { PanelLifecycleBucket, PanelLifecycleResult, ParsedLifecycleSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelQueryContext } from './context';
import { eventMatch, eventsScope, scopeNeeds, unitExpr } from './scope';
import { ts } from './sql';
import { bucketLabel, bucketLabels, bucketSql, resolveRange, type ResolvedRange } from './time';
import { toNumber, toText, type PanelSqlQuery, type Row } from './rows';
import { toResolvedRange } from './result-range';

const STEP: Record<ParsedLifecycleSpec['interval'], string> = {
  day: "INTERVAL '1 days'",
  week: "INTERVAL '7 days'",
  month: "INTERVAL '1 months'",
};

/** The bucket label before `label` (`YYYY-MM-DD`). */
export function previousBucketLabel(label: string, interval: ParsedLifecycleSpec['interval']): string {
  const [y, m, d] = label.split('-').map(Number) as [number, number, number];
  if (interval === 'month') return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  return new Date(Date.UTC(y, m - 1, d - (interval === 'week' ? 7 : 1))).toISOString().slice(0, 10);
}

export function lifecycleQuery(spec: ParsedLifecycleSpec, ctx: PanelQueryContext, range: ResolvedRange, firstLabel: string): PanelSqlQuery {
  const scope = eventsScope(ctx, range, { from: range.floor, to: range.to }, { filters: spec.filters, ...scopeNeeds(ctx, { events: [spec.event] }) });
  const unit = unitExpr(ctx, scope, spec.aggregateBy);
  const bucket = bucketSql('e.ts', spec.interval, range.offsetMinutes);
  const step = STEP[spec.interval];
  const since = ts(new Date(`${previousBucketLabel(firstLabel, spec.interval)}T00:00:00Z`));
  const act = `SELECT ${unit.expr} AS u, ${bucket} AS b FROM ${scope.from} ${scope.where(eventMatch(spec.event, ctx, range, scope.person), ...unit.conds)} GROUP BY ${unit.expr}, ${bucket}`;
  const seq = `SELECT u, b, LAG(b) OVER (PARTITION BY u ORDER BY b) AS prev_b, LEAD(b) OVER (PARTITION BY u ORDER BY b) AS next_b FROM (${act}) AS act`;
  const status =
    `SELECT b, CASE WHEN prev_b IS NULL THEN 'new' WHEN prev_b = b - ${step} THEN 'returning' ELSE 'resurrecting' END AS status, ` +
    `CASE WHEN next_b IS NULL OR next_b > b + ${step} THEN 1 ELSE 0 END AS dormant_next FROM (${seq}) AS sq`;
  const sql = `SELECT b AS bucket, status, COUNT(*) AS n, SUM(dormant_next) AS dormant_next FROM (${status}) AS st WHERE b >= ${since} GROUP BY b, status`;
  return { name: 'lifecycle.buckets', sql, columns: ['bucket', 'status', 'n', 'dormant_next'] };
}

export async function runLifecycle(
  spec: ParsedLifecycleSpec,
  ctx: PanelQueryContext,
  run: (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>,
): Promise<PanelLifecycleResult> {
  const range = resolveRange(spec.dateRange, spec.timezone, ctx);
  const labels = bucketLabels(range, spec.interval, range.offsetMinutes);
  const first = labels[0] ?? bucketLabel(range.from.toISOString(), spec.interval);
  const [rows = []] = await run([lifecycleQuery(spec, ctx, range, first)]);

  const timeline = [previousBucketLabel(first, spec.interval), ...labels];
  const empty = (): PanelLifecycleBucket => ({ bucket: '', new: 0, returning: 0, resurrecting: 0, dormant: 0 });
  const byLabel = new Map(labels.map((bucket) => [bucket, { ...empty(), bucket }]));
  for (const row of rows) {
    const label = bucketLabel(row.bucket, spec.interval);
    const status = toText(row.status);
    const target = byLabel.get(label);
    if (target && (status === 'new' || status === 'returning' || status === 'resurrecting')) target[status] += toNumber(row.n);
    // Dormant in the bucket after this one.
    const next = timeline[timeline.indexOf(label) + 1];
    const later = timeline.indexOf(label) === -1 ? undefined : byLabel.get(next ?? '');
    if (later) later.dormant += toNumber(row.dormant_next);
  }
  const buckets = labels.map((bucket) => byLabel.get(bucket) as PanelLifecycleBucket);
  const totals = buckets.reduce(
    (sum, b) => ({ new: sum.new + b.new, returning: sum.returning + b.returning, resurrecting: sum.resurrecting + b.resurrecting, dormant: sum.dormant + b.dormant }),
    { new: 0, returning: 0, resurrecting: 0, dormant: 0 },
  );
  return { range: toResolvedRange(range, null), interval: spec.interval, buckets, totals };
}
