/**
 * The scoped read of `events_v1`: the one place that writes the workspace and
 * project filters, the time bound, the erased-id exclusion, the identity join,
 * the person-property join and the group-property joins. Every compiled query,
 * every CTE and every subquery that touches a panel table is built here, so
 * isolation rests on one function and one test (`compile.test.ts`).
 *
 * Aliases: `e` events, `i` latest identity per anonymous id, `pp` latest
 * profile per user, `g_<type>` latest profile of the event's group of that
 * type. A subquery builds its own scope; inner aliases shadow the outer ones.
 *
 * Also here: what a spec's references stand for. A custom event (`@pnce_…`)
 * becomes the OR of its events and their filters, a computed property
 * (`@pncp_…`) a formula or a COALESCE over event properties, both from the
 * definitions panel-api put in the context (never from the spec).
 */

import {
  PANEL_FILTER_COLUMNS,
  groupKeyProperty,
  isComputedPropertyRef,
  isCustomEventRef,
  type ParsedPanelCohortFilter,
  type PanelAggregateBy,
  type PanelBreakdown,
  type PanelFilter,
  type PanelFilterOperator,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { ParsedPanelCustomEventDefinition } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { BASIN_NAMESPACE, type PanelQueryContext } from './context';
import { PANEL_TABLES } from '../tables';
import { parseExpression, toSql } from '../expression';
import { cleanedPathSql } from './paths';
import {
  PanelQueryError,
  eventName,
  groupType as checkedGroupType,
  inList,
  int,
  likeContains,
  lit,
  LIKE_ESCAPE,
  num,
  propertyKey,
  refIdOf,
  ts,
} from './sql';
import { queryNow, type ResolvedRange, type TimeBounds } from './time';

const MAX_ERASED_IN_SQL = 5000;

export const eventsTable = `${BASIN_NAMESPACE}.${PANEL_TABLES.events}`;
export const identitiesTable = `${BASIN_NAMESPACE}.${PANEL_TABLES.identities}`;
export const peopleTable = `${BASIN_NAMESPACE}.${PANEL_TABLES.people}`;
export const groupsTable = `${BASIN_NAMESPACE}.${PANEL_TABLES.groups}`;
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

/** A group type the project has (when the context lists them), checked against the pattern. */
export function knownGroupType(ctx: PanelQueryContext, type: string): string {
  const checked = checkedGroupType(type);
  if (ctx.groupTypes && !ctx.groupTypes.includes(checked)) throw new PanelQueryError('That group type does not exist');
  return checked;
}

/** Current profile per group key of one type (highest version), not deleted, like {@link peopleLatest}. */
export function groupsLatest(ctx: PanelQueryContext, range: ResolvedRange, type: string): string {
  const conds = [...scopeConds(ctx), ...historyBounds(ctx, range, 'ts'), `group_type = ${lit(knownGroupType(ctx, type))}`];
  return (
    `(SELECT group_key, properties FROM (SELECT group_key, properties, deleted, ROW_NUMBER() OVER (PARTITION BY group_key ORDER BY version DESC) AS rn ` +
    `FROM ${groupsTable} WHERE ${conds.join(' AND ')}) AS gl WHERE rn = 1 AND deleted = false)`
  );
}

/** The alias of a joined group profile: `g_<type>` (the type is checked against its pattern first). */
export function groupAlias(type: string): string {
  return `g_${checkedGroupType(type)}`;
}

/** The event's group key of a type: `json_get_str(e.properties, '$group_<type>')`. */
export function groupKeyExpr(type: string): string {
  return `json_get_str(e.properties, ${propertyKey(groupKeyProperty(checkedGroupType(type)))})`;
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
  /** Join the latest profile of these group types (group filters and breakdowns). */
  groupTypes?: readonly string[];
  /** Further conditions on `e` (already built from validated values). */
  extraConds?: readonly string[];
}

export function personExpr(ctx: PanelQueryContext): string {
  return ctx.hasIdentifiedUsers ? 'COALESCE(i.user_id, e.distinct_id)' : 'e.distinct_id';
}

/** The scoped events read for `bounds`. */
export function eventsScope(ctx: PanelQueryContext, range: ResolvedRange, bounds: TimeBounds, options: ScopeOptions = {}): EventsScope {
  const person = personExpr(ctx);
  const own = scopeNeeds(ctx, { filters: options.filters ? [options.filters] : [] });
  const joinProfiles = options.personProps === true || own.personProps;
  const groupTypes = [...new Set([...(options.groupTypes ?? []), ...own.groupTypes])].sort();

  let from = `${eventsTable} e`;
  if (ctx.hasIdentifiedUsers) from += ` LEFT JOIN ${identitiesLatest(ctx, range)} i ON i.anon_id = e.anon_id`;
  if (joinProfiles) from += ` LEFT JOIN ${peopleLatest(ctx, range)} pp ON pp.user_id = ${person}`;
  for (const type of groupTypes) {
    const alias = groupAlias(type);
    from += ` LEFT JOIN ${groupsLatest(ctx, range, type)} ${alias} ON ${alias}.group_key = ${groupKeyExpr(type)}`;
  }

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
// What a scope has to join
// ---------------------------------------------------------------------------

export interface ScopeUse {
  /** Filter lists compiled against the scope (the spec's, a series', a step's...). */
  filters?: readonly (readonly PanelFilter[])[];
  /** Event refs matched against the scope (custom events bring their own filters). */
  events?: readonly string[];
  breakdowns?: readonly (PanelBreakdown | undefined)[];
}

export interface ScopeNeeds {
  personProps: boolean;
  groupTypes: string[];
}

/** The joins a scope needs for these filters, events and breakdowns. */
export function scopeNeeds(ctx: PanelQueryContext, use: ScopeUse): ScopeNeeds {
  let personProps = false;
  const groupTypes = new Set<string>();
  const fromFilters = (filters: readonly PanelFilter[]) => {
    for (const f of filters) {
      if (f.source === 'person') personProps = true;
      if (f.source === 'group') groupTypes.add(f.groupType);
    }
  };
  for (const list of use.filters ?? []) fromFilters(list);
  for (const ref of use.events ?? []) {
    if (!isCustomEventRef(ref)) continue;
    for (const m of customEvent(ctx, ref).match) fromFilters(m.filters as readonly PanelFilter[]);
  }
  for (const b of use.breakdowns ?? []) {
    if (b?.source === 'person') personProps = true;
    if (b?.source === 'group') groupTypes.add(b.groupType);
  }
  return { personProps, groupTypes: [...groupTypes].sort() };
}

// ---------------------------------------------------------------------------
// Events: names and custom events
// ---------------------------------------------------------------------------

function customEvent(ctx: PanelQueryContext, ref: string): ParsedPanelCustomEventDefinition {
  const def = ctx.customEvents?.[refIdOf(ref, 'pnce')];
  if (!def) throw new PanelQueryError('That custom event does not exist');
  if (def.match.length === 0) throw new PanelQueryError('That custom event has no events');
  return def;
}

/** The tracked event names an event ref stands for (one, or a custom event's). */
export function eventNamesOf(ref: string, ctx: PanelQueryContext): string[] {
  if (!isCustomEventRef(ref)) return [ref];
  return [...new Set(customEvent(ctx, ref).match.map((m) => m.event))];
}

/** `e.name IN (…)` for every name the refs stand for: a cheap pre-filter before the exact match. */
export function namesCondition(refs: readonly string[], ctx: PanelQueryContext): string {
  const names = [...new Set(refs.flatMap((ref) => eventNamesOf(ref, ctx)))];
  names.forEach(eventName);
  return `e.name IN ${inList(names)}`;
}

/**
 * SQL that is true for events matching `ref`: `e.name = 'X'`, or for a custom
 * event the OR of its events with their filters.
 */
export function eventMatch(ref: string, ctx: PanelQueryContext, range: ResolvedRange, person: string): string {
  if (!isCustomEventRef(ref)) return `e.name = ${eventName(ref)}`;
  const parts = customEvent(ctx, ref).match.map((m) => {
    for (const f of m.filters) if (f.source === 'cohort') throw new PanelQueryError('Custom events cannot use cohorts');
    const conds = [`e.name = ${eventName(m.event)}`, ...compileFilters(m.filters as readonly PanelFilter[], ctx, range, person)];
    return `(${conds.join(' AND ')})`;
  });
  return `(${parts.join(' OR ')})`;
}

/** An event ref and extra filters as one condition. */
export function eventWithFilters(ref: string, filters: readonly PanelFilter[], ctx: PanelQueryContext, range: ResolvedRange, person: string): string {
  return [eventMatch(ref, ctx, range, person), ...compileFilters(filters, ctx, range, person)].join(' AND ');
}

// ---------------------------------------------------------------------------
// Who is counted
// ---------------------------------------------------------------------------

export interface UnitExpr {
  /** People, or the event's group key. */
  expr: string;
  /** Conditions the events need (a group key). */
  conds: string[];
}

/** What a measure counts: people (the scope's person), or groups of one type (events without that group are left out). */
export function unitExpr(ctx: PanelQueryContext, scope: EventsScope, aggregateBy: PanelAggregateBy | undefined): UnitExpr {
  if (!aggregateBy || aggregateBy === 'person') return { expr: scope.person, conds: [] };
  const key = groupKeyExpr(knownGroupType(ctx, aggregateBy.groupType));
  return { expr: key, conds: [`${key} IS NOT NULL`] };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export function columnExpr(field: string): string {
  if (!(PANEL_FILTER_COLUMNS as readonly string[]).includes(field)) throw new PanelQueryError(`Unknown column: ${field.slice(0, 40)}`);
  return `e.${field}`;
}

export interface ValueExprs {
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

function computedExprs(ref: string, ctx: PanelQueryContext): ValueExprs {
  const def = ctx.computedProperties?.[refIdOf(ref, 'pncp')];
  if (!def) throw new PanelQueryError('That computed property does not exist');
  if (def.kind === 'formula') {
    const parsed = parseExpression(def.expression, { identifiers: 'properties' });
    if (!parsed.ok) throw new PanelQueryError(`A computed property's formula does not parse: ${parsed.error.message}`);
    const value = toSql(parsed.ast, (key) => `json_get_float(e.properties, ${propertyKey(key)})`);
    return { str: `CAST(${value} AS VARCHAR)`, num: value, bool: null, isSet: `${value} IS NOT NULL` };
  }
  if (def.keys.length < 2 || def.keys.length > 5) throw new PanelQueryError('A computed property takes 2 to 5 inputs');
  const strs = def.keys.map((k) => (k.source === 'column' ? `CAST(${columnExpr(k.field)} AS VARCHAR)` : `json_get_str(e.properties, ${propertyKey(k.key)})`));
  const floats = def.keys.flatMap((k) => (k.source === 'event' ? ['json_get_float(e.properties, ' + propertyKey(k.key) + ')'] : []));
  const nums = floats.length === def.keys.length ? `COALESCE(${floats.join(', ')})` : null;
  const str = `COALESCE(${strs.join(', ')})`;
  return { str, num: nums, bool: null, isSet: `${str} IS NOT NULL` };
}

/** An event property (or computed property) as SQL values. */
export function eventPropertyExprs(key: string, ctx: PanelQueryContext): ValueExprs {
  return isComputedPropertyRef(key) ? computedExprs(key, ctx) : jsonExprs('e.properties', key);
}

/** The numeric value of an event property (the math of `sum`, `avg`...). */
export function eventPropertyNumber(key: string, ctx: PanelQueryContext): string {
  const exprs = eventPropertyExprs(key, ctx);
  if (!exprs.num) throw new PanelQueryError('That property is not a number');
  return exprs.num;
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
function filterCondition(filter: Exclude<PanelFilter, { source: 'cohort' }>, ctx: PanelQueryContext): string {
  const value = filter.value as FilterValue | undefined;
  switch (filter.source) {
    case 'column': {
      const col = columnExpr(filter.field);
      if (filter.operator === 'is_not_set') return `${col} IS NULL`;
      const ex: ValueExprs = { str: col, num: null, bool: null, isSet: `${col} IS NOT NULL` };
      return comparison(filter.operator, value, ex);
    }
    case 'event':
      return comparison(filter.operator, value, eventPropertyExprs(filter.key, ctx));
    case 'person':
      return comparison(filter.operator, value, jsonExprs('pp.properties', filter.key));
    case 'group': {
      const properties = groupAlias(knownGroupType(ctx, filter.groupType)) + '.properties';
      const exprs = jsonExprs(properties, filter.key);
      if (filter.operator === 'is_not_set') return `(${properties} IS NULL OR NOT ${exprs.isSet})`;
      return comparison(filter.operator, value, exprs);
    }
    case 'group_key': {
      knownGroupType(ctx, filter.groupType);
      return comparison(filter.operator, value, jsonExprs('e.properties', groupKeyProperty(filter.groupType)));
    }
    default:
      throw new PanelQueryError('Unknown filter');
  }
}

/** The conditions for a list of filters, ANDed by the caller. Cohort filters become person subqueries. */
export function compileFilters(filters: readonly PanelFilter[], ctx: PanelQueryContext, range: ResolvedRange, person: string): string[] {
  return filters.map((filter) => {
    if (filter.source !== 'cohort') return `(${filterCondition(filter, ctx)})`;
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

export interface BreakdownExprOptions {
  /** Apply the path rules to a `path` column breakdown. */
  cleanPaths?: boolean;
  /** Numeric bucket edges (low to high) for a bucketed breakdown; see ./breakdowns. */
  edges?: readonly number[];
}

/** The numeric value of a breakdown's property (for bucketing). */
export function breakdownNumberExpr(breakdown: PanelBreakdown, ctx: PanelQueryContext): string {
  switch (breakdown.source) {
    case 'event':
      return eventPropertyNumber(breakdown.key, ctx);
    case 'person':
      return `json_get_float(pp.properties, ${propertyKey(breakdown.key)})`;
    case 'group':
      return `json_get_float(${groupAlias(knownGroupType(ctx, breakdown.groupType))}.properties, ${propertyKey(breakdown.key)})`;
    default:
      throw new PanelQueryError('Only property breakdowns can be put in buckets');
  }
}

/** Short label of a bucket edge. */
export function formatEdge(value: number): string {
  return String(Number(value.toPrecision(10)));
}

/** The bucket labels for `edges`, in order: `< a`, `a – b`, …, `≥ z`. */
export function bucketLabelsFor(edges: readonly number[]): string[] {
  const labels = [`< ${formatEdge(edges[0] as number)}`];
  for (let i = 1; i < edges.length; i += 1) labels.push(`${formatEdge(edges[i - 1] as number)} – ${formatEdge(edges[i] as number)}`);
  labels.push(`≥ ${formatEdge(edges[edges.length - 1] as number)}`);
  return labels;
}

/** `CASE` putting a number into its bucket label (`(none)` when missing). */
export function bucketCaseSql(value: string, edges: readonly number[]): string {
  if (edges.length === 0 || edges.length > 19) throw new PanelQueryError('Use 1 to 19 bucket edges');
  const labels = bucketLabelsFor(edges);
  const whens = edges.map((edge, i) => `WHEN ${value} < ${num(edge)} THEN ${lit(labels[i] as string)}`);
  return `CASE WHEN ${value} IS NULL THEN ${lit(NONE_LABEL)} ${whens.join(' ')} ELSE ${lit(labels[labels.length - 1] as string)} END`;
}

/** The SQL text value of a breakdown, `(none)` when missing. */
export function breakdownExpr(breakdown: PanelBreakdown, ctx?: PanelQueryContext, options: BreakdownExprOptions = {}): string {
  if (breakdown.source === 'column') {
    const column = columnExpr(breakdown.field);
    const value = breakdown.field === 'path' && ctx ? cleanedPathSql(ctx, options.cleanPaths, column) : column;
    return `COALESCE(CAST(${value} AS VARCHAR), ${lit(NONE_LABEL)})`;
  }
  const needsContext = (options.edges && breakdown.bucket) || breakdown.source === 'group' || isComputedPropertyRef(breakdown.key);
  if (needsContext && !ctx) throw new PanelQueryError('This breakdown needs the query context');
  if (options.edges && breakdown.bucket) return bucketCaseSql(breakdownNumberExpr(breakdown, ctx as PanelQueryContext), options.edges);
  return `COALESCE(${propertyBreakdownText(breakdown, ctx)}, ${lit(NONE_LABEL)})`;
}

/** The text value of an event, person or group property breakdown (null when missing). */
function propertyBreakdownText(breakdown: Exclude<PanelBreakdown, { source: 'column' }>, ctx: PanelQueryContext | undefined): string {
  if (breakdown.source === 'event') {
    return isComputedPropertyRef(breakdown.key)
      ? eventPropertyExprs(breakdown.key, ctx as PanelQueryContext).str
      : `json_get_str(e.properties, ${propertyKey(breakdown.key)})`;
  }
  const alias = breakdown.source === 'group' ? groupAlias(knownGroupType(ctx as PanelQueryContext, breakdown.groupType)) : 'pp';
  return `json_get_str(${alias}.properties, ${propertyKey(breakdown.key)})`;
}

/** `expr` with every value outside `values` folded into `Other`. */
export function limitedExpr(expr: string, values: readonly string[]): string {
  if (values.length === 0) return lit(OTHER_LABEL);
  return `CASE WHEN ${expr} IN ${inList(values)} THEN ${expr} ELSE ${lit(OTHER_LABEL)} END`;
}

/** The breakdown with every value outside `values` folded into `Other`. */
export function breakdownLimitedExpr(breakdown: PanelBreakdown, values: readonly string[], ctx?: PanelQueryContext, options: BreakdownExprOptions = {}): string {
  return limitedExpr(breakdownExpr(breakdown, ctx, options), values);
}

export function breakdownLimit(breakdown: PanelBreakdown): number {
  return breakdown.limit ?? 10;
}

export function breakdownNeedsProfiles(breakdown: PanelBreakdown | undefined): boolean {
  return breakdown?.source === 'person';
}
