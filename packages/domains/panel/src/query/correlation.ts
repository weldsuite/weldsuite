/**
 * `funnel_correlation`: what sets the people who converted apart from the
 * people who dropped. Built on the funnel's step CTEs (./funnel), two
 * statements:
 *
 * - events: every other event a person did between entering the funnel and
 *   converting (or the window's end), counted per name among converters and
 *   among people who dropped (a second, scoped read of the events table);
 * - properties: the column values of each person's first step (country,
 *   device, browser, OS, UTM source, referrer), from the `seq` read already
 *   there, with a `$total` row for the two group sizes.
 *
 * Odds ratios are add-one smoothed, like PostHog's, so a value seen once does
 * not get an infinite ratio; values seen by fewer than three people are left out.
 */

import type {
  PanelCorrelationRow,
  PanelFunnelCorrelationResult,
  ParsedFunnelCorrelationSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelQueryContext } from './context';
import { CORRELATION_COLUMNS, funnelPlan } from './funnel';
import { eventNamesOf, eventsScope, unitExpr, NONE_LABEL } from './scope';
import { inList, lit } from './sql';
import { resolveRange, type ResolvedRange } from './time';
import { toNumber, toText, type PanelSqlQuery, type Row } from './rows';
import { toResolvedRange } from './result-range';

/** System events that say nothing about intent. */
const NOISE_EVENTS = ['$pageleave', '$identify', '$webvitals', '$autocapture'];
const TOTAL = '$total';
const MIN_PEOPLE = 3;
const MAX_EVENT_ROWS = 200;
const MAX_PROPERTY_ROWS = 600;

function outcomeCte(spec: ParsedFunnelCorrelationSpec, ctx: PanelQueryContext, range: ResolvedRange) {
  const plan = funnelPlan(spec, ctx, range, null, { withColumns: true });
  const first = plan.reached[0] as string;
  const last = plan.reached[plan.reached.length - 1] as string;
  const columns = CORRELATION_COLUMNS.map((c) => `MIN(a.c_${c}) AS c_${c}`).join(', ');
  const o =
    `o AS (SELECT a.person AS person, MIN(a.t1) AS t1, MAX(CASE WHEN b.person IS NULL THEN 0 ELSE 1 END) AS conv, ` +
    `MAX(COALESCE(b.t, a.t1 + ${plan.window})) AS t_end, ${columns} ` +
    `FROM ${first} a LEFT JOIN ${last} b ON b.person = a.person AND b.t1 = a.t1 GROUP BY a.person)`;
  return `WITH ${[...plan.ctes, o].join(', ')}`;
}

export function correlationQueries(spec: ParsedFunnelCorrelationSpec, ctx: PanelQueryContext, range: ResolvedRange): PanelSqlQuery[] {
  const withO = outcomeCte(spec, ctx, range);

  const scope = eventsScope(ctx, range, range, { filters: spec.filters });
  const unit = unitExpr(ctx, scope, spec.aggregateBy);
  const stepNames = [...new Set(spec.steps.flatMap((s) => eventNamesOf(s.event, ctx)))];
  const where = scope.where(...unit.conds, 'e.ts >= o.t1', 'e.ts <= o.t_end', `e.name NOT IN ${inList([...stepNames, ...NOISE_EVENTS])}`);
  const eventsSql =
    `${withO} SELECT e.name AS value, COUNT(DISTINCT CASE WHEN o.conv = 1 THEN o.person END) AS success, ` +
    `COUNT(DISTINCT CASE WHEN o.conv = 0 THEN o.person END) AS failure ` +
    `FROM ${scope.from} JOIN o ON o.person = ${unit.expr} ${where} ` +
    `GROUP BY e.name ORDER BY COUNT(DISTINCT o.person) DESC LIMIT ${MAX_EVENT_ROWS}`;

  const props = [TOTAL, ...CORRELATION_COLUMNS];
  const propRows = props.map((p) => 'SELECT ' + lit(p) + ' AS prop');
  const k = `k AS (${propRows.join(' UNION ALL ')})`;
  const whens = CORRELATION_COLUMNS.map((c) => 'WHEN ' + lit(c) + ' THEN COALESCE(CAST(o.c_' + c + ' AS VARCHAR), ' + lit(NONE_LABEL) + ')');
  const value = `CASE k.prop ${whens.join(' ')} ELSE '' END`;
  const propsSql =
    `${withO}, ${k} SELECT k.prop AS prop, ${value} AS value, SUM(o.conv) AS success, SUM(1 - o.conv) AS failure ` +
    `FROM o CROSS JOIN k GROUP BY k.prop, ${value} ORDER BY COUNT(*) DESC LIMIT ${MAX_PROPERTY_ROWS}`;

  return [
    { name: 'correlation.events', sql: eventsSql, columns: ['value', 'success', 'failure'] },
    { name: 'correlation.properties', sql: propsSql, columns: ['prop', 'value', 'success', 'failure'] },
  ];
}

