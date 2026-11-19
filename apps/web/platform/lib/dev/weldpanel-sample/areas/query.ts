/**
 * Sample answers for `POST /panel/query` (every query kind) and the analysis
 * endpoints (`/panel/insights/explain`, `/panel/metric-tree-values[/:id]`).
 */

import type {
  PanelQueryResponse,
  PanelQuerySpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { PANEL_QUERY_KINDS } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type {
  ExplainPanelChangeInput,
  PanelMetricTreeValuesInput,
  PanelSavedMetricTreeValuesInput,
} from '@weldsuite/app-api-client/schemas/weldpanel-analysis';
import { data } from '../dataset';
import { UNHANDLED, type SampleAreaHandler, type SampleRequest } from '../request';
import { explainResult, impactResult, metricTreePreview, metricTreeSaved, signalResult } from './query-insights';
import { flowsResult, funnelCorrelationResult, funnelResult, lifecycleResult, retentionResult, stickinessResult } from './query-journeys';
import { trendsResult } from './query-trends';
import { heatmapResult, sessionsResult, vitalsResult, webResult } from './query-web';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isQuerySpec(body: unknown): body is PanelQuerySpec {
  return isRecord(body) && typeof body.kind === 'string' && (PANEL_QUERY_KINDS as readonly string[]).includes(body.kind) && typeof body.projectId === 'string';
}

function isExplainInput(body: unknown): body is ExplainPanelChangeInput {
  return isRecord(body) && typeof body.projectId === 'string' && isRecord(body.spec) && Array.isArray(body.spec.series);
}

function isMetricTreePreview(body: unknown): body is PanelMetricTreeValuesInput {
  return isRecord(body) && typeof body.projectId === 'string' && Array.isArray(body.nodes);
}

function isSavedValuesInput(body: unknown): body is PanelSavedMetricTreeValuesInput {
  return body === undefined || body === null || isRecord(body);
}

/** What each kind of query is answered with, as the part of the response that is the result. */
const RESULT_OF: { [K in PanelQuerySpec['kind']]: (spec: Extract<PanelQuerySpec, { kind: K }>) => unknown } = {
  web: webResult,
  trends: trendsResult,
  funnel: funnelResult,
  funnel_correlation: funnelCorrelationResult,
  retention: retentionResult,
  flows: flowsResult,
  stickiness: stickinessResult,
  lifecycle: lifecycleResult,
  vitals: vitalsResult,
  impact: impactResult,
  signal: signalResult,
  sessions: sessionsResult,
  heatmap: heatmapResult,
};

function answer(spec: PanelQuerySpec): PanelQueryResponse {
  const meta = { dataAsOf: new Date().toISOString(), cached: false };
  const result = (RESULT_OF[spec.kind] as (spec: PanelQuerySpec) => unknown)(spec);
  return { kind: spec.kind, result, ...meta } as PanelQueryResponse;
}

/** `POST /panel/metric-tree-values` (a tree not saved yet) and `POST /panel/metric-tree-values/:id`. */
function handleMetricTreeValues({ segments, body }: SampleRequest): unknown {
  if (segments.length === 1) return isMetricTreePreview(body) ? data(metricTreePreview(body)) : UNHANDLED;
  const id = segments[1];
  if (segments.length !== 2 || !id) return UNHANDLED;
  return isSavedValuesInput(body) ? data(metricTreeSaved(id, body ?? {})) : UNHANDLED;
}

export const handleQuery: SampleAreaHandler = (request) => {
  const { method, segments, body } = request;
  if (method !== 'POST') return UNHANDLED;
  const [first, second] = segments;
  if (first === 'query' && segments.length === 1) return isQuerySpec(body) ? data(answer(body)) : UNHANDLED;
  if (first === 'insights' && second === 'explain' && segments.length === 2) return isExplainInput(body) ? data(explainResult(body)) : UNHANDLED;
  return first === 'metric-tree-values' ? handleMetricTreeValues(request) : UNHANDLED;
};
