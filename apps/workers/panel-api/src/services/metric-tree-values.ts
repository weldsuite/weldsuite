/**
 * Metric tree values: each node's single trends series over a period and the
 * period before it, the change, and for `influence` nodes how closely its
 * daily values follow the parent's (Pearson). Every node runs through
 * `runCachedQuery`, so nodes shared between trees (or with a report on a
 * dashboard) cost one Basin read per two minutes. A node that cannot run
 * (its report is gone, not a trends report, or refused by the compiler)
 * carries an error and the others still answer.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import {
  trendsSpecSchema,
  type PanelDateRange,
  type PanelResolvedRange,
  type PanelTrendPoint,
  type ParsedTrendsSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { ParsedPanelMetricTreeNode } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelMetricTreeNodeValue, PanelMetricTreeValues } from '@weldsuite/app-api-client/schemas/weldpanel-analysis';
import { PanelQueryError } from '@weldsuite/panel-domain/query';
import { canSee, type Actor } from './saved-objects';
import { QueryUnavailableError } from './query-engine';
import { runCachedQuery, type QueryRunDeps } from './query-run';

const { panelReports } = schema;

/** Nodes run a few at a time: each is up to four Basin statements. */
const NODES_AT_ONCE = 4;
const DEFAULT_RANGE: PanelDateRange = { preset: '30d' };

export interface ValuesPeriod {
  dateRange?: PanelDateRange;
  timezone?: string;
}

/** Pearson correlation of two equally long series; null when either is flat or too short. */
export function pearson(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i += 1) {
    sa += a[i] as number;
    sb += b[i] as number;
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = (a[i] as number) - ma;
    const db = (b[i] as number) - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return null;
  return Math.round((cov / Math.sqrt(va * vb)) * 10000) / 10000;
}

type Resolved = { spec: ParsedTrendsSpec } | { error: string };

/** The specs behind `{ reportId }` nodes, checked: same project, visible to the caller, a trends report. */
async function reportSpecs(deps: QueryRunDeps, actor: Actor, projectId: string, nodes: readonly ParsedPanelMetricTreeNode[]): Promise<Map<string, Resolved>> {
  const ids = [...new Set(nodes.flatMap((n) => ('reportId' in n.metric ? [n.metric.reportId] : [])))];
  const out = new Map<string, Resolved>();
  if (ids.length === 0) return out;
  const rows = await deps.tenantDb
    .select()
    .from(panelReports)
    .where(and(eq(panelReports.projectId, projectId), inArray(panelReports.id, ids), isNull(panelReports.deletedAt)));
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (!row || !canSee(row, actor)) {
      out.set(id, { error: 'report_not_found' });
      continue;
    }
    const parsed = trendsSpecSchema.safeParse({ ...row.spec, projectId });
    out.set(id, parsed.success ? { spec: parsed.data } : { error: 'not_a_trends_report' });
  }
  return out;
}

/** A node's metric as the spec that runs: its first series, daily, with the previous period, over the tree's period. */
function nodeSpec(spec: ParsedTrendsSpec, projectId: string, period: ValuesPeriod): ParsedTrendsSpec {
  const series = spec.series[0];
  return trendsSpecSchema.parse({
    projectId,
    kind: 'trends',
    series: series ? [series] : [],
    filters: spec.filters,
    interval: 'day',
    compare: true,
    dateRange: period.dateRange ?? DEFAULT_RANGE,
    timezone: period.timezone ?? 'UTC',
    cleanPaths: spec.cleanPaths,
  });
}

interface NodeRun {
  value: number | null;
  previous: number | null;
  points: PanelTrendPoint[];
  range: PanelResolvedRange | null;
  dataAsOf: string | null;
  error: string | null;
}

async function runNode(deps: QueryRunDeps, resolved: Resolved, projectId: string, period: ValuesPeriod): Promise<NodeRun> {
  const failed = (error: string): NodeRun => ({ value: null, previous: null, points: [], range: null, dataAsOf: null, error });
  if ('error' in resolved) return failed(resolved.error);
  try {
    const { result, dataAsOf } = await runCachedQuery(deps, nodeSpec(resolved.spec, projectId, period));
    if (result.kind !== 'trends') return failed('query_failed');
    const line = result.result.series[0];
    return {
      value: line?.total ?? 0,
      previous: line?.previous?.total ?? null,
      points: line?.points ?? [],
      range: result.result.range,
      dataAsOf,
      error: null,
    };
  } catch (err) {
    if (err instanceof QueryUnavailableError) throw err;
    if (err instanceof PanelQueryError) return failed(err.message);
    console.error('[panel-api] metric tree node failed', err);
    return failed('query_failed');
  }
}

/** Every node's value. Throws `QueryUnavailableError` when queries cannot run here at all. */
export async function metricTreeValues(
  deps: QueryRunDeps,
  actor: Actor,
  projectId: string,
  nodes: readonly ParsedPanelMetricTreeNode[],
  period: ValuesPeriod,
): Promise<PanelMetricTreeValues> {
  const reports = await reportSpecs(deps, actor, projectId, nodes);
  const resolved = nodes.map((node): Resolved => {
    if ('reportId' in node.metric) return reports.get(node.metric.reportId) ?? { error: 'report_not_found' };
    return { spec: node.metric.spec };
  });

  const runs: NodeRun[] = new Array<NodeRun>(nodes.length);
  for (let i = 0; i < nodes.length; i += NODES_AT_ONCE) {
    const batch = await Promise.all(nodes.slice(i, i + NODES_AT_ONCE).map((_, j) => runNode(deps, resolved[i + j] as Resolved, projectId, period)));
    batch.forEach((run, j) => {
      runs[i + j] = run;
    });
  }

  const byId = new Map(nodes.map((node, i) => [node.id, runs[i] as NodeRun]));
  const values = nodes.map((node, i): PanelMetricTreeNodeValue => {
    const run = runs[i] as NodeRun;
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    let correlation: number | null = null;
    if (node.relation === 'influence' && parent && !run.error && !parent.error) {
      const parentByBucket = new Map(parent.points.map((p) => [p.bucket, p.value]));
      const pairs = run.points.filter((p) => parentByBucket.has(p.bucket));
      correlation = pearson(pairs.map((p) => p.value), pairs.map((p) => parentByBucket.get(p.bucket) as number));
    }
    const change = run.value !== null && run.previous !== null && run.previous !== 0 ? (run.value - run.previous) / run.previous : null;
    return {
      id: node.id,
      label: node.label,
      parentId: node.parentId,
      relation: node.relation,
      value: run.value,
      previous: run.previous,
      changePercent: change === null ? null : Math.round(change * 10000) / 10000,
      correlationWithParent: correlation,
      points: run.points,
      error: run.error,
    };
  });

  const first = runs.find((r) => r.range);
  const asOf = runs.map((r) => r.dataAsOf).filter((d): d is string => d !== null).sort()[0];
  return { range: first?.range ?? null, nodes: values, dataAsOf: asOf ?? new Date().toISOString() };
}
