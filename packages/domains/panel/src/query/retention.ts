/**
 * `retention`: people (or groups) are put in the cohort of the period they
 * first did the first event, then counted in every later period in which
 * they did the return event (any event when none is given).
 *
 * Modes: by default the first time in the range; `first_time` the first time
 * as far back as the plan keeps data (people who did it before the range are
 * left out); `recurring` every period someone did it starts a cohort of its
 * own. `unbounded` counts someone in period N when they came back in N or any
 * later period. A breakdown splits the cohorts by a property of the first
 * event (top values from a first statement).
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
import { limitedBreakdown, orderedValues, prepareBreakdowns, type PreparedBreakdowns } from './breakdowns';
import { eventMatch, eventsScope, scopeNeeds, unitExpr } from './scope';
import { ts } from './sql';
import { bucketLabel, bucketLabels, bucketSql, queryNow, resolveRange, type ResolvedRange, type TimeBounds } from './time';
import { toNumber, toText, type PanelSqlQuery, type Row } from './rows';
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

/** Where first events are read: the range, or (first time ever) back to the retention floor. */
function firstBounds(spec: ParsedRetentionSpec, range: ResolvedRange): TimeBounds {
  return spec.mode === 'first_time' ? { from: range.floor, to: range.to } : range;
}

function firstScope(spec: ParsedRetentionSpec, ctx: PanelQueryContext, range: ResolvedRange) {
  const needs = scopeNeeds(ctx, { events: [spec.firstEvent], breakdowns: [spec.breakdown] });
  return eventsScope(ctx, range, firstBounds(spec, range), { filters: spec.filters, ...needs });
}

function firstEventCte(spec: ParsedRetentionSpec, ctx: PanelQueryContext, range: ResolvedRange, breakdowns: PreparedBreakdowns | null): string {
  const scope = firstScope(spec, ctx, range);
  const unit = unitExpr(ctx, scope, spec.aggregateBy);
  const firstWhere = scope.where(eventMatch(spec.firstEvent, ctx, range, scope.person), ...unit.conds);
  const bd = breakdowns ? `, FIRST_VALUE(${limitedBreakdown(breakdowns)} ORDER BY e.ts ASC, e.event_id ASC) AS bd` : '';
  if (spec.mode === 'recurring') {
    const bucket = bucketSql('e.ts', spec.interval, range.offsetMinutes);
    return `f AS (SELECT ${unit.expr} AS person, MIN(e.ts) AS t0${bd} FROM ${scope.from} ${firstWhere} GROUP BY ${unit.expr}, ${bucket})`;
  }
  const having = spec.mode === 'first_time' ? ` HAVING MIN(e.ts) >= ${ts(range.from)}` : '';
  return `f AS (SELECT ${unit.expr} AS person, MIN(e.ts) AS t0${bd} FROM ${scope.from} ${firstWhere} GROUP BY ${unit.expr}${having})`;
}

export function retentionQueries(
  spec: ParsedRetentionSpec,
  ctx: PanelQueryContext,
  range: ResolvedRange,
  breakdowns: PreparedBreakdowns | null = null,
): PanelSqlQuery[] {
  const cohortBucket = (column: string) => bucketSql(column, spec.interval, range.offsetMinutes);
  const f = firstEventCte(spec, ctx, range, breakdowns);
  const bdSelect = breakdowns ? ', bd' : '';
  const fBd = breakdowns ? ', f.bd' : '';

  const sizes =
    `WITH ${f} SELECT ${cohortBucket('t0')} AS cohort${bdSelect}, COUNT(*) AS size FROM f ` +
    `GROUP BY ${cohortBucket('t0')}${bdSelect} ORDER BY ${cohortBucket('t0')} ASC`;

  // Returns are read until now, from the first day of the range.
  const needs = scopeNeeds(ctx, { events: spec.returnEvent ? [spec.returnEvent] : [] });
  const returns = eventsScope(ctx, range, { from: range.from, to: queryNow(ctx) }, { filters: spec.filters, ...needs });
  const unit = unitExpr(ctx, returns, spec.aggregateBy);
  const extra = [...(spec.returnEvent ? [eventMatch(spec.returnEvent, ctx, range, returns.person)] : []), ...unit.conds, 'e.ts >= f.t0'];
  const period = periodIndexSql(spec, range.offsetMinutes);
  const from = `FROM ${returns.from} JOIN f ON f.person = ${unit.expr} ${returns.where(...extra)}`;
  const returnsSql = spec.unbounded
    ? `WITH ${f} SELECT cohort${bdSelect}, maxp AS period, COUNT(*) AS n FROM (` +
      `SELECT f.person AS person, ${cohortBucket('f.t0')} AS cohort${fBd}, MAX(${period}) AS maxp ${from} ` +
      `GROUP BY f.person, ${cohortBucket('f.t0')}${fBd}) AS mp GROUP BY cohort${bdSelect}, maxp`
    : `WITH ${f} SELECT ${cohortBucket('f.t0')} AS cohort${fBd}, ${period} AS period, COUNT(DISTINCT f.person) AS n ` +
      `${from} GROUP BY ${cohortBucket('f.t0')}${fBd}, ${period}`;

  const bdColumn = breakdowns ? ['bd'] : [];
  return [
    { name: 'retention.sizes', sql: sizes, columns: ['cohort', ...bdColumn, 'size'] },
    { name: 'retention.returns', sql: returnsSql, columns: ['cohort', ...bdColumn, 'period', 'n'] },
  ];
}

