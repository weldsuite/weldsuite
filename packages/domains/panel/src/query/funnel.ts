/**
 * `funnel`: ordered steps with a conversion window.
 *
 * One scan reads the events of all steps into `seq` with a 0/1 flag per step
 * (`m1`..`mN`, the step's event or custom event and filters) and per
 * exclusion (`x1`..). Each step is then a CTE that joins the previous step's
 * person-and-timestamp set to `seq`, never the raw table again. A person's
 * clock starts at their first step-1 event, and every later step must happen
 * within the window of it.
 *
 * `loose`: other events may happen between steps; a step is the person's first
 * matching event after the previous step. `strict`: a step must be the very
 * next event of the person (`seq` then holds every event, with `LEAD`).
 * `any`: the steps may happen in any order; the clock starts at the person's
 * first event of any step, and step N counts people who did steps 1..N within
 * the window.
 *
 * Optional steps never gate later ones: in `loose` order the next step joins
 * the last required step; in `strict` order it may follow either. Exclusions
 * remove a person who did the excluded event between the two steps' times (or
 * until the window ends when they never reached the later step). `holdConstant`
 * keeps a property at its step-1 value on every later step. `aggregateBy`
 * counts groups (the `$group_<type>` key) instead of people.
 *
 * Breakdown: the property's value on the person's step-1 event; the top values
 * come from a first statement, the rest are `Other`. `time_to_convert` and
 * `trends` displays add one statement each over the same CTEs.
 */

import {
  specBreakdowns,
  type PanelFunnelResult,
  type PanelFunnelStepResult,
  type PanelFunnelTimeToConvert,
  type PanelFunnelTrendPoint,
  type PanelInterval,
  type PanelTimeToConvertStats,
  type ParsedFunnelCorrelationSpec,
  type ParsedFunnelSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelQueryContext } from './context';
import { limitedBreakdown, orderedValues, partsFor, prepareBreakdowns, type PreparedBreakdowns } from './breakdowns';
import { breakdownExpr, eventsScope, eventWithFilters, scopeNeeds, unitExpr, type EventsScope } from './scope';
import { int, percentileSql } from './sql';
import { bucketLabel, bucketLabels, bucketSql, resolveRange, type ResolvedRange } from './time';
import { toNumber, toText, type PanelSqlQuery, type Row } from './rows';
import { toResolvedRange } from './result-range';

