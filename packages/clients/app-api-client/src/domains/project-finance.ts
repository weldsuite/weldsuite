/**
 * App-API WeldFlow client for project cost, forecast and earned value
 * (`/api/project-finance`, served by flow-api; design: weldflow-delivery-and-portfolio.md
 * "Finance and earned value", ADR FLOW-019).
 *
 * Amounts are decimal strings in the project's `budget_currency`; a caller
 * without finance rights gets null amounts and the percentages only.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CostLine,
  CostSource,
  FinanceSettings,
  FinanceSnapshot,
  ManualForecastBody,
  ProjectFinance,
} from '../schemas/project-finance';

export type {
  CostLine,
  CostSource,
  FinanceFigures,
  FinancePercentages,
  FinanceRow,
  FinanceSettings,
  FinanceSnapshot,
  ForecastSource,
  ManualForecast,
  ManualForecastBody,
  ProjectFinance,
} from '../schemas/project-finance';

export interface ListCostsQuery {
  source?: CostSource;
  /** `YYYY-MM-DD`, inclusive. */
  from?: string;
  to?: string;
  cursor?: string;
  /** 1 to 100, 25 by default. */
  limit?: number;
}

const base = '/project-finance';

export function createProjectFinanceApi(api: ClientApi) {
  return {
    /** Budget, actual, committed, PV, EV, CPI, SPI, forecast and the per-deliverable rows. */
    getFinance(projectId: string): Promise<DataResponse<ProjectFinance>> {
      return api.get(`${base}/${projectId}`);
    },

    /** The cost lines by source, newest first. Needs finance rights (403 otherwise). */
    listCosts(projectId: string, params: ListCostsQuery = {}): Promise<ListResponse<CostLine>> {
      return api.get(`${base}/${projectId}/costs${buildQueryString({ ...params })}`);
    },

    /** The weekly points of the S-curve, oldest first. */
    listSnapshots(projectId: string): Promise<ListResponse<FinanceSnapshot>> {
      return api.get(`${base}/${projectId}/snapshots`);
    },

    getSettings(projectId: string): Promise<DataResponse<FinanceSettings>> {
      return api.get(`${base}/settings/${projectId}`);
    },

    /** Set the manual forecast with its reason, or clear it with `forecast: null`. */
    saveForecast(projectId: string, input: ManualForecastBody): Promise<DataResponse<FinanceSettings>> {
      return api.put(`${base}/settings/${projectId}`, input);
    },
  };
}