function tableFrom(
  spec: ParsedRetentionSpec,
  range: ResolvedRange,
  sizeRows: Row[],
  returnRows: Row[],
): { cohorts: PanelRetentionCohort[]; averageRetention: number[] } {
  const periods = spec.periods;
  const sizes = new Map<string, number>();
  for (const row of sizeRows) {
    const key = bucketLabel(row.cohort, 'day');
    sizes.set(key, (sizes.get(key) ?? 0) + toNumber(row.size));
  }
  const counts = new Map<string, number[]>();
  for (const row of returnRows) {
    const period = toNumber(row.period);
    if (period < 0) continue;
    const key = bucketLabel(row.cohort, 'day');
    const list = counts.get(key) ?? new Array<number>(periods + 1).fill(0);
    if (spec.unbounded) {
      // Came back last in `period`: counts for every period up to it.
      for (let p = 0; p <= Math.min(period, periods); p += 1) list[p] = (list[p] ?? 0) + toNumber(row.n);
    } else if (period <= periods) {
      list[period] = (list[period] ?? 0) + toNumber(row.n);
    }
    counts.set(key, list);
  }

  const cohorts: PanelRetentionCohort[] = [...sizes.entries()]
    .map(([cohort, size]) => ({ cohort, size }))
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
  return { cohorts, averageRetention };
}

export async function runRetention(
  spec: ParsedRetentionSpec,
  ctx: PanelQueryContext,
  run: (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>,
): Promise<PanelRetentionResult> {
  const range = resolveRange(spec.dateRange, spec.timezone, ctx);
  let breakdowns: PreparedBreakdowns | null = null;
  if (spec.breakdown) {
    const scope = firstScope(spec, ctx, range);
    const unit = unitExpr(ctx, scope, spec.aggregateBy);
    breakdowns = await prepareBreakdowns(
      [spec.breakdown],
      { ctx, scope, where: [eventMatch(spec.firstEvent, ctx, range, scope.person), ...unit.conds], measure: `COUNT(DISTINCT ${unit.expr})`, name: 'retention' },
      run,
    );
  }
  const [sizeRows = [], returnRows = []] = await run(retentionQueries(spec, ctx, range, breakdowns));

  const all = tableFrom(spec, range, sizeRows, returnRows);
  const result: PanelRetentionResult = {
    range: toResolvedRange(range, null),
    interval: spec.interval,
    periods: spec.periods,
    cohorts: all.cohorts,
    averageRetention: all.averageRetention,
  };
  if (spec.mode) result.mode = spec.mode;
  if (spec.unbounded) result.unbounded = true;
  if (breakdowns) {
    const seen = new Set(sizeRows.map((r) => toText(r.bd)));
    result.breakdowns = orderedValues(breakdowns, seen).map((value) => {
      const part = tableFrom(
        spec,
        range,
        sizeRows.filter((r) => toText(r.bd) === value),
        returnRows.filter((r) => toText(r.bd) === value),
      );
      return { value, cohorts: part.cohorts, averageRetention: part.averageRetention };
    });
  }
  return result;
}
