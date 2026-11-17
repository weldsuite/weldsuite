/**
 * `impact`: did launching a feature move a metric? The people who did the
 * launch event on or after the launch day (adopters) against everyone else
 * active in the same windows, `windowDays` before the launch against
 * `windowDays` after, and the difference in differences.
 *
 * Two statements over the two windows:
 * - per person: adopted or not, the metric before and after (one scan of all
 *   events, grouped per person, then per group);
 * - adoption: each adopter's first launch event day after the launch.
 */

import type {
  PanelImpactGroup,
  PanelImpactResult,
  ParsedImpactSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelQueryContext } from './context';
import { eventMatch, eventPropertyNumber, eventsScope, eventWithFilters, scopeNeeds, unitExpr } from './scope';
import { PanelQueryError, ts } from './sql';
import { bucketLabel, bucketLabels, bucketSql, dayStart, queryNow, resolveRange, type ResolvedRange, type TimeBounds } from './time';
import { toNumber, type PanelSqlQuery, type Row } from './rows';
import { toResolvedRange } from './result-range';

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export interface ImpactWindows {
  range: ResolvedRange;
  launch: Date;
  after: TimeBounds;
}

/** The two windows around the launch, clamped to the retention and to now. */
export function impactWindows(spec: ParsedImpactSpec, ctx: PanelQueryContext): ImpactWindows {
  const launch = dayStart(spec.launchDate, spec.timezone);
  if (launch.getTime() > queryNow(ctx).getTime()) throw new PanelQueryError('The launch date is in the future');
  const range = resolveRange({ from: addDays(spec.launchDate, -spec.windowDays), to: addDays(spec.launchDate, spec.windowDays - 1) }, spec.timezone, ctx);
  if (launch.getTime() <= range.from.getTime()) throw new PanelQueryError('The launch date is older than the data kept');
  return { range, launch, after: { from: launch, to: range.to } };
}

export function impactQueries(spec: ParsedImpactSpec, ctx: PanelQueryContext, windows: ImpactWindows): PanelSqlQuery[] {
  const { range, launch, after } = windows;
  const needs = scopeNeeds(ctx, { filters: [spec.metric.filters], events: [spec.launchEvent, spec.metric.event] });
  const scope = eventsScope(ctx, range, range, { filters: spec.filters, ...needs });
  const unit = unitExpr(ctx, scope, undefined);
  // The launch instant is written first (`TIMESTAMP … <= e.ts`): the scope's own bounds stay the only `e.ts >= TIMESTAMP` of the statement.
  const launched = `${eventMatch(spec.launchEvent, ctx, range, scope.person)} AND ${ts(launch)} <= e.ts`;
  const metric = eventWithFilters(spec.metric.event, spec.metric.filters, ctx, range, scope.person);
  const amount = spec.metric.math === 'sum' || spec.metric.math === 'avg' ? `COALESCE(${eventPropertyNumber(spec.metric.property ?? '', ctx)}, 0)` : '1';
  const before = `${ts(launch)} > e.ts`;
  const afterCond = `${ts(launch)} <= e.ts`;

  const per =
    `SELECT ${unit.expr} AS u, MAX(CASE WHEN ${launched} THEN 1 ELSE 0 END) AS adopted, ` +
    `SUM(CASE WHEN ${metric} AND ${before} THEN ${amount} ELSE 0 END) AS mb, SUM(CASE WHEN ${metric} AND ${afterCond} THEN ${amount} ELSE 0 END) AS ma, ` +
    `MAX(CASE WHEN ${metric} AND ${before} THEN 1 ELSE 0 END) AS ub, MAX(CASE WHEN ${metric} AND ${afterCond} THEN 1 ELSE 0 END) AS ua, ` +
    `SUM(CASE WHEN ${metric} AND ${before} THEN 1 ELSE 0 END) AS cb, SUM(CASE WHEN ${metric} AND ${afterCond} THEN 1 ELSE 0 END) AS ca, ` +
    `MAX(CASE WHEN ${afterCond} THEN 1 ELSE 0 END) AS active_after ` +
    `FROM ${scope.from} ${scope.where(...unit.conds)} GROUP BY ${unit.expr}`;
  const groupsSql =
    `SELECT adopted, COUNT(*) AS users, SUM(mb) AS mb, SUM(ma) AS ma, SUM(ub) AS ub, SUM(ua) AS ua, SUM(cb) AS cb, SUM(ca) AS ca, ` +
    `SUM(active_after) AS active_after FROM (${per}) AS per GROUP BY adopted`;

  const adoptionScope = eventsScope(ctx, range, after, { filters: spec.filters, ...scopeNeeds(ctx, { events: [spec.launchEvent] }) });
  const day = bucketSql('e.ts', 'day', range.offsetMinutes);
  const adoptionSql =
    `SELECT first_day AS bucket, COUNT(*) AS n FROM (SELECT ${adoptionScope.person} AS u, MIN(${day}) AS first_day FROM ${adoptionScope.from} ` +
    `${adoptionScope.where(eventMatch(spec.launchEvent, ctx, range, adoptionScope.person))} GROUP BY ${adoptionScope.person}) AS firsts GROUP BY first_day`;

  return [
    { name: 'impact.groups', sql: groupsSql, columns: ['adopted', 'users', 'mb', 'ma', 'ub', 'ua', 'cb', 'ca', 'active_after'] },
    { name: 'impact.adoption', sql: adoptionSql, columns: ['bucket', 'n'] },
  ];
}

