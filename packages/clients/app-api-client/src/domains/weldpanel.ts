/**
 * App-API WeldPanel domain client — `/api/panel/*` (panel-api).
 *
 * Phase 1: projects (create, list, rename, domains, settings, pause, delete),
 * token rotation, the install check and secret keys.
 * Phases 2-7: the query endpoint, saved reports / dashboards / cohorts, the
 * lexicon, people, recordings (the list is the `sessions` query kind), AI
 * summaries, heatmaps, live visitors and usage. Route list and shapes:
 * `schemas/weldpanel-objects.ts` and `schemas/weldpanel-query.ts`.
 */

import { buildQueryString } from '../types';
import type { ClientApi, DataResponse, ListResponse } from '../types';
import type {
  CreatePanelProjectInput,
  PanelInstallInfo,
  PanelProjectDto,
  UpdatePanelProjectInput,
  UpdatePanelProjectSettingsInput,
} from '../schemas/weldpanel';
import type {
  AddPanelDashboardTileInput,
  CreatePanelCohortInput,
  CreatePanelDashboardInput,
  CreatePanelHeatmapPageInput,
  CreatePanelKeyInput,
  CreatePanelReportInput,
  FavoritePanelSessionInput,
  GeneratePanelSessionSummaryInput,
  PanelCohortDto,
  PanelCreatedKeyDto,
  PanelDashboardDetailDto,
  PanelDashboardDto,
  PanelDashboardListParams,
  PanelDashboardTileDto,
  PanelErasureResult,
  PanelFavoriteDto,
  PanelHeatmapPageDto,
  PanelKeyDto,
  PanelLexiconDto,
  PanelLexiconEntry,
  PanelLiveDto,
  PanelPeopleByEmailDto,
  PanelPeopleListParams,
  PanelPersonDto,
  PanelPersonProfile,
  PanelReportDto,
  PanelReportListParams,
  PanelSessionDetail,
  PanelSessionSummaryDto,
  PanelSessionSummaryResponse,
  PanelSetSummaryResponse,
  PanelUsageDto,
  SetPanelDashboardLayoutInput,
  SummarisePanelSetInput,
  UpdatePanelCohortInput,
  UpdatePanelDashboardInput,
  UpdatePanelDashboardTileInput,
  UpdatePanelHeatmapPageInput,
  UpdatePanelLexiconInput,
  UpdatePanelReportInput,
} from '../schemas/weldpanel-objects';
import type {
  PanelDeviceClass,
  PanelHeatmapSpec,
  PanelQueryKind,
  PanelQueryResponse,
  PanelQueryResultOf,
  PanelQuerySpec,
  PanelSessionsSpec,
} from '../schemas/weldpanel-query';

const projects = '/panel/projects';
const panel = '/panel';

