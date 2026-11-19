/**
 * App-API WeldStash replenishment domain client: `/api/replenishment/*`.
 * Served by the Rust backend only (the Kubernetes editions); Global answers 404.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CompleteImportResult,
  CreatePurchaseOrdersFromPlansInput,
  CreatePurchaseOrdersFromPlansResult,
  DismissPlanInput,
  ImportRowsInput,
  ImportRowsResult,
  IncomingStock,
  ListIncomingQuery,
  ListPlansQuery,
  ListRulesQuery,
  PlanDemand,
  PlanDetail,
  PlanningRun,
  ReorderRule,
  ReplenishmentPlan,
  ReplenishmentSettings,
  SalesHistoryImport,
  UpdateReplenishmentSettingsInput,
  UpsertReorderRuleInput,
} from '../schemas/replenishment';

const qs = (params: object) => buildQueryString(params as Record<string, unknown>);

export function createReplenishmentApi(api: ClientApi) {
  const base = '/replenishment';
  return {
    getSettings(): Promise<DataResponse<ReplenishmentSettings>> {
      return api.get<DataResponse<ReplenishmentSettings>>(`${base}/settings`);
    },
    updateSettings(data: UpdateReplenishmentSettingsInput): Promise<DataResponse<ReplenishmentSettings>> {
      return api.patch<DataResponse<ReplenishmentSettings>>(`${base}/settings`, data);
    },

    listPlans(params: ListPlansQuery = {}): Promise<ListResponse<ReplenishmentPlan>> {
      return api.get<ListResponse<ReplenishmentPlan>>(`${base}/plans${qs(params)}`);
    },
    getPlan(id: string): Promise<DataResponse<PlanDetail>> {
      return api.get<DataResponse<PlanDetail>>(`${base}/plans/${id}`);
    },
    getPlanDemand(id: string): Promise<DataResponse<PlanDemand>> {
      return api.get<DataResponse<PlanDemand>>(`${base}/plans/${id}/demand`);
    },
    dismissPlan(id: string, data: DismissPlanInput = {}): Promise<DataResponse<ReplenishmentPlan>> {
      return api.post<DataResponse<ReplenishmentPlan>>(`${base}/plans/${id}/dismiss`, data);
    },
    restorePlan(id: string): Promise<DataResponse<ReplenishmentPlan>> {
      return api.post<DataResponse<ReplenishmentPlan>>(`${base}/plans/${id}/restore`, {});
    },

    listRules(params: ListRulesQuery = {}): Promise<ListResponse<ReorderRule>> {
      return api.get<ListResponse<ReorderRule>>(`${base}/rules${qs(params)}`);
    },
    upsertRule(data: UpsertReorderRuleInput): Promise<DataResponse<ReorderRule>> {
      return api.put<DataResponse<ReorderRule>>(`${base}/rules`, data);
    },
    deleteRule(id: string): Promise<void> {
      return api.delete<void>(`${base}/rules/${id}`);
    },

    listRuns(params: { limit?: number } = {}): Promise<ListResponse<PlanningRun>> {
      return api.get<ListResponse<PlanningRun>>(`${base}/runs${qs(params)}`);
    },
    startRun(): Promise<DataResponse<PlanningRun>> {
      return api.post<DataResponse<PlanningRun>>(`${base}/runs`, {});
    },

    createPurchaseOrders(
      data: CreatePurchaseOrdersFromPlansInput,
    ): Promise<DataResponse<CreatePurchaseOrdersFromPlansResult>> {
      return api.post<DataResponse<CreatePurchaseOrdersFromPlansResult>>(`${base}/purchase-orders`, data);
    },

    listIncoming(params: ListIncomingQuery = {}): Promise<DataResponse<IncomingStock[]>> {
      return api.get<DataResponse<IncomingStock[]>>(`${base}/incoming${qs(params)}`);
    },

    listImports(): Promise<ListResponse<SalesHistoryImport>> {
      return api.get<ListResponse<SalesHistoryImport>>(`${base}/imports`);
    },
    createImport(data: { fileName: string }): Promise<DataResponse<SalesHistoryImport>> {
      return api.post<DataResponse<SalesHistoryImport>>(`${base}/imports`, data);
    },
    addImportRows(id: string, data: ImportRowsInput): Promise<DataResponse<ImportRowsResult>> {
      return api.post<DataResponse<ImportRowsResult>>(`${base}/imports/${id}/rows`, data);
    },
    completeImport(id: string): Promise<DataResponse<CompleteImportResult>> {
      return api.post<DataResponse<CompleteImportResult>>(`${base}/imports/${id}/complete`, {});
    },
    deleteImport(id: string): Promise<void> {
      return api.delete<void>(`${base}/imports/${id}`);
    },
  };
}
