/**
 * App-API WeldFlow client for status reports (`/api/project-status-reports`)
 * and stakeholders (`/api/project-stakeholders`). Served by flow-api. Shapes
 * are the Zod schemas in `../schemas/project-reporting`.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CommunicationPlanResponse,
  CreateStakeholderInput,
  CreateStatusReportInput,
  PutCommunicationPlanInput,
  PutRaciInput,
  PutStatusReportSettingsInput,
  RaciMatrix,
  RaciSubject,
  Stakeholder,
  StatusReport,
  StatusReportSettingsResponse,
  StatusReportSummary,
  UpdateStakeholderInput,
  UpdateStatusReportInput,
} from '../schemas/project-reporting';

export type * from '../schemas/project-reporting';

const reportsBase = '/project-status-reports';
const stakeholdersBase = '/project-stakeholders';

export function createProjectReportingApi(api: ClientApi) {
  return {
    // Status reports -------------------------------------------------------
    listStatusReports(params: { projectId: string; status?: 'draft' | 'published'; cursor?: string; limit?: number }): Promise<ListResponse<StatusReportSummary>> {
      return api.get(`${reportsBase}${buildQueryString({ ...params })}`);
    },
    getStatusReport(id: string): Promise<DataResponse<StatusReport>> {
      return api.get(`${reportsBase}/${id}`);
    },
    createStatusReport(input: CreateStatusReportInput): Promise<DataResponse<StatusReport>> {
      return api.post(reportsBase, input);
    },
    updateStatusReport(id: string, input: UpdateStatusReportInput): Promise<DataResponse<StatusReport>> {
      return api.patch(`${reportsBase}/${id}`, input);
    },
    refreshStatusReport(id: string): Promise<DataResponse<StatusReport>> {
      return api.post(`${reportsBase}/${id}/refresh`, {});
    },
    publishStatusReport(id: string): Promise<DataResponse<StatusReport>> {
      return api.post(`${reportsBase}/${id}/publish`, {});
    },
    deleteStatusReport(id: string): Promise<void> {
      return api.delete(`${reportsBase}/${id}`);
    },
    getStatusReportSettings(projectId: string): Promise<DataResponse<StatusReportSettingsResponse>> {
      return api.get(`${reportsBase}/settings/${projectId}`);
    },
    putStatusReportSettings(projectId: string, input: PutStatusReportSettingsInput): Promise<DataResponse<StatusReportSettingsResponse>> {
      return api.put(`${reportsBase}/settings/${projectId}`, input);
    },

    // Stakeholders ---------------------------------------------------------
    listStakeholders(params: { projectId: string; cursor?: string; limit?: number }): Promise<ListResponse<Stakeholder>> {
      return api.get(`${stakeholdersBase}${buildQueryString({ ...params })}`);
    },
    createStakeholder(input: CreateStakeholderInput): Promise<DataResponse<Stakeholder>> {
      return api.post(stakeholdersBase, input);
    },
    updateStakeholder(id: string, input: UpdateStakeholderInput): Promise<DataResponse<Stakeholder>> {
      return api.patch(`${stakeholdersBase}/${id}`, input);
    },
    deleteStakeholder(id: string): Promise<void> {
      return api.delete(`${stakeholdersBase}/${id}`);
    },
    inviteToPortal(id: string): Promise<DataResponse<Stakeholder>> {
      return api.post(`${stakeholdersBase}/${id}/portal-invite`, {});
    },
    revokePortalAccess(id: string): Promise<DataResponse<Stakeholder>> {
      return api.delete(`${stakeholdersBase}/${id}/portal-access`);
    },
    getRaci(projectId: string): Promise<DataResponse<RaciMatrix>> {
      return api.get(`${stakeholdersBase}/raci/${projectId}`);
    },
    putRaci(projectId: string, input: PutRaciInput): Promise<DataResponse<RaciSubject>> {
      return api.put(`${stakeholdersBase}/raci/${projectId}`, input);
    },
    getCommunicationPlan(projectId: string): Promise<DataResponse<CommunicationPlanResponse>> {
      return api.get(`${stakeholdersBase}/settings/${projectId}`);
    },
    putCommunicationPlan(projectId: string, input: PutCommunicationPlanInput): Promise<DataResponse<CommunicationPlanResponse>> {
      return api.put(`${stakeholdersBase}/settings/${projectId}`, input);
    },
  };
}
