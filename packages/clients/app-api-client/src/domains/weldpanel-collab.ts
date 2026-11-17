/**
 * App-API WeldPanel definitions, collaboration and sharing client
 * (panel-api): custom events, computed properties, path rules, annotations,
 * comments, report versions, metric trees and share links. Dashboard filters,
 * text tiles and templates are on `createWeldPanelApi(...).dashboards`.
 * Shapes: `schemas/weldpanel-collab.ts`.
 *
 * Also the public share client ({@link createWeldPanelPublicShareApi}): no
 * session, the token in the URL is the only credential, for the
 * `/share/panel/<token>` page.
 */

import { buildQueryString } from '../types';
import type { ClientApi, DataResponse, ListResponse } from '../types';
import type {
  CreatePanelAnnotationInput,
  CreatePanelCommentInput,
  CreatePanelComputedPropertyInput,
  CreatePanelCustomEventInput,
  CreatePanelMetricTreeInput,
  CreatePanelShareLinkInput,
  PanelAnnotationDto,
  PanelAnnotationListParams,
  PanelCommentDto,
  PanelComputedPropertyDto,
  PanelCreatedShareLinkDto,
  PanelCustomEventDto,
  PanelMetricTreeDto,
  PanelMetricTreeListParams,
  PanelPathRuleDto,
  PanelPathRuleTestResult,
  PanelPublicResultsInput,
  PanelPublicShareDto,
  PanelReportVersionDetailDto,
  PanelReportVersionDto,
  PanelShareLinkDto,
  PanelTargetParams,
  SetPanelPathRulesInput,
  TestPanelPathRulesInput,
  UpdatePanelAnnotationInput,
  UpdatePanelCommentInput,
  UpdatePanelComputedPropertyInput,
  UpdatePanelCustomEventInput,
  UpdatePanelMetricTreeInput,
} from '../schemas/weldpanel-collab';
import { withoutTrailingSlash } from '../schemas/weldpanel-collab';
import type { PanelReportDto } from '../schemas/weldpanel-objects';
import type { PanelQueryResponse } from '../schemas/weldpanel-query';

const panel = '/panel';