/** One correlation row from the counts with it and the group sizes. */
export function correlationRow(
  type: PanelCorrelationRow['type'],
  property: string | null,
  value: string,
  success: number,
  failure: number,
  converted: number,
  dropped: number,
): PanelCorrelationRow {
  const successWithout = Math.max(converted - success, 0);
  const failureWithout = Math.max(dropped - failure, 0);
  const oddsRatio = (success + 1) / (failure + 1) / ((successWithout + 1) / (failureWithout + 1));
  const rate = (s: number, f: number) => (s + f > 0 ? s / (s + f) : 0);
  return {
    type,
    property,
    value,
    successCount: success,
    failureCount: failure,
    successRateWith: rate(success, failure),
    successRateWithout: rate(successWithout, failureWithout),
    oddsRatio: Math.round(oddsRatio * 1000) / 1000,
    correlation: oddsRatio >= 1 ? 'positive' : 'negative',
  };
}

/** The strongest `limit` positive and `limit` negative rows, strongest first. */
function strongest(rows: PanelCorrelationRow[], limit: number): PanelCorrelationRow[] {
  const strength = (r: PanelCorrelationRow) => Math.abs(Math.log(r.oddsRatio || 1));
  const positive = rows.filter((r) => r.correlation === 'positive' && r.oddsRatio !== 1).sort((a, b) => strength(b) - strength(a)).slice(0, limit);
  const negative = rows.filter((r) => r.correlation === 'negative').sort((a, b) => strength(b) - strength(a)).slice(0, limit);
  return [...positive, ...negative].sort((a, b) => strength(b) - strength(a));
}

export async function runFunnelCorrelation(
  spec: ParsedFunnelCorrelationSpec,
  ctx: PanelQueryContext,
  run: (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>,
): Promise<PanelFunnelCorrelationResult> {
  const range = resolveRange(spec.dateRange, spec.timezone, ctx);
  const [eventRows = [], propertyRows = []] = await run(correlationQueries(spec, ctx, range));

  const total = propertyRows.find((r) => toText(r.prop) === TOTAL);
  const converted = toNumber(total?.success);
  const dropped = toNumber(total?.failure);
  const enough = (r: Row) => toNumber(r.success) + toNumber(r.failure) >= MIN_PEOPLE;

  const events = eventRows
    .filter(enough)
    .map((r) => correlationRow('event', null, toText(r.value), toNumber(r.success), toNumber(r.failure), converted, dropped));
  const properties = propertyRows
    .filter((r) => toText(r.prop) !== TOTAL && enough(r))
    .map((r) => correlationRow('property', toText(r.prop), toText(r.value), toNumber(r.success), toNumber(r.failure), converted, dropped));

  return {
    range: toResolvedRange(range, null),
    converted,
    dropped,
    events: strongest(events, spec.limit),
    properties: strongest(properties, spec.limit),
  };
}
