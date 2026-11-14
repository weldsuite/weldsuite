/**
 * `flows`: the most common paths after (or before) an event. One scan: the
 * events of each person in order, with `LEAD` / `LAG` giving the neighbours of
 * every anchor occurrence. Pages are labelled by path, other events by name.
 */

import type { PanelFlowPath, PanelFlowsResult, ParsedFlowsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelQueryContext } from './context';
import { compileFilters, eventsScope } from './scope';
import { eventName, int, lit } from './sql';
import { resolveRange, type ResolvedRange } from './time';
import { toNumber, toNullableText, type PanelSqlQuery, type Row } from './rows';
import { toResolvedRange } from './result-range';

/** Rows read before the spec's `limit` trims them. */
const MAX_PATH_ROWS = 500;

const LABEL = `CASE WHEN e.name = '$pageview' THEN e.path ELSE e.name END`;

export function flowsQuery(spec: ParsedFlowsSpec, ctx: PanelQueryContext, range: ResolvedRange): PanelSqlQuery {
  const needsProfiles = spec.anchor.filters.some((f) => f.source === 'person');
  const scope = eventsScope(ctx, range, range, { filters: spec.filters, personProps: needsProfiles });
  const anchor = `(${[`e.name = ${eventName(spec.anchor.event)}`, ...compileFilters(spec.anchor.filters, ctx, range, scope.person)].join(' AND ')})`;

  const inScope =
    spec.scope === 'pageviews' ? `e.name = ${lit('$pageview')}` : spec.scope === 'custom' ? `e.name NOT LIKE '$%'` : null;
  const where = inScope ? scope.where(`(${inScope} OR ${anchor})`) : scope.where();

  const fn = spec.direction === 'after' ? 'LEAD' : 'LAG';
  const columns = Array.from({ length: spec.depth }, (_, i) => `n${i + 1}`);
  const neighbours = columns.map(
    (name, i) => `${fn}(${LABEL}, ${i + 1}) OVER (PARTITION BY ${scope.person} ORDER BY e.ts, e.event_id) AS ${name}`,
  );
  const sql =
    `SELECT ${columns.join(', ')}, COUNT(*) AS cnt FROM (` +
    `SELECT CASE WHEN ${anchor} THEN 1 ELSE 0 END AS is_anchor, ${neighbours.join(', ')} FROM ${scope.from} ${where}` +
    `) AS seq WHERE is_anchor = 1 GROUP BY ${columns.join(', ')} ORDER BY COUNT(*) DESC LIMIT ${int(MAX_PATH_ROWS, MAX_PATH_ROWS)}`;
  return { name: 'flows.paths', sql, columns: [...columns, 'cnt'] };
}

export async function runFlows(
  spec: ParsedFlowsSpec,
  ctx: PanelQueryContext,
  run: (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>,
): Promise<PanelFlowsResult> {
  const range = resolveRange(spec.dateRange, spec.timezone, ctx);
  const rows = (await run([flowsQuery(spec, ctx, range)]))[0] ?? [];

  const all: PanelFlowPath[] = rows.map((row) => ({
    steps: Array.from({ length: spec.depth }, (_, i) => toNullableText(row[`n${i + 1}`])),
    count: toNumber(row.cnt),
  }));
  return {
    range: toResolvedRange(range, null),
    anchor: spec.anchor.label?.trim() || spec.anchor.event,
    direction: spec.direction,
    depth: spec.depth,
    anchorCount: all.reduce((sum, p) => sum + p.count, 0),
    paths: all.slice(0, spec.limit),
  };
}
