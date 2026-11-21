/**
 * `stickiness` (Mixpanel's Frequency): how often the people (or groups) who
 * did an event do it. One scan, grouped per person first:
 *
 * - `intervals`: the number of distinct days (weeks) of the range each was
 *   active, then how many people per number;
 * - `count`: how many times each did it, in buckets (1, 2, 3, 4–5, 6–10, ...).
 */

import type { PanelStickinessBucket, PanelStickinessResult, ParsedStickinessSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelQueryContext } from './context';
import { eventMatch, eventsScope, scopeNeeds, unitExpr } from './scope';
import { bucketLabels, bucketSql, resolveRange, type ResolvedRange } from './time';
import { toNumber, type PanelSqlQuery, type Row } from './rows';
import { toResolvedRange } from './result-range';

/** `count` buckets: inclusive lower and upper bounds; null upper is open. */
export const STICKINESS_COUNT_BUCKETS: readonly (readonly [number, number | null])[] = [
  [1, 1],
  [2, 2],
  [3, 3],
  [4, 5],
  [6, 10],
  [11, 20],
  [21, 50],
  [51, 100],
  [101, null],
];

export function stickinessQuery(spec: ParsedStickinessSpec, ctx: PanelQueryContext, range: ResolvedRange): PanelSqlQuery {
  const scope = eventsScope(ctx, range, range, { filters: spec.filters, ...scopeNeeds(ctx, { events: [spec.event] }) });
  const unit = unitExpr(ctx, scope, spec.aggregateBy);
  const where = scope.where(eventMatch(spec.event, ctx, range, scope.person), ...unit.conds);
  if (spec.measure === 'intervals') {
    const bucket = bucketSql('e.ts', spec.interval, range.offsetMinutes);
    const sql =
      `SELECT n, COUNT(*) AS units FROM (SELECT ${unit.expr} AS u, COUNT(DISTINCT ${bucket}) AS n FROM ${scope.from} ${where} ` +
      `GROUP BY ${unit.expr}) AS per GROUP BY n ORDER BY n ASC`;
    return { name: 'stickiness.units', sql, columns: ['n', 'units'] };
  }
  const cases = STICKINESS_COUNT_BUCKETS.map(([, to], i) => (to === null ? `ELSE ${i}` : `WHEN n <= ${to} THEN ${i}`));
  const sql =
    `SELECT CASE ${cases.join(' ')} END AS n, COUNT(*) AS units FROM (SELECT ${unit.expr} AS u, COUNT(*) AS n FROM ${scope.from} ${where} ` +
    `GROUP BY ${unit.expr}) AS per GROUP BY CASE ${cases.join(' ')} END`;
  return { name: 'stickiness.units', sql, columns: ['n', 'units'] };
}

export async function runStickiness(
  spec: ParsedStickinessSpec,
  ctx: PanelQueryContext,
  run: (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>,
): Promise<PanelStickinessResult> {
  const range = resolveRange(spec.dateRange, spec.timezone, ctx);
  const [rows = []] = await run([stickinessQuery(spec, ctx, range)]);
  const byN = new Map<number, number>();
  for (const row of rows) byN.set(toNumber(row.n), (byN.get(toNumber(row.n)) ?? 0) + toNumber(row.units));
  const total = [...byN.values()].reduce((sum, n) => sum + n, 0);
  const intervalsInRange = bucketLabels(range, spec.interval, range.offsetMinutes).length;
  const share = (count: number) => (total > 0 ? count / total : 0);

  let buckets: PanelStickinessBucket[];
  if (spec.measure === 'intervals') {
    const most = Math.max(intervalsInRange, ...byN.keys());
    buckets = Array.from({ length: most }, (_, i) => {
      const count = byN.get(i + 1) ?? 0;
      return { label: String(i + 1), from: i + 1, to: i + 1, count, share: share(count) };
    });
  } else {
    buckets = STICKINESS_COUNT_BUCKETS.map(([from, to], i) => {
      const count = byN.get(i) ?? 0;
      let label = `${from}+`;
      if (to !== null) label = from === to ? String(from) : `${from}–${to}`;
      return { label, from, to, count, share: share(count) };
    });
  }
  return { range: toResolvedRange(range, null), interval: spec.interval, measure: spec.measure, total, intervalsInRange, buckets };
}
