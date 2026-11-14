/**
 * The scoped read of `events_v1`: the one place that writes the workspace and
 * project filters, the time bound, the erased-id exclusion, the identity join
 * and the person-property join. Every compiled query, every CTE and every
 * subquery that touches a panel table is built here, so isolation rests on one
 * function and one test (`compile.test.ts`).
 *
 * Aliases: `e` events, `i` latest identity per anonymous id, `pp` latest
 * profile per user. A subquery builds its own scope; inner aliases shadow the
 * outer ones.
 */

import {
  PANEL_FILTER_COLUMNS,
  type ParsedPanelCohortFilter,
  type PanelBreakdown,
  type PanelFilter,
  type PanelFilterOperator,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { BASIN_NAMESPACE, type PanelQueryContext } from './context';
import { PANEL_TABLES } from '../tables';
import { PanelQueryError, eventName, inList, int, likeContains, lit, LIKE_ESCAPE, num, propertyKey, ts } from './sql';
import { queryNow, type ResolvedRange, type TimeBounds } from './time';

const MAX_ERASED_IN_SQL = 5000;

export const eventsTable = `${BASIN_NAMESPACE}.${PANEL_TABLES.events}`;
export const identitiesTable = `${BASIN_NAMESPACE}.${PANEL_TABLES.identities}`;
export const peopleTable = `${BASIN_NAMESPACE}.${PANEL_TABLES.people}`;
export const replayChunksTable = `${BASIN_NAMESPACE}.${PANEL_TABLES.replayChunks}`;

/** `workspace_id = … AND project_id = …`, from the authenticated context only. */
export function scopeConds(ctx: PanelQueryContext, prefix = ''): string[] {
  return [`${prefix}workspace_id = ${lit(ctx.workspaceId)}`, `${prefix}project_id = ${lit(ctx.projectId)}`];
}

function erasedList(ctx: PanelQueryContext): string[] {
  const ids = [...new Set(ctx.erasedIds)];
  if (ids.length > MAX_ERASED_IN_SQL) {
    throw new PanelQueryError('Too many erasures are waiting to be applied; try again shortly');
  }
  return ids;
}

/** Everything a query reads about people lives between the retention floor and now. */
export function historyBounds(ctx: PanelQueryContext, range: ResolvedRange, column: string): string[] {
  return [`${column} >= ${ts(range.floor)}`, `${column} <= ${ts(queryNow(ctx))}`];
}

/** Latest identity link per anonymous id (the first link wins), as a derived table. */
export function identitiesLatest(ctx: PanelQueryContext, range: ResolvedRange): string {
  const conds = [...scopeConds(ctx), ...historyBounds(ctx, range, 'ts')];
  const erased = erasedList(ctx);
  if (erased.length > 0) conds.push(`user_id NOT IN ${inList(erased)}`, `anon_id NOT IN ${inList(erased)}`);
  return (
    `(SELECT anon_id, user_id FROM (SELECT anon_id, user_id, ROW_NUMBER() OVER (PARTITION BY anon_id ORDER BY ts ASC) AS rn ` +
    `FROM ${identitiesTable} WHERE ${conds.join(' AND ')}) AS il WHERE rn = 1)`
  );
}

/** Current profile per user (highest version), not deleted. */
export function peopleLatest(ctx: PanelQueryContext, range: ResolvedRange): string {
  const conds = [...scopeConds(ctx), ...historyBounds(ctx, range, 'ts')];
  const erased = erasedList(ctx);
  if (erased.length > 0) conds.push(`user_id NOT IN ${inList(erased)}`);
  return (
    `(SELECT user_id, properties FROM (SELECT user_id, properties, deleted, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY version DESC) AS rn ` +
    `FROM ${peopleTable} WHERE ${conds.join(' AND ')}) AS pl WHERE rn = 1 AND deleted = false)`
  );
}

export interface EventsScope {
  /** `panel.events_v1 e` plus its joins. */
  from: string;
  /** The person: the identity's user id, else the event's distinct id. */
  person: string;
  /** Every condition applied so far. */
  conds: string[];
  /** `WHERE` with the base conditions and `extra`. */
  where(...extra: string[]): string;
}

export interface ScopeOptions {
  filters?: readonly PanelFilter[];
  /** Join the person's profile (breakdown by a person property). */
  personProps?: boolean;
  /** Further conditions on `e` (already built from validated values). */
  extraConds?: readonly string[];
}

export function personExpr(ctx: PanelQueryContext): string {
  return ctx.hasIdentifiedUsers ? 'COALESCE(i.user_id, e.distinct_id)' : 'e.distinct_id';
}

function needsPersonProps(filters: readonly PanelFilter[] | undefined): boolean {
  return (filters ?? []).some((f) => f.source === 'person');
}

/** The scoped events read for `bounds`. */
export function eventsScope(ctx: PanelQueryContext, range: ResolvedRange, bounds: TimeBounds, options: ScopeOptions = {}): EventsScope {
  const person = personExpr(ctx);
  const joinProfiles = options.personProps === true || needsPersonProps(options.filters);

  let from = `${eventsTable} e`;
  if (ctx.hasIdentifiedUsers) from += ` LEFT JOIN ${identitiesLatest(ctx, range)} i ON i.anon_id = e.anon_id`;
  if (joinProfiles) from += ` LEFT JOIN ${peopleLatest(ctx, range)} pp ON pp.user_id = ${person}`;

  const conds = [...scopeConds(ctx, 'e.'), `e.ts >= ${ts(bounds.from)}`, `e.ts < ${ts(bounds.to)}`];
  const erased = erasedList(ctx);
  if (erased.length > 0) {
    const list = inList(erased);
    conds.push(`e.anon_id NOT IN ${list}`, `e.distinct_id NOT IN ${list}`, `COALESCE(e.user_id, '') NOT IN ${list}`);
  }
  if (options.filters && options.filters.length > 0) conds.push(...compileFilters(options.filters, ctx, range, person));
  if (options.extraConds) conds.push(...options.extraConds);

  return {
    from,
    person,
    conds,
    where: (...extra) => `WHERE ${[...conds, ...extra].join(' AND ')}`,
  };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export function columnExpr(field: string): string {
  if (!(PANEL_FILTER_COLUMNS as readonly string[]).includes(field)) throw new PanelQueryError(`Unknown column: ${field.slice(0, 40)}`);
  return `e.${field}`;
}

interface ValueExprs {
  /** Text value of the thing being compared. */
  str: string;
  /** Numeric value (JSON properties only; a column is compared as text). */
  num: string | null;
  bool: string | null;
  /** SQL that is true when the thing exists. */
  isSet: string;
}

function jsonExprs(column: string, key: string): ValueExprs {
  const k = propertyKey(key);
  return {
    str: `json_get_str(${column}, ${k})`,
    num: `json_get_float(${column}, ${k})`,
    bool: `json_get_bool(${column}, ${k})`,
    isSet: `json_contains(${column}, ${k})`,
  };
}

type FilterValue = string | number | boolean | (string | number)[];

function inComparison(value: FilterValue, ex: ValueExprs): string {
  if (!Array.isArray(value) || value.length === 0) throw new PanelQueryError('Use a list of values');
  if (value.every((v) => typeof v === 'number') && ex.num) return `${ex.num} IN (${value.map((v) => num(v as number)).join(', ')})`;
  return `${ex.str} IN ${inList(value.map(String))}`;
}

function containsComparison(operator: PanelFilterOperator, value: string | number | boolean, ex: ValueExprs): string {
  const matches = `LOWER(${ex.str}) LIKE ${likeContains(String(value))}${LIKE_ESCAPE}`;
  return operator === 'contains' ? matches : `(${ex.str} IS NULL OR NOT (${matches}))`;
}

function orderComparison(operator: PanelFilterOperator, value: string | number | boolean, ex: ValueExprs): string {
  const sign = operator === 'gt' ? '>' : '<';
  if (typeof value === 'number' && ex.num) return `${ex.num} ${sign} ${num(value)}`;
  if (typeof value === 'boolean') throw new PanelQueryError('Use a number or text');
  return `${ex.str} ${sign} ${lit(String(value))}`;
}

function comparison(operator: PanelFilterOperator, value: FilterValue | undefined, ex: ValueExprs): string {
  if (operator === 'is_set') return ex.isSet;
  if (operator === 'is_not_set') return `NOT ${ex.isSet}`;
  if (value === undefined) throw new PanelQueryError('A filter needs a value');

  if (operator === 'in') return inComparison(value, ex);
  if (Array.isArray(value)) throw new PanelQueryError('Only `in` takes a list');

  if (operator === 'contains' || operator === 'not_contains') return containsComparison(operator, value, ex);
  if (operator === 'gt' || operator === 'lt') return orderComparison(operator, value, ex);

  // eq / neq
  let equal: string;
  if (typeof value === 'number' && ex.num) equal = `${ex.num} = ${num(value)}`;
  else if (typeof value === 'boolean' && ex.bool) equal = `${ex.bool} = ${value ? 'true' : 'false'}`;
  else equal = `${ex.str} = ${lit(String(value))}`;
  return operator === 'eq' ? equal : `(${ex.str} IS NULL OR NOT (${equal}))`;
}

/** One non-cohort filter as a SQL condition. */
function filterCondition(filter: Exclude<PanelFilter, { source: 'cohort' }>): string {
  if (filter.source === 'column') {
    const col = columnExpr(filter.field);
    if (filter.operator === 'is_not_set') return `${col} IS NULL`;
    const ex: ValueExprs = { str: col, num: null, bool: null, isSet: `${col} IS NOT NULL` };
    return comparison(filter.operator, filter.value as FilterValue | undefined, ex);
  }
  const column = filter.source === 'event' ? 'e.properties' : 'pp.properties';
  return comparison(filter.operator, filter.value as FilterValue | undefined, jsonExprs(column, filter.key));
}

/** The conditions for a list of filters, ANDed by the caller. Cohort filters become person subqueries. */
export function compileFilters(filters: readonly PanelFilter[], ctx: PanelQueryContext, range: ResolvedRange, person: string): string[] {
  return filters.map((filter) => {
    if (filter.source !== 'cohort') return `(${filterCondition(filter)})`;
    const cohort = ctx.cohorts?.[filter.cohortId];
    if (!cohort) throw new PanelQueryError('That cohort does not exist');
    const member = cohortMembership(cohort, ctx, range, person);
    return filter.negate ? `NOT (${member})` : `(${member})`;
  });
}

/** SQL boolean, true for people in the cohort, over the outer query's `person` expression. */
export function cohortMembership(cohort: ParsedPanelCohortFilter, ctx: PanelQueryContext, range: ResolvedRange, person: string): string {
  const joiner = cohort.match === 'any' ? ' OR ' : ' AND ';
  const parts = cohort.conditions.map((condition) => {
    if (condition.type === 'person_property') {
      const cond = comparison(condition.operator, condition.value as FilterValue | undefined, jsonExprs('pl2.properties', condition.key));
      return `${person} IN (SELECT pl2.user_id FROM ${peopleLatest(ctx, range)} AS pl2 WHERE ${cond})`;
    }
    for (const f of condition.filters as readonly PanelFilter[]) {
      if (f.source === 'cohort') throw new PanelQueryError('Cohorts cannot contain cohorts');
    }
    const now = queryNow(ctx);
    const bounds: TimeBounds = {
      from: new Date(Math.max(now.getTime() - condition.withinDays * 86_400_000, range.floor.getTime())),
      to: now,
    };
    const inner = eventsScope(ctx, range, bounds, { filters: condition.filters });
    const innerWhere = inner.where(`e.name = ${eventName(condition.event)}`);
    const subquery =
      `SELECT ${inner.person} FROM ${inner.from} ${innerWhere} ` +
      `GROUP BY ${inner.person} HAVING COUNT(*) >= ${int(condition.minCount ?? 1, 100000)}`;
    const inOp = condition.negate ? 'NOT IN' : 'IN';
    return `${person} ${inOp} (${subquery})`;
  });
  return parts.join(joiner);
}

// ---------------------------------------------------------------------------
// Breakdowns
// ---------------------------------------------------------------------------

export const NONE_LABEL = '(none)';
export const OTHER_LABEL = 'Other';

/** The SQL text value of a breakdown, `(none)` when missing. */
export function breakdownExpr(breakdown: PanelBreakdown): string {
  if (breakdown.source === 'column') return `COALESCE(CAST(${columnExpr(breakdown.field)} AS VARCHAR), ${lit(NONE_LABEL)})`;
  const column = breakdown.source === 'event' ? 'e.properties' : 'pp.properties';
  return `COALESCE(json_get_str(${column}, ${propertyKey(breakdown.key)}), ${lit(NONE_LABEL)})`;
}

/** The breakdown with every value outside `values` folded into `Other`. */
export function breakdownLimitedExpr(breakdown: PanelBreakdown, values: readonly string[]): string {
  const expr = breakdownExpr(breakdown);
  if (values.length === 0) return lit(OTHER_LABEL);
  return `CASE WHEN ${expr} IN ${inList(values)} THEN ${expr} ELSE ${lit(OTHER_LABEL)} END`;
}

export function breakdownLimit(breakdown: PanelBreakdown): number {
  return breakdown.limit ?? 10;
}

export function breakdownNeedsProfiles(breakdown: PanelBreakdown | undefined): boolean {
  return breakdown?.source === 'person';
}