export function createWeldPanelApi(api: ClientApi) {
  return {
    projects: {
      list(): Promise<ListResponse<PanelProjectDto>> {
        return api.get(projects);
      },
      get(id: string): Promise<DataResponse<PanelProjectDto>> {
        return api.get(`${projects}/${id}`);
      },
      create(input: CreatePanelProjectInput): Promise<DataResponse<PanelProjectDto>> {
        return api.post(projects, input);
      },
      /** Name, kind and allowed domains. */
      update(id: string, input: UpdatePanelProjectInput): Promise<DataResponse<PanelProjectDto>> {
        return api.patch(`${projects}/${id}`, input);
      },
      /** Collector and privacy settings, and pausing collection. */
      updateSettings(id: string, input: UpdatePanelProjectSettingsInput): Promise<DataResponse<PanelProjectDto>> {
        return api.patch(`${projects}/${id}/settings`, input);
      },
      /** Soft-deletes the project; the collector stops accepting its token at once. */
      remove(id: string): Promise<void> {
        return api.delete(`${projects}/${id}`);
      },
      /** Issues a new token; the old one stops working at once. */
      rotateToken(id: string): Promise<DataResponse<PanelProjectDto>> {
        return api.post(`${projects}/${id}/rotate-token`, {});
      },
      install(id: string): Promise<DataResponse<PanelInstallInfo>> {
        return api.get(`${projects}/${id}/install`);
      },
    },

    /** Secret keys (`wps_…`) for server-side ingest and imports (`panel_projects:manage`). */
    keys: {
      list(projectId: string): Promise<ListResponse<PanelKeyDto>> {
        return api.get(`${projects}/${projectId}/keys`);
      },
      /** The response carries the whole key, once. */
      create(projectId: string, input: CreatePanelKeyInput): Promise<DataResponse<PanelCreatedKeyDto>> {
        return api.post(`${projects}/${projectId}/keys`, input);
      },
      revoke(projectId: string, keyId: string): Promise<void> {
        return api.delete(`${projects}/${projectId}/keys/${keyId}`);
      },
    },

    /** `POST /query`: run a typed spec (`panel_reports:read`; `sessions` also needs `panel_recordings:read`). */
    query: {
      run(spec: PanelQuerySpec): Promise<DataResponse<PanelQueryResponse>> {
        return api.post(`${panel}/query`, spec);
      },
    },

    reports: {
      list(params: PanelReportListParams): Promise<ListResponse<PanelReportDto>> {
        return api.get(`${panel}/reports${buildQueryString({ ...params })}`);
      },
      get(id: string): Promise<DataResponse<PanelReportDto>> {
        return api.get(`${panel}/reports/${id}`);
      },
      create(input: CreatePanelReportInput): Promise<DataResponse<PanelReportDto>> {
        return api.post(`${panel}/reports`, input);
      },
      update(id: string, input: UpdatePanelReportInput): Promise<DataResponse<PanelReportDto>> {
        return api.patch(`${panel}/reports/${id}`, input);
      },
      remove(id: string): Promise<void> {
        return api.delete(`${panel}/reports/${id}`);
      },
    },

    dashboards: {
      list(params: PanelDashboardListParams): Promise<ListResponse<PanelDashboardDto>> {
        return api.get(`${panel}/dashboards${buildQueryString({ ...params })}`);
      },
      get(id: string): Promise<DataResponse<PanelDashboardDetailDto>> {
        return api.get(`${panel}/dashboards/${id}`);
      },
      create(input: CreatePanelDashboardInput): Promise<DataResponse<PanelDashboardDto>> {
        return api.post(`${panel}/dashboards`, input);
      },
      update(id: string, input: UpdatePanelDashboardInput): Promise<DataResponse<PanelDashboardDto>> {
        return api.patch(`${panel}/dashboards/${id}`, input);
      },
      remove(id: string): Promise<void> {
        return api.delete(`${panel}/dashboards/${id}`);
      },
      addTile(id: string, input: AddPanelDashboardTileInput): Promise<DataResponse<PanelDashboardTileDto>> {
        return api.post(`${panel}/dashboards/${id}/tiles`, input);
      },
      updateTile(id: string, tileId: string, input: UpdatePanelDashboardTileInput): Promise<DataResponse<PanelDashboardTileDto>> {
        return api.patch(`${panel}/dashboards/${id}/tiles/${tileId}`, input);
      },
      removeTile(id: string, tileId: string): Promise<void> {
        return api.delete(`${panel}/dashboards/${id}/tiles/${tileId}`);
      },
      /** Moves and resizes every tile at once. */
      setLayout(id: string, input: SetPanelDashboardLayoutInput): Promise<DataResponse<PanelDashboardDetailDto>> {
        return api.put(`${panel}/dashboards/${id}/layout`, input);
      },
    },

    cohorts: {
      list(projectId: string): Promise<ListResponse<PanelCohortDto>> {
        return api.get(`${panel}/cohorts${buildQueryString({ projectId })}`);
      },
      get(id: string): Promise<DataResponse<PanelCohortDto>> {
        return api.get(`${panel}/cohorts/${id}`);
      },
      create(input: CreatePanelCohortInput): Promise<DataResponse<PanelCohortDto>> {
        return api.post(`${panel}/cohorts`, input);
      },
      update(id: string, input: UpdatePanelCohortInput): Promise<DataResponse<PanelCohortDto>> {
        return api.patch(`${panel}/cohorts/${id}`, input);
      },
      remove(id: string): Promise<void> {
        return api.delete(`${panel}/cohorts/${id}`);
      },
    },

    lexicon: {
      get(projectId: string): Promise<DataResponse<PanelLexiconDto>> {
        return api.get(`${panel}/lexicon${buildQueryString({ projectId })}`);
      },
      /** Describe, hide or verify an event or property name (creates the definition if needed). */
      update(input: UpdatePanelLexiconInput): Promise<DataResponse<PanelLexiconEntry>> {
        return api.patch(`${panel}/lexicon`, input);
      },
    },

    people: {
      list(params: PanelPeopleListParams): Promise<ListResponse<PanelPersonDto>> {
        return api.get(`${panel}/people${buildQueryString({ ...params })}`);
      },
      get(projectId: string, distinctId: string): Promise<DataResponse<PanelPersonProfile>> {
        return api.get(`${panel}/people/${encodeURIComponent(distinctId)}${buildQueryString({ projectId })}`);
      },
      /** For the WeldCRM person card: profiles in any project whose `$email` matches. */
      byEmail(email: string): Promise<DataResponse<PanelPeopleByEmailDto>> {
        return api.get(`${panel}/people/by-email${buildQueryString({ email })}`);
      },
      /** GDPR erasure (`panel_people:delete`): the profile, links and recordings go now, events within a week. */
      erase(projectId: string, distinctId: string): Promise<DataResponse<PanelErasureResult>> {
        return api.delete(`${panel}/people/${encodeURIComponent(distinctId)}${buildQueryString({ projectId })}`);
      },
    },

    sessions: {
      /** The recordings list: the `sessions` query kind. */
      list(spec: PanelSessionsSpec): Promise<DataResponse<PanelQueryResponse>> {
        return api.post(`${panel}/query`, spec);
      },
      get(projectId: string, sessionId: string): Promise<DataResponse<PanelSessionDetail>> {
        return api.get(`${panel}/sessions/${sessionId}${buildQueryString({ projectId })}`);
      },
      /**
       * One recording chunk as the raw response: the body is gzip of the rrweb
       * events JSON (`res.arrayBuffer()` then gunzip, or `res.body` through a
       * `DecompressionStream('gzip')`).
       */
      chunk(projectId: string, sessionId: string, seq: number): Promise<Response> {
        return api.getRaw(`${panel}/sessions/${sessionId}/chunks/${seq}${buildQueryString({ projectId })}`);
      },
      /** The chunk's compressed bytes. */
      async chunkBytes(projectId: string, sessionId: string, seq: number): Promise<ArrayBuffer> {
        const res = await api.getRaw(`${panel}/sessions/${sessionId}/chunks/${seq}${buildQueryString({ projectId })}`);
        return res.arrayBuffer();
      },
      favorite(sessionId: string, input: FavoritePanelSessionInput): Promise<DataResponse<PanelFavoriteDto>> {
        return api.put(`${panel}/sessions/${sessionId}/favorite`, input);
      },
      unfavorite(projectId: string, sessionId: string): Promise<void> {
        return api.delete(`${panel}/sessions/${sessionId}/favorite${buildQueryString({ projectId })}`);
      },
      /** The cached summary, or `data: null` when none exists. Never charges. */
      getSummary(projectId: string, sessionId: string): Promise<DataResponse<PanelSessionSummaryDto | null>> {
        return api.get(`${panel}/sessions/${sessionId}/summary${buildQueryString({ projectId })}`);
      },
      /** Generates (and charges for) a summary unless one is cached. 402 when the wallet is empty. */
      summarise(sessionId: string, input: GeneratePanelSessionSummaryInput): Promise<DataResponse<PanelSessionSummaryResponse>> {
        return api.post(`${panel}/sessions/${sessionId}/summary`, input);
      },
    },

    insights: {
      /** Themes across up to 20 sessions from a recordings filter or a funnel drop-off. 402 when the wallet is empty. */
      summarise(input: SummarisePanelSetInput): Promise<DataResponse<PanelSetSummaryResponse>> {
        return api.post(`${panel}/insights/summarise`, input);
      },
    },

    heatmaps: {
      listPages(projectId: string): Promise<ListResponse<PanelHeatmapPageDto>> {
        return api.get(`${panel}/heatmaps/pages${buildQueryString({ projectId })}`);
      },
      createPage(input: CreatePanelHeatmapPageInput): Promise<DataResponse<PanelHeatmapPageDto>> {
        return api.post(`${panel}/heatmaps/pages`, input);
      },
      updatePage(id: string, input: UpdatePanelHeatmapPageInput): Promise<DataResponse<PanelHeatmapPageDto>> {
        return api.patch(`${panel}/heatmaps/pages/${id}`, input);
      },
      removePage(id: string): Promise<void> {
        return api.delete(`${panel}/heatmaps/pages/${id}`);
      },
      /** Heatmap data: the `heatmap` query kind (page group or URL pattern, device class, type, range). */
      data(spec: PanelHeatmapSpec): Promise<DataResponse<PanelQueryResponse>> {
        return api.post(`${panel}/query`, spec);
      },
      /**
       * The masked rrweb full snapshot the heat layer is drawn on: gzip bytes
       * like a recording chunk. 404 when no recording covers the page group at
       * that device class yet.
       */
      snapshot(pageGroupId: string, deviceClass: PanelDeviceClass): Promise<Response> {
        return api.getRaw(`${panel}/heatmaps/pages/${pageGroupId}/snapshot${buildQueryString({ deviceClass })}`);
      },
    },

    live: {
      get(projectId: string): Promise<DataResponse<PanelLiveDto>> {
        return api.get(`${panel}/live${buildQueryString({ projectId })}`);
      },
    },

    usage: {
      /** This month, workspace-wide, against the plan. */
      get(): Promise<DataResponse<PanelUsageDto>> {
        return api.get(`${panel}/usage`);
      },
    },
  };
}

export type WeldPanelApi = ReturnType<typeof createWeldPanelApi>;

/** Narrows a query response to one kind (the per-kind hooks use this). */
export function expectPanelResult<K extends PanelQueryKind>(response: PanelQueryResponse, kind: K): PanelQueryResultOf<K> {
  if (response.kind !== kind) throw new Error(`Expected a ${kind} result, got ${response.kind}`);
  return response.result as PanelQueryResultOf<K>;
}
