/**
 * `retention`: people are put in the cohort of the period they first did the
 * first event (within the range), then counted in every later period in which
 * they did the return event (any event when none is given).
 *
 * Two statements: cohort sizes (one scan) and returns per cohort and period
 * (the first-event CTE joined to the events again).
 */

import type {
  PanelRetentionCohort,
  PanelRetentionResult,
  ParsedRetentionSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelQueryContext } from './context';
import { eventsScope } from './scope';
import { eventName } from './sql';
import { bucketLabel, bucketLabels, bucketSql, queryNow, resolveRange, type ResolvedRange } from './time';
import { toNumber, type PanelSqlQuery, type Row } from './rows';
import { toResolvedRange } from './result-range';

const UNIT_SECONDS = { day: 86_400, week: 604_800 } as const;

function shifted(column: string, offsetMinutes: number): string {
  return offsetMinutes === 0 ? column : `${column} + INTERVAL '${Math.trunc(offsetMinutes)} minutes'`;
}

/** The number of whole `interval`s between the cohort's first event and an event, in the range's timezone. */
function periodIndexSql(spec: ParsedRetentionSpec, offsetMinutes: number): string {
  const event = shifted('e.ts', offsetMinutes);
  const first = shifted('f.t0', offsetMinutes);
  if (spec.interval === 'month') {
    return `((EXTRACT(YEAR FROM ${event}) * 12 + EXTRACT(MONTH FROM ${event})) - (EXTRACT(YEAR FROM ${first}) * 12 + EXTRACT(MONTH FROM ${first})))`;
  }
  const unit = spec.interval;
  return `FLOOR((to_unixtime(date_trunc('${unit}', ${event})) - to_unixtime(date_trunc('${unit}', ${first}))) / ${UNIT_SECONDS[unit]})`;
}

function firstEventCte(spec: ParsedRetentionSpec, ctx: PanelQueryContext, range: ResolvedRange): string {
  const scope = eventsScope(ctx, range, range, { filters: spec.filters });
  return (
    `f AS (SELECT ${scope.person} AS person, MIN(e.ts) AS t0 FROM ${scope.from} ${scope.where(`e.name = ${eventName(spec.firstEvent)}`)} ` +
    `GROUP BY ${scope.person})`
  );
}

export function retentionQueries(spec: ParsedRetentionSpec, ctx: PanelQueryContext, range: ResolvedRange): PanelSqlQuery[] {
  const cohortBucket = (column: string) => bucketSql(column, spec.interval, range.offsetMinutes);
  const f = firstEventCte(spec, ctx, range);

  const sizes =
    `WITH ${f} SELECT ${cohortBucket('t0')} AS cohort, COUNT(*) AS size FROM f GROUP BY ${cohortBucket('t0')} ORDER BY ${cohortBucket('t0')} ASC`;

  // Returns are read until now, from the first day of the range.
  const returns = eventsScope(ctx, range, { from: range.from, to: queryNow(ctx) }, { filters: spec.filters });
  const extra = [...(spec.returnEvent ? [`e.name = ${eventName(spec.returnEvent)}`] : []), 'e.ts >= f.t0'];
  const period = periodIndexSql(spec, range.offsetMinutes);
  const returnsSql =
    `WITH ${f} SELECT ${cohortBucket('f.t0')} AS cohort, ${period} AS period, COUNT(DISTINCT f.person) AS n ` +
    `FROM ${returns.from} JOIN f ON f.person = ${returns.person} ${returns.where(...extra)} ` +
    `GROUP BY ${cohortBucket('f.t0')}, ${period}`;

  return [
    { name: 'retention.sizes', sql: sizes, columns: ['cohort', 'size'] },
    { name: 'retention.returns', sql: returnsSql, columns: ['cohort', 'period', 'n'] },
  ];
}

export async function runRetention(
  spec: ParsedRetentionSpec,
  ctx: PanelQueryContext,
  run: (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>,
): Promise<PanelRetentionResult> {
  const range = resolveRange(spec.dateRange, spec.timezone, ctx);
  const [sizeRows = [], returnRows = []] = await run(retentionQueries(spec, ctx, range));

  const periods = spec.periods;
  const counts = new Map<string, number[]>();
  for (const row of returnRows) {
    const period = toNumber(row.period);
    if (period < 0 || period > periods) continue;
    const key = bucketLabel(row.cohort, 'day');
    const list = counts.get(key) ?? new Array<number>(periods + 1).fill(0);
    list[period] = toNumber(row.n);
    counts.set(key, list);
  }

  const cohorts: PanelRetentionCohort[] = sizeRows
    .map((row) => ({ cohort: bucketLabel(row.cohort, 'day'), size: toNumber(row.size) }))
    .filter((c) => c.size > 0)
    .sort((a, b) => a.cohort.localeCompare(b.cohort))
    .map((c) => ({ ...c, counts: counts.get(c.cohort) ?? new Array<number>(periods + 1).fill(0) }));

  // A cohort can only show a period that has already started: the average counts the cohorts old enough for it.
  const timeline = bucketLabels(range, spec.interval, range.offsetMinutes);
  const averageRetention = Array.from({ length: periods + 1 }, (_, p) => {
    let retained = 0;
    let total = 0;
    for (const cohort of cohorts) {
      const index = timeline.indexOf(cohort.cohort);
      if (index === -1 || index + p > timeline.length - 1) continue;
      retained += cohort.counts[p] ?? 0;
      total += cohort.size;
    }
    return total > 0 ? retained / total : 0;
  });

  return { range: toResolvedRange(range, null), interval: spec.interval, periods, cohorts, averageRetention };
}
