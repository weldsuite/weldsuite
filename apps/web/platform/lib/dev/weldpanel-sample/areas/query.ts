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
import { UNHANDLED, type SampleAreaHandler } from '../request';
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

function answer(spec: PanelQuerySpec): PanelQueryResponse {
  const meta = { dataAsOf: new Date().toISOString(), cached: false };
  switch (spec.kind) {
    case 'web':
      return { kind: 'web', result: webResult(spec), ...meta };
    case 'trends':
      return { kind: 'trends', result: trendsResult(spec), ...meta };
    case 'funnel':
      return { kind: 'funnel', result: funnelResult(spec), ...meta };
    case 'funnel_correlation':
      return { kind: 'funnel_correlation', result: funnelCorrelationResult(spec), ...meta };
    case 'retention':
      return { kind: 'retention', result: retentionResult(spec), ...meta };
    case 'flows':
      return { kind: 'flows', result: flowsResult(spec), ...meta };
    case 'stickiness':
      return { kind: 'stickiness', result: stickinessResult(spec), ...meta };
    case 'lifecycle':
      return { kind: 'lifecycle', result: lifecycleResult(spec), ...meta };
    case 'vitals':
      return { kind: 'vitals', result: vitalsResult(spec), ...meta };
    case 'impact':
      return { kind: 'impact', result: impactResult(spec), ...meta };
    case 'signal':
      return { kind: 'signal', result: signalResult(spec), ...meta };
    case 'sessions':
      return { kind: 'sessions', result: sessionsResult(spec), ...meta };
    case 'heatmap':
      return { kind: 'heatmap', result: heatmapResult(spec), ...meta };
  }
}

export const handleQuery: SampleAreaHandler = (request) => {
  const [first, second, third] = request.segments;
  if (request.method !== 'POST') return UNHANDLED;

  if (first === 'query' && request.segments.length === 1) {
    return isQuerySpec(request.body) ? data(answer(request.body)) : UNHANDLED;
  }
  if (first === 'insights' && second === 'explain' && request.segments.length === 2) {
    return isExplainInput(request.body) ? data(explainResult(request.body)) : UNHANDLED;
  }
  if (first === 'metric-tree-values') {
    if (request.segments.length === 1) return isMetricTreePreview(request.body) ? data(metricTreePreview(request.body)) : UNHANDLED;
    if (request.segments.length === 2 && second && third === undefined) {
      return isSavedValuesInput(request.body) ? data(metricTreeSaved(second, request.body ?? {})) : UNHANDLED;
    }
  }
  return UNHANDLED;
};
