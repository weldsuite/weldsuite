/**
 * App-API WeldPanel analysis client (panel-api): root cause of a change and
 * metric tree values. Queries themselves stay on `domains/weldpanel.ts`
 * (`query`). Shapes: `schemas/weldpanel-analysis.ts`.
 */

import type { ClientApi, DataResponse } from '../types';
import type {
  ExplainPanelChangeInput,
  PanelExplainResult,
  PanelMetricTreeValues,
  PanelMetricTreeValuesInput,
  PanelSavedMetricTreeValuesInput,
} from '../schemas/weldpanel-analysis';

const panel = '/panel';

export function createWeldPanelAnalysisApi(api: ClientApi) {
  return {
    insights: {
      /** Which countries, devices, sources, pages (and asked properties) explain the change of one series. */
      explain(input: ExplainPanelChangeInput): Promise<DataResponse<PanelExplainResult>> {
        return api.post(`${panel}/insights/explain`, input);
      },
    },
    metricTreeValues: {
      /** Values of nodes that are not saved yet (the editor's preview). */
      preview(input: PanelMetricTreeValuesInput): Promise<DataResponse<PanelMetricTreeValues>> {
        return api.post(`${panel}/metric-tree-values`, input);
      },
      /** Values of a saved metric tree. */
      get(id: string, input: PanelSavedMetricTreeValuesInput = {}): Promise<DataResponse<PanelMetricTreeValues>> {
        return api.post(`${panel}/metric-tree-values/${encodeURIComponent(id)}`, input);
      },
    },
  };
}

export type WeldPanelAnalysisApi = ReturnType<typeof createWeldPanelAnalysisApi>;