export type AnyFunnelSpec = ParsedFunnelSpec | ParsedFunnelCorrelationSpec;
type StepSpec = ParsedFunnelSpec['steps'][number];
type Run = (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>;

function windowInterval(spec: AnyFunnelSpec): string {
  const { value, unit } = spec.window;
  return `INTERVAL '${int(value, 366)} ${unit}s'`;
}

/** The scope every funnel statement reads (joins for all filters, events and breakdowns). */
export function funnelScope(spec: AnyFunnelSpec, ctx: PanelQueryContext, range: ResolvedRange): EventsScope {
  const needs = scopeNeeds(ctx, {
    filters: [...spec.steps.map((s) => s.filters), ...(spec.exclusions ?? []).map((x) => x.filters)],
    events: [...spec.steps.map((s) => s.event), ...(spec.exclusions ?? []).map((x) => x.event)],
    breakdowns: [...specBreakdowns(spec), spec.holdConstant],
  });
  return eventsScope(ctx, range, range, { filters: spec.filters, ...needs });
}

function stepCondition(step: StepSpec, scope: EventsScope, ctx: PanelQueryContext, range: ResolvedRange): string {
  return `(${eventWithFilters(step.event, step.filters, ctx, range, scope.person)})`;
}

/** First pass: the breakdowns' buckets and top values, counted on step 1. */
export function prepareFunnelBreakdowns(spec: AnyFunnelSpec, ctx: PanelQueryContext, range: ResolvedRange, run: Run): Promise<PreparedBreakdowns | null> {
  const scope = funnelScope(spec, ctx, range);
  const unit = unitExpr(ctx, scope, spec.aggregateBy);
  const first = stepCondition(spec.steps[0] as StepSpec, scope, ctx, range);
  return prepareBreakdowns(
    specBreakdowns(spec),
    { ctx, scope, where: [first, ...unit.conds], measure: `COUNT(DISTINCT ${unit.expr})`, name: 'funnel', cleanPaths: spec.cleanPaths },
    run,
  );
}

/** Columns of the first step that correlation reads. */
export const CORRELATION_COLUMNS = ['country', 'device_type', 'browser', 'os', 'utm_source', 'referrer_host'] as const;

export interface FunnelPlan {
  /** The `WITH` parts. */
  ctes: string[];
  /** Per step (0-based), the CTE of who reached it: `person, t1, t, tp, bd` (after exclusions). */
  reached: string[];
  window: string;
}

interface PlanOptions {
  /** Carry the {@link CORRELATION_COLUMNS} of the first step into `reached[0]` as `c_<column>`. */
  withColumns?: boolean;
}

/** What every CTE builder of a plan shares. */
interface PlanParts {
  spec: AnyFunnelSpec;
  /** The `WITH` parts so far. */
  ctes: string[];
  bd: string | null;
  hc: string | null;
  /** `c_<column>` names carried for correlation. */
  cols: string[];
  window: string;
}

const EMPTY_BD = `'' AS bd`;
const FIRST = 'ORDER BY ts ASC, event_id ASC';

/** `seq`: one scan of the step (and exclusion) events with their flags. */
function seqCte(spec: AnyFunnelSpec, ctx: PanelQueryContext, range: ResolvedRange, parts: Omit<PlanParts, 'ctes' | 'spec' | 'window'>, withColumns: boolean): string {
  const strict = spec.order === 'strict';
  const scope = funnelScope(spec, ctx, range);
  const unit = unitExpr(ctx, scope, spec.aggregateBy);
  const conds = spec.steps.map((step) => stepCondition(step, scope, ctx, range));
  const exclusions = spec.order === 'any' ? [] : (spec.exclusions ?? []);
  const exclConds = exclusions.map((x) => `(${eventWithFilters(x.event, x.filters, ctx, range, scope.person)})`);
  const select = [
    `${unit.expr} AS person`,
    'e.ts AS ts',
    'e.event_id AS event_id',
    ...(parts.bd ? [`${parts.bd} AS bd`] : []),
    ...(parts.hc ? [`${parts.hc} AS hc`] : []),
    ...(withColumns ? CORRELATION_COLUMNS.map((c) => `e.${c} AS c_${c}`) : []),
    ...conds.map((cond, i) => `CASE WHEN ${cond} THEN 1 ELSE 0 END AS m${i + 1}`),
    ...exclConds.map((cond, i) => `CASE WHEN ${cond} THEN 1 ELSE 0 END AS x${i + 1}`),
    ...(strict ? [`LEAD(e.event_id) OVER (PARTITION BY ${unit.expr} ORDER BY e.ts, e.event_id) AS next_id`] : []),
  ];
  // Loose and any order only need the step (and exclusion) events; strict needs every event to know what came next.
  const anyStep = `(${[...conds, ...exclConds].join(' OR ')})`;
  const where = strict ? scope.where(...unit.conds) : scope.where(...unit.conds, anyStep);
  return `seq AS (SELECT ${select.join(', ')} FROM ${scope.from} ${where})`;
}

/** `any` order: the anchor (first event of any step), what each person did in the window, one CTE per step. */
function anyOrderSteps(parts: PlanParts): string[] {
  const { spec, ctes, bd, hc, cols, window } = parts;
  const firsts = [
    bd ? `FIRST_VALUE(bd ${FIRST}) AS bd` : EMPTY_BD,
    ...(hc ? [`FIRST_VALUE(hc ${FIRST}) AS hc`] : []),
    ...cols.map((c) => `FIRST_VALUE(${c} ${FIRST}) AS ${c}`),
  ];
  ctes.push(`a AS (SELECT person, MIN(ts) AS t0, ${firsts.join(', ')} FROM seq GROUP BY person)`);
  const done = spec.steps.map((_, i) => `MAX(q.m${i + 1}) AS d${i + 1}, MIN(CASE WHEN q.m${i + 1} = 1 THEN q.ts END) AS f${i + 1}`);
  const carried = [...cols.map((c) => `MIN(a.${c}) AS ${c}`), ...done].join(', ');
  const sameValue = hc ? ' AND q.hc = a.hc' : '';
  ctes.push(
    `p AS (SELECT q.person AS person, MIN(a.t0) AS t0, MIN(a.bd) AS bd, ${carried} ` +
      `FROM seq q JOIN a ON a.person = q.person WHERE q.ts <= a.t0 + ${window}${sameValue} GROUP BY q.person)`,
  );
  return spec.steps.map((_, i) => {
    const all = Array.from({ length: i + 1 }, (__, j) => `d${j + 1} = 1`).join(' AND ');
    const extra = i === 0 ? cols.map((c) => `, ${c}`).join('') : '';
    ctes.push(`r${i + 1} AS (SELECT person, t0 AS t1, f${i + 1} AS t, t0 AS tp, bd${extra} FROM p WHERE ${all})`);
    return `r${i + 1}`;
  });
}

/**
 * s1: one row per person (loose) or per step-1 event (strict). One breakdown value per person: the one on
 * their first step-1 event, so a person who hits two values is counted in one group.
 */
function firstStepCte(parts: PlanParts, strict: boolean): string {
  const { bd, hc, cols } = parts;
  if (strict) {
    const firstBd = bd ? `FIRST_VALUE(bd) OVER (PARTITION BY person ${FIRST}) AS bd` : EMPTY_BD;
    const tail = [...(hc ? ['hc'] : []), ...cols].map((x) => `, ${x}`).join('');
    return `s1 AS (SELECT person, ts AS t1, ts AS t, ts AS tp, next_id, ${firstBd}${tail} FROM seq WHERE m1 = 1)`;
  }
  const firstBd = bd ? `FIRST_VALUE(bd ${FIRST}) AS bd` : EMPTY_BD;
  const extras = [...(hc ? [`FIRST_VALUE(hc ${FIRST}) AS hc`] : []), ...cols.map((c) => `FIRST_VALUE(${c} ${FIRST}) AS ${c}`)];
  const tail = extras.map((x) => `, ${x}`).join('');
  return `s1 AS (SELECT person, MIN(ts) AS t1, MIN(ts) AS t, MIN(ts) AS tp, ${firstBd}${tail} FROM seq WHERE m1 = 1 GROUP BY person)`;
}

function isOptional(spec: AnyFunnelSpec, step1Based: number): boolean {
  return (spec.steps[step1Based - 1] as StepSpec).optional === true;
}

/** Strict: the CTEs step k may follow (the previous step, and the one before it when that one is optional). */
function strictSources(spec: AnyFunnelSpec, k: number): string[] {
  const own = [`s${k - 1}`];
  return k - 1 >= 2 && isOptional(spec, k - 1) ? [...own, ...strictSources(spec, k - 1)] : own;
}

/** Loose: the last required step before step k (1-based). */
function lastRequired(spec: AnyFunnelSpec, k: number): number {
  for (let j = k - 1; j > 1; j -= 1) if (!isOptional(spec, j)) return j;
  return 1;
}

function strictStepCte(parts: PlanParts, k: number): void {
  const { spec, ctes, hc, window } = parts;
  const sources = strictSources(spec, k);
  let prev = sources[0] as string;
  if (sources.length > 1) {
    prev = `u${k}`;
    const columns = hc ? 'person, t1, t, next_id, bd, hc' : 'person, t1, t, next_id, bd';
    const selects = sources.map((s) => 'SELECT ' + columns + ' FROM ' + s);
    ctes.push(`u${k} AS (${selects.join(' UNION ALL ')})`);
  }
  const carry = hc ? ', p.hc AS hc' : '';
  const sameValue = hc ? ' AND q.hc = p.hc' : '';
  ctes.push(
    `s${k} AS (SELECT p.person AS person, p.t1 AS t1, p.t AS tp, q.ts AS t, q.next_id AS next_id, p.bd AS bd${carry} FROM ${prev} p ` +
      `JOIN seq q ON q.event_id = p.next_id AND q.person = p.person WHERE q.m${k} = 1 AND q.ts <= p.t1 + ${window}${sameValue})`,
  );
}

function looseStepCte(parts: PlanParts, k: number): void {
  const { spec, ctes, hc, window } = parts;
  const j = lastRequired(spec, k);
  const sameEvent = (spec.steps[k - 1] as StepSpec).event === (spec.steps[j - 1] as StepSpec).event;
  const carry = hc ? ', MIN(p.hc) AS hc' : '';
  const sameValue = hc ? ' AND q.hc = p.hc' : '';
  const after = sameEvent ? '>' : '>=';
  ctes.push(
    `s${k} AS (SELECT p.person AS person, p.t1 AS t1, p.t AS tp, MIN(q.ts) AS t, MIN(p.bd) AS bd${carry} FROM s${j} p ` +
      `JOIN seq q ON q.person = p.person WHERE q.m${k} = 1 AND q.ts ${after} p.t AND q.ts <= p.t1 + ${window}` +
      `${sameValue} GROUP BY p.person, p.t1, p.t)`,
  );
}

/** Exclusions: people who did the excluded event after `fromStep` and before `toStep` (or the window's end) leave every step. */
function excludedSteps(parts: PlanParts, steps: string[]): string[] {
  const { spec, ctes, cols, window } = parts;
  const exclusions = spec.exclusions ?? [];
  if (exclusions.length === 0) return steps;
  exclusions.forEach((x, i) => {
    ctes.push(
      `x${i + 1} AS (SELECT DISTINCT f.person AS person FROM s${x.fromStep + 1} f ` +
        `LEFT JOIN s${x.toStep + 1} g ON g.person = f.person AND g.t1 = f.t1 JOIN seq q ON q.person = f.person ` +
        `WHERE q.x${i + 1} = 1 AND q.ts > f.t AND q.ts < COALESCE(g.t, f.t1 + ${window}))`,
    );
  });
  const excluded = exclusions.map((_, i) => 'SELECT person FROM x' + (i + 1));
  ctes.push(`xall AS (${excluded.join(' UNION ')})`);
  return steps.map((s, i) => {
    const extra = i === 0 ? cols.map((c) => `, s.${c} AS ${c}`).join('') : '';
    ctes.push(
      `r${i + 1} AS (SELECT s.person AS person, s.t1 AS t1, s.t AS t, s.tp AS tp, s.bd AS bd${extra} FROM ${s} s ` +
        `LEFT JOIN xall xa ON xa.person = s.person WHERE xa.person IS NULL)`,
    );
    return `r${i + 1}`;
  });
}

/** The step CTEs. Exported for the correlation statements and the tests. */
export function funnelPlan(
  spec: AnyFunnelSpec,
  ctx: PanelQueryContext,
  range: ResolvedRange,
  breakdowns: PreparedBreakdowns | null,
  options: PlanOptions = {},
): FunnelPlan {
  const bd = breakdowns ? limitedBreakdown(breakdowns) : null;
  const hc = spec.holdConstant ? breakdownExpr(spec.holdConstant, ctx, { cleanPaths: spec.cleanPaths }) : null;
  const cols = options.withColumns ? CORRELATION_COLUMNS.map((c) => `c_${c}`) : [];
  const window = windowInterval(spec);
  const parts: PlanParts = { spec, ctes: [], bd, hc, cols, window };
  parts.ctes.push(seqCte(spec, ctx, range, { bd, hc, cols }, options.withColumns === true));

  if (spec.order === 'any') return { ctes: parts.ctes, reached: anyOrderSteps(parts), window };

  const strict = spec.order === 'strict';
  parts.ctes.push(firstStepCte(parts, strict));
  for (let k = 2; k <= spec.steps.length; k += 1) {
    if (strict) strictStepCte(parts, k);
    else looseStepCte(parts, k);
  }
  const steps = spec.steps.map((_, i) => `s${i + 1}`);
  return { ctes: parts.ctes, reached: excludedSteps(parts, steps), window };
}

/** The funnel statement. Exported for the snapshot tests. */
export function funnelQuery(spec: ParsedFunnelSpec, ctx: PanelQueryContext, range: ResolvedRange, breakdowns: PreparedBreakdowns | null): PanelSqlQuery {
  const plan = funnelPlan(spec, ctx, range, breakdowns);
  const finals = plan.reached.map(
    (source, i) =>
      `SELECT ${i + 1} AS step, bd AS bd, COUNT(DISTINCT person) AS persons, AVG(to_unixtime(t) - to_unixtime(tp)) AS avg_secs ` +
      `FROM ${source} GROUP BY bd`,
  );
  return { name: 'funnel.steps', sql: `WITH ${plan.ctes.join(', ')} ${finals.join(' UNION ALL ')}`, columns: ['step', 'bd', 'persons', 'avg_secs'] };
}

/** Edges (seconds) of the time-to-convert histogram: under 10 s, 30 s, 1 min, 5 min, 30 min, 1 h, 6 h, 1 day, 3 days, 7 days, and longer. */
export const TIME_TO_CONVERT_EDGES = [10, 30, 60, 300, 1800, 3600, 21_600, 86_400, 259_200, 604_800] as const;

/** Per step (2..N, from the previous step) and overall (step 0, first to last): count, median, p90, average and histogram. */
export function timeToConvertQuery(spec: ParsedFunnelSpec, ctx: PanelQueryContext, range: ResolvedRange, breakdowns: PreparedBreakdowns | null): PanelSqlQuery {
  const plan = funnelPlan(spec, ctx, range, breakdowns);
  const last = plan.reached[plan.reached.length - 1] as string;
  const parts = plan.reached
    .slice(1)
    .map((source, i) => `SELECT ${i + 2} AS step, to_unixtime(t) - to_unixtime(tp) AS secs FROM ${source}`);
  parts.push(`SELECT 0 AS step, to_unixtime(t) - to_unixtime(t1) AS secs FROM ${last}`);
  const edges = TIME_TO_CONVERT_EDGES;
  const histogram = [...edges, null].map((edge, i) => {
    const lower = i === 0 ? null : edges[i - 1];
    const conds = [...(lower === undefined || lower === null ? [] : [`secs >= ${lower}`]), ...(edge === null ? [] : [`secs < ${edge}`])];
    return `SUM(CASE WHEN ${conds.length > 0 ? conds.join(' AND ') : 'secs IS NOT NULL'} THEN 1 ELSE 0 END) AS h${i}`;
  });
  const sql =
    `WITH ${plan.ctes.join(', ')}, d AS (${parts.join(' UNION ALL ')}) ` +
    `SELECT step, COUNT(*) AS n, ${percentileSql('secs', 0.5)} AS p50, ${percentileSql('secs', 0.9)} AS p90, AVG(secs) AS avg_secs, ` +
    `${histogram.join(', ')} FROM d GROUP BY step`;
  return {
    name: 'funnel.timeToConvert',
    sql,
    columns: ['step', 'n', 'p50', 'p90', 'avg_secs', ...histogram.map((_, i) => `h${i}`)],
  };
}

/** Entered and converted per bucket of the time people entered. */
export function funnelTrendQuery(
  spec: ParsedFunnelSpec,
  ctx: PanelQueryContext,
  range: ResolvedRange,
  breakdowns: PreparedBreakdowns | null,
  interval: PanelInterval,
): PanelSqlQuery {
  const plan = funnelPlan(spec, ctx, range, breakdowns);
  const first = plan.reached[0] as string;
  const last = plan.reached[plan.reached.length - 1] as string;
  const bucket = bucketSql('t1', interval, range.offsetMinutes);
  const sql =
    `WITH ${plan.ctes.join(', ')} SELECT bucket, COUNT(DISTINCT CASE WHEN k = 1 THEN person END) AS entered, ` +
    `COUNT(DISTINCT CASE WHEN k = 2 THEN person END) AS converted FROM (` +
    `SELECT 1 AS k, person, ${bucket} AS bucket FROM ${first} UNION ALL SELECT 2 AS k, person, ${bucket} AS bucket FROM ${last}` +
    `) AS z GROUP BY bucket ORDER BY bucket ASC`;
  return { name: 'funnel.trend', sql, columns: ['bucket', 'entered', 'converted'] };
}

function stepsFrom(spec: ParsedFunnelSpec, rows: Row[]): { steps: PanelFunnelStepResult[]; overall: number } {
  const counts = spec.steps.map((_, i) => rows.filter((r) => toNumber(r.step) === i + 1));
  const first = counts[0]?.reduce((sum, r) => sum + toNumber(r.persons), 0) ?? 0;
  let previousCount = first;
  const steps = spec.steps.map((step, i): PanelFunnelStepResult => {
    const stepRows = counts[i] ?? [];
    const count = stepRows.reduce((sum, r) => sum + toNumber(r.persons), 0);
    // Weighted by people: the average over the breakdown groups.
    const secs = count > 0 ? stepRows.reduce((sum, r) => sum + toNumber(r.avg_secs) * toNumber(r.persons), 0) / count : null;
    let fromPrevious = 1;
    if (i > 0) fromPrevious = previousCount > 0 ? count / previousCount : 0;
    const result: PanelFunnelStepResult = {
      index: i,
      event: step.event,
      label: step.label?.trim() || step.event,
      count,
      conversionFromPrevious: fromPrevious,
      conversionFromFirst: first > 0 ? count / first : 0,
      droppedOff: i === 0 ? 0 : Math.max(previousCount - count, 0),
      avgSecondsFromPrevious: i === 0 || count === 0 || secs === null ? null : Math.round(secs),
    };
    const optional = step.optional === true && spec.order !== 'any' && i > 0 && i < spec.steps.length - 1;
    if (optional) result.optional = true;
    // An optional step does not become the "previous" of the next one.
    else previousCount = count;
    return result;
  });
  const last = steps[steps.length - 1];
  return { steps, overall: last && first > 0 ? last.count / first : 0 };
}

function statsFrom(row: Row | undefined): PanelTimeToConvertStats {
  const edges = TIME_TO_CONVERT_EDGES;
  const nullable = (value: unknown) => (value === null || value === undefined ? null : Math.round(toNumber(value)));
  return {
    count: toNumber(row?.n),
    medianSeconds: nullable(row?.p50),
    p90Seconds: nullable(row?.p90),
    avgSeconds: nullable(row?.avg_secs),
    histogram: [...edges, null].map((edge, i) => ({
      fromSeconds: i === 0 ? 0 : (edges[i - 1] as number),
      toSeconds: edge,
      count: toNumber(row?.[`h${i}`]),
    })),
  };
}

/** Time-to-convert rows (step 0 = overall) into the result shape. */
export function timeToConvertFrom(spec: ParsedFunnelSpec, rows: Row[]): PanelFunnelTimeToConvert {
  const byStep = new Map(rows.map((r) => [toNumber(r.step), r]));
  return {
    overall: statsFrom(byStep.get(0)),
    steps: spec.steps.slice(1).map((_, i) => ({ index: i + 1, ...statsFrom(byStep.get(i + 2)) })),
  };
}

function trendFrom(rows: Row[], range: ResolvedRange, interval: PanelInterval): PanelFunnelTrendPoint[] {
  const byBucket = new Map(rows.map((r) => [bucketLabel(r.bucket, interval), r]));
  return bucketLabels(range, interval, range.offsetMinutes).map((bucket) => {
    const row = byBucket.get(bucket);
    const entered = toNumber(row?.entered);
    const converted = toNumber(row?.converted);
    return { bucket, entered, converted, conversion: entered > 0 ? converted / entered : 0 };
  });
}

/** Hours make sense for short ranges only. */
function funnelTrendInterval(range: ResolvedRange, requested: PanelInterval | undefined): PanelInterval {
  const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;
  const interval = requested ?? 'day';
  return interval === 'hour' && days > 14 ? 'day' : interval;
}

export async function runFunnel(spec: ParsedFunnelSpec, ctx: PanelQueryContext, run: Run): Promise<PanelFunnelResult> {
  const range = resolveRange(spec.dateRange, spec.timezone, ctx);
  const breakdowns = await prepareFunnelBreakdowns(spec, ctx, range, run);

  const queries: PanelSqlQuery[] = [funnelQuery(spec, ctx, range, breakdowns)];
  const interval = funnelTrendInterval(range, spec.interval);
  if (spec.display === 'time_to_convert') queries.push(timeToConvertQuery(spec, ctx, range, breakdowns));
  if (spec.display === 'trends') queries.push(funnelTrendQuery(spec, ctx, range, breakdowns, interval));
  const results = await run(queries);
  const at = (name: string): Row[] => results[queries.findIndex((q) => q.name === name)] ?? [];
  const rows = at('funnel.steps');

  const overall = stepsFrom(spec, rows);
  let breakdownResults: PanelFunnelResult['breakdowns'] = null;
  if (breakdowns) {
    const order = orderedValues(breakdowns, new Set(rows.map((r) => toText(r.bd))));
    breakdownResults = order.map((value) => {
      const part = stepsFrom(spec, rows.filter((r) => toText(r.bd) === value));
      return { value, parts: partsFor(breakdowns, value), steps: part.steps, overallConversion: part.overall };
    });
  }
  const result: PanelFunnelResult = { range: toResolvedRange(range, null), steps: overall.steps, overallConversion: overall.overall, breakdowns: breakdownResults };
  if (spec.display === 'time_to_convert') result.timeToConvert = timeToConvertFrom(spec, at('funnel.timeToConvert'));
  if (spec.display === 'trends') {
    result.trend = trendFrom(at('funnel.trend'), range, interval);
    result.interval = interval;
  }
  return result;
}
