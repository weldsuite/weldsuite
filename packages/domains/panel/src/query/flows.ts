/**
 * `flows`: the most common paths after (or before) an event. One scan: the
 * events of each person in order, with `LEAD` / `LAG` giving the neighbours of
 * every anchor occurrence. Pages are labelled by path, other events by name.
 */

import type { PanelFlowPath, PanelFlowsResult, ParsedFlowsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelQueryContext } from './context';
import { cleanedPathSql } from './paths';
import { eventsScope, eventWithFilters, scopeNeeds } from './scope';
import { int, lit } from './sql';
import { resolveRange, type ResolvedRange } from './time';
import { toNumber, toNullableText, type PanelSqlQuery, type Row } from './rows';
import { toResolvedRange } from './result-range';

/** Rows read before the spec's `limit` trims them. */
const MAX_PATH_ROWS = 500;

export function flowsQuery(spec: ParsedFlowsSpec, ctx: PanelQueryContext, range: ResolvedRange): PanelSqlQuery {
  const needs = scopeNeeds(ctx, { filters: [spec.anchor.filters], events: [spec.anchor.event] });
  const scope = eventsScope(ctx, range, range, { filters: spec.filters, ...needs });
  const anchor = `(${eventWithFilters(spec.anchor.event, spec.anchor.filters, ctx, range, scope.person)})`;
  // Pages are labelled by their (cleaned) path, other events by name.
  const label = `CASE WHEN e.name = '$pageview' THEN ${cleanedPathSql(ctx, spec.cleanPaths)} ELSE e.name END`;

  let inScope: string | null = null;
  if (spec.scope === 'pageviews') inScope = `e.name = ${lit('$pageview')}`;
  else if (spec.scope === 'custom') inScope = `e.name NOT LIKE '$%'`;
  const where = inScope ? scope.where(`(${inScope} OR ${anchor})`) : scope.where();

  const fn = spec.direction === 'after' ? 'LEAD' : 'LAG';
  const columns = Array.from({ length: spec.depth }, (_, i) => `n${i + 1}`);
  const neighbours = columns.map(
    (name, i) => `${fn}(${label}, ${i + 1}) OVER (PARTITION BY ${scope.person} ORDER BY e.ts, e.event_id) AS ${name}`,
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