export function createWeldPanelCollabApi(api: ClientApi) {
  return {
    /** Several events under one name; use `ref` (`@pnce_…`) wherever a spec takes an event. */
    customEvents: {
      list(projectId: string): Promise<ListResponse<PanelCustomEventDto>> {
        return api.get(`${panel}/custom-events${buildQueryString({ projectId })}`);
      },
      get(id: string): Promise<DataResponse<PanelCustomEventDto>> {
        return api.get(`${panel}/custom-events/${id}`);
      },
      /** 409 when the name is taken in the project. */
      create(input: CreatePanelCustomEventInput): Promise<DataResponse<PanelCustomEventDto>> {
        return api.post(`${panel}/custom-events`, input);
      },
      update(id: string, input: UpdatePanelCustomEventInput): Promise<DataResponse<PanelCustomEventDto>> {
        return api.patch(`${panel}/custom-events/${id}`, input);
      },
      remove(id: string): Promise<void> {
        return api.delete(`${panel}/custom-events/${id}`);
      },
    },

    /** Values derived from event properties; use `ref` (`@pncp_…`) wherever a spec takes an event property. */
    computedProperties: {
      list(projectId: string): Promise<ListResponse<PanelComputedPropertyDto>> {
        return api.get(`${panel}/computed-properties${buildQueryString({ projectId })}`);
      },
      get(id: string): Promise<DataResponse<PanelComputedPropertyDto>> {
        return api.get(`${panel}/computed-properties/${id}`);
      },
      /** 400 (with `details.position`) for a formula that does not parse; 409 when the name is taken. */
      create(input: CreatePanelComputedPropertyInput): Promise<DataResponse<PanelComputedPropertyDto>> {
        return api.post(`${panel}/computed-properties`, input);
      },
      update(id: string, input: UpdatePanelComputedPropertyInput): Promise<DataResponse<PanelComputedPropertyDto>> {
        return api.patch(`${panel}/computed-properties/${id}`, input);
      },
      remove(id: string): Promise<void> {
        return api.delete(`${panel}/computed-properties/${id}`);
      },
    },

    /** Path cleaning rules, in order. */
    pathRules: {
      list(projectId: string): Promise<ListResponse<PanelPathRuleDto>> {
        return api.get(`${panel}/path-rules${buildQueryString({ projectId })}`);
      },
      /** Replaces the project's whole list; answers the new list. */
      replace(projectId: string, input: SetPanelPathRulesInput): Promise<ListResponse<PanelPathRuleDto>> {
        return api.put(`${panel}/path-rules${buildQueryString({ projectId })}`, input);
      },
      /** Applies rules (or the project's saved ones) to sample paths. */
      test(input: TestPanelPathRulesInput): Promise<DataResponse<{ results: PanelPathRuleTestResult[] }>> {
        return api.post(`${panel}/path-rules/test`, input);
      },
    },

    annotations: {
      /** Project-wide annotations in the range, plus `reportId`'s own when given. */
      list(params: PanelAnnotationListParams): Promise<ListResponse<PanelAnnotationDto>> {
        return api.get(`${panel}/annotations${buildQueryString({ ...params })}`);
      },
      get(id: string): Promise<DataResponse<PanelAnnotationDto>> {
        return api.get(`${panel}/annotations/${id}`);
      },
      create(input: CreatePanelAnnotationInput): Promise<DataResponse<PanelAnnotationDto>> {
        return api.post(`${panel}/annotations`, input);
      },
      update(id: string, input: UpdatePanelAnnotationInput): Promise<DataResponse<PanelAnnotationDto>> {
        return api.patch(`${panel}/annotations/${id}`, input);
      },
      remove(id: string): Promise<void> {
        return api.delete(`${panel}/annotations/${id}`);
      },
    },

    comments: {
      list(params: PanelTargetParams): Promise<ListResponse<PanelCommentDto>> {
        return api.get(`${panel}/comments${buildQueryString({ ...params })}`);
      },
      /** The target's owner gets an in-app notification (unless they wrote it). */
      create(input: CreatePanelCommentInput): Promise<DataResponse<PanelCommentDto>> {
        return api.post(`${panel}/comments`, input);
      },
      update(id: string, input: UpdatePanelCommentInput): Promise<DataResponse<PanelCommentDto>> {
        return api.patch(`${panel}/comments/${id}`, input);
      },
      remove(id: string): Promise<void> {
        return api.delete(`${panel}/comments/${id}`);
      },
    },

    /** A report's earlier versions (kept on every change to its name, description or spec). */
    reportVersions: {
      list(reportId: string): Promise<ListResponse<PanelReportVersionDto>> {
        return api.get(`${panel}/reports/${reportId}/versions`);
      },
      get(reportId: string, version: number): Promise<DataResponse<PanelReportVersionDetailDto>> {
        return api.get(`${panel}/reports/${reportId}/versions/${version}`);
      },
      /** Puts the version back (the current state becomes a version); answers the report. 409 when the spec no longer parses. */
      restore(reportId: string, version: number): Promise<DataResponse<PanelReportDto>> {
        return api.post(`${panel}/reports/${reportId}/versions/${version}/restore`, {});
      },
    },

    /** Metric trees; their values come from the analysis client (`/metric-tree-values`). */
    metricTrees: {
      list(params: PanelMetricTreeListParams): Promise<ListResponse<PanelMetricTreeDto>> {
        return api.get(`${panel}/metric-trees${buildQueryString({ ...params })}`);
      },
      get(id: string): Promise<DataResponse<PanelMetricTreeDto>> {
        return api.get(`${panel}/metric-trees/${id}`);
      },
      create(input: CreatePanelMetricTreeInput): Promise<DataResponse<PanelMetricTreeDto>> {
        return api.post(`${panel}/metric-trees`, input);
      },
      update(id: string, input: UpdatePanelMetricTreeInput): Promise<DataResponse<PanelMetricTreeDto>> {
        return api.patch(`${panel}/metric-trees/${id}`, input);
      },
      remove(id: string): Promise<void> {
        return api.delete(`${panel}/metric-trees/${id}`);
      },
    },

    /** Public links to a report or dashboard. */
    shareLinks: {
      list(params: PanelTargetParams): Promise<ListResponse<PanelShareLinkDto>> {
        return api.get(`${panel}/share-links${buildQueryString({ ...params })}`);
      },
      /** The response carries the token and URL, once. 422 `NOT_SHAREABLE` for people data. */
      create(input: CreatePanelShareLinkInput): Promise<DataResponse<PanelCreatedShareLinkDto>> {
        return api.post(`${panel}/share-links`, input);
      },
      revoke(id: string): Promise<void> {
        return api.delete(`${panel}/share-links/${id}`);
      },
    },
  };
}

export type WeldPanelCollabApi = ReturnType<typeof createWeldPanelCollabApi>;

// ---------------------------------------------------------------------------
// Public share client (no session)
// ---------------------------------------------------------------------------

/** A failed public share call. A 404 covers unknown, revoked and expired links alike. */
export class PanelPublicShareError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'PanelPublicShareError';
    this.status = status;
    this.code = code;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

export interface WeldPanelPublicShareOptions {
  /** Origin that serves `/public/panel` (panel-api, or app-api, which forwards it), without a trailing slash. */
  baseUrl: string;
  fetch?: typeof fetch;
}

/**
 * The share page's client: `get(token)` for what the link shows, `results`
 * for each report (or dashboard tile). Sends no credentials.
 */
export function createWeldPanelPublicShareApi(options: WeldPanelPublicShareOptions) {
  const base = withoutTrailingSlash(options.baseUrl);
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await doFetch(`${base}/public/panel${path}`, {
      method,
      credentials: 'omit',
      cache: 'no-store',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (json as { error?: { message?: unknown; code?: unknown } } | null)?.error;
      throw new PanelPublicShareError(
        typeof error?.message === 'string' ? error.message : `Request failed with status ${response.status}`,
        response.status,
        typeof error?.code === 'string' ? error.code : null,
      );
    }
    return (json as { data: T }).data;
  }

  return {
    get(token: string): Promise<PanelPublicShareDto> {
      return call('GET', `/share/${encodeURIComponent(token)}`);
    },
    /** One report's result: leave `tileId` out for a shared report; `dateRange` only when the link allows it. */
    results(token: string, input: PanelPublicResultsInput = {}): Promise<PanelQueryResponse> {
      return call('POST', `/share/${encodeURIComponent(token)}/results`, input);
    },
  };
}

export type WeldPanelPublicShareApi = ReturnType<typeof createWeldPanelPublicShareApi>;