function round(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 10000) / 10000;
}

/** One group's metric before and after, per the spec's math. */
export function impactGroup(spec: ParsedImpactSpec, row: Row | undefined): PanelImpactGroup {
  const users = toNumber(row?.users);
  const per = (sum: number, base: number) => (base > 0 ? sum / base : null);
  let before: number | null;
  let after: number | null;
  switch (spec.metric.math) {
    case 'unique_users':
      before = per(toNumber(row?.ub), users);
      after = per(toNumber(row?.ua), users);
      break;
    case 'avg':
      before = per(toNumber(row?.mb), toNumber(row?.cb));
      after = per(toNumber(row?.ma), toNumber(row?.ca));
      break;
    default:
      before = per(toNumber(row?.mb), users);
      after = per(toNumber(row?.ma), users);
  }
  return { users, before: round(before), after: round(after), change: before === null || after === null ? null : round(after - before) };
}

export async function runImpact(
  spec: ParsedImpactSpec,
  ctx: PanelQueryContext,
  run: (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>,
): Promise<PanelImpactResult> {
  const windows = impactWindows(spec, ctx);
  const [groupRows = [], adoptionRows = []] = await run(impactQueries(spec, ctx, windows));

  const adopters = impactGroup(spec, groupRows.find((r) => toNumber(r.adopted) === 1));
  const nonAdopters = impactGroup(spec, groupRows.find((r) => toNumber(r.adopted) !== 1));
  const activeAfter = groupRows.reduce((sum, r) => sum + toNumber(r.active_after), 0);
  const did = adopters.change === null || nonAdopters.change === null ? null : round(adopters.change - nonAdopters.change);

  const byDay = new Map<string, number>();
  for (const row of adoptionRows) byDay.set(bucketLabel(row.bucket, 'day'), (byDay.get(bucketLabel(row.bucket, 'day')) ?? 0) + toNumber(row.n));
  let soFar = 0;
  const adoption = bucketLabels(windows.after, 'day', windows.range.offsetMinutes).map((bucket) => {
    const newAdopters = byDay.get(bucket) ?? 0;
    soFar += newAdopters;
    return { bucket, newAdopters, adopters: soFar, rate: activeAfter > 0 ? Math.min(soFar / activeAfter, 1) : 0 };
  });

  return {
    range: toResolvedRange(windows.range, null),
    launchDate: spec.launchDate,
    windowDays: spec.windowDays,
    adoption,
    adopters,
    nonAdopters,
    differenceInDifferences: did,
    relativeImpact: did !== null && adopters.before !== null && adopters.before !== 0 ? round(did / adopters.before) : null,
  };
}
