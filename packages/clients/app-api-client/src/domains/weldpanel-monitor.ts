/**
 * App-API WeldPanel monitoring and data-out client — alerts, scheduled reports
 * (subscriptions), raw exports and custom collector domains (panel-api).
 * Shapes: `schemas/weldpanel-monitor.ts`.
 *
 * Permissions: alerts and subscriptions read with `panel_reports:read` and
 * change with `panel_reports:create|update|delete` (owner, or
 * `panel_projects:manage`); exports and domains need `panel_projects:manage`.
 */

import { buildQueryString } from '../types';
import type { ClientApi, DataResponse, ListResponse } from '../types';
import type {
  CreatePanelAlertInput,
  CreatePanelDomainInput,
  CreatePanelExportInput,
  CreatePanelSubscriptionInput,
  PanelAlertDto,
  PanelAlertEventDto,
  PanelAlertListParams,
  PanelDeliveryReportDto,
  PanelDomainDto,
  PanelExportDto,
  PanelExportRunDto,
  PanelExportTestDto,
  PanelSubscriptionDto,
  PanelSubscriptionListParams,
  SnoozePanelAlertInput,
  TestPanelExportInput,
  UpdatePanelAlertInput,
  UpdatePanelExportInput,
  UpdatePanelSubscriptionInput,
} from '../schemas/weldpanel-monitor';

const panel = '/panel';

export function createWeldPanelMonitorApi(api: ClientApi) {
  return {
    alerts: {
      list(params: PanelAlertListParams = {}): Promise<ListResponse<PanelAlertDto>> {
        return api.get(`${panel}/alerts${buildQueryString({ ...params })}`);
      },
      get(id: string): Promise<DataResponse<PanelAlertDto>> {
        return api.get(`${panel}/alerts/${id}`);
      },
      create(input: CreatePanelAlertInput): Promise<DataResponse<PanelAlertDto>> {
        return api.post(`${panel}/alerts`, input);
      },
      update(id: string, input: UpdatePanelAlertInput): Promise<DataResponse<PanelAlertDto>> {
        return api.patch(`${panel}/alerts/${id}`, input);
      },
      remove(id: string): Promise<void> {
        return api.delete(`${panel}/alerts/${id}`);
      },
      /** The alert's history: fired, resolved and failed checks, newest first. */
      events(id: string, params: { cursor?: string; limit?: number } = {}): Promise<ListResponse<PanelAlertEventDto>> {
        return api.get(`${panel}/alerts/${id}/events${buildQueryString({ ...params })}`);
      },
      /** Sends a test message on every channel of the alert. */
      test(id: string): Promise<DataResponse<PanelDeliveryReportDto>> {
        return api.post(`${panel}/alerts/${id}/test`, {});
      },
      /** Stops messages until `until` (null: now). Checks go on. */
      snooze(id: string, input: SnoozePanelAlertInput): Promise<DataResponse<PanelAlertDto>> {
        return api.post(`${panel}/alerts/${id}/snooze`, input);
      },
    },

    subscriptions: {
      list(params: PanelSubscriptionListParams = {}): Promise<ListResponse<PanelSubscriptionDto>> {
        return api.get(`${panel}/subscriptions${buildQueryString({ ...params })}`);
      },
      get(id: string): Promise<DataResponse<PanelSubscriptionDto>> {
        return api.get(`${panel}/subscriptions/${id}`);
      },
      create(input: CreatePanelSubscriptionInput): Promise<DataResponse<PanelSubscriptionDto>> {
        return api.post(`${panel}/subscriptions`, input);
      },
      update(id: string, input: UpdatePanelSubscriptionInput): Promise<DataResponse<PanelSubscriptionDto>> {
        return api.patch(`${panel}/subscriptions/${id}`, input);
      },
      remove(id: string): Promise<void> {
        return api.delete(`${panel}/subscriptions/${id}`);
      },
      /** Delivers the report now, outside its schedule. */
      sendNow(id: string): Promise<DataResponse<PanelDeliveryReportDto>> {
        return api.post(`${panel}/subscriptions/${id}/send-now`, {});
      },
    },

    exports: {
      list(projectId: string): Promise<ListResponse<PanelExportDto>> {
        return api.get(`${panel}/exports${buildQueryString({ projectId })}`);
      },
      get(id: string): Promise<DataResponse<PanelExportDto>> {
        return api.get(`${panel}/exports/${id}`);
      },
      create(input: CreatePanelExportInput): Promise<DataResponse<PanelExportDto>> {
        return api.post(`${panel}/exports`, input);
      },
      update(id: string, input: UpdatePanelExportInput): Promise<DataResponse<PanelExportDto>> {
        return api.patch(`${panel}/exports/${id}`, input);
      },
      remove(id: string): Promise<void> {
        return api.delete(`${panel}/exports/${id}`);
      },
      /** One run per table and window, newest first. */
      runs(id: string, params: { cursor?: string; limit?: number } = {}): Promise<ListResponse<PanelExportRunDto>> {
        return api.get(`${panel}/exports/${id}/runs${buildQueryString({ ...params })}`);
      },
      pause(id: string): Promise<DataResponse<PanelExportDto>> {
        return api.post(`${panel}/exports/${id}/pause`, {});
      },
      resume(id: string): Promise<DataResponse<PanelExportDto>> {
        return api.post(`${panel}/exports/${id}/resume`, {});
      },
      /** Writes and deletes a test file at the destination. */
      test(input: TestPanelExportInput): Promise<DataResponse<PanelExportTestDto>> {
        return api.post(`${panel}/exports/test`, input);
      },
    },

    /** Custom collector host names (503 `FEATURE_UNAVAILABLE` where Cloudflare for SaaS is not set up). */
    domains: {
      list(projectId: string): Promise<ListResponse<PanelDomainDto>> {
        return api.get(`${panel}/projects/${projectId}/domains`);
      },
      create(projectId: string, input: CreatePanelDomainInput): Promise<DataResponse<PanelDomainDto>> {
        return api.post(`${panel}/projects/${projectId}/domains`, input);
      },
      /** Asks Cloudflare for the host name's status now (the cron also does, every 10 minutes). */
      refresh(projectId: string, domainId: string): Promise<DataResponse<PanelDomainDto>> {
        return api.post(`${panel}/projects/${projectId}/domains/${domainId}/refresh`, {});
      },
      remove(projectId: string, domainId: string): Promise<void> {
        return api.delete(`${panel}/projects/${projectId}/domains/${domainId}`);
      },
    },
  };
}

export type WeldPanelMonitorApi = ReturnType<typeof createWeldPanelMonitorApi>;
