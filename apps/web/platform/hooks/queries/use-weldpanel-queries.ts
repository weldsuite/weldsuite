/**
 * WeldPanel hooks: projects and the install check (phase 1), and the query,
 * saved-object, people, recording, AI, heatmap, live, usage and secret-key
 * hooks of phases 2-7. Every client method of `@weldsuite/app-api-client`'s
 * `weldpanel` domain has a hook here. Keys build on `weldpanelKeys.all`, the
 * root a realtime sync entry for a `panel_*` entity would invalidate.
 *
 * Reading the data:
 * - `useWeldPanelQuery(spec)` runs any spec; the per-kind hooks
 *   (`useWeldPanelWeb`, `...Trends`, `...Funnel`, `...Retention`, `...Flows`,
 *   `...Heatmap`) return the result already narrowed, with `dataAsOf` and
 *   `cached` next to it. The recordings list is `useWeldPanelRecordings`
 *   (paged, "load more").
 * - Query results are never persisted to storage: they are large, and the
 *   page shows how old the data is.
 *
 * Writing: mutations update the cache themselves (a saved object is put in its
 * detail entry and its lists refetch), so pages only call `mutate`.
 */

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { expectPanelResult } from '@weldsuite/app-api-client/domains/weldpanel';
import type {
  CreatePanelProjectInput,
  PanelProjectDto,
  UpdatePanelProjectInput,
  UpdatePanelProjectSettingsInput,
} from '@weldsuite/app-api-client/schemas/weldpanel';
import type {
  AddPanelDashboardTileInput,
  CreatePanelCohortInput,
  CreatePanelDashboardInput,
  CreatePanelHeatmapPageInput,
  CreatePanelKeyInput,
  CreatePanelReportInput,
  FavoritePanelSessionInput,
  GeneratePanelSessionSummaryInput,
  PanelDashboardListParams,
  PanelPeopleListParams,
  PanelReportListParams,
  SetPanelDashboardLayoutInput,
  SummarisePanelSetInput,
  UpdatePanelCohortInput,
  UpdatePanelDashboardInput,
  UpdatePanelDashboardTileInput,
  UpdatePanelHeatmapPageInput,
  UpdatePanelLexiconInput,
  UpdatePanelReportInput,
} from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type {
  PanelDeviceClass,
  PanelFlowsSpec,
  PanelFunnelSpec,
  PanelHeatmapSpec,
  PanelQueryKind,
  PanelQueryResponse,
  PanelQueryResultOf,
  PanelQuerySpec,
  PanelRetentionSpec,
  PanelSessionsSpec,
  PanelTrendsSpec,
  PanelWebSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';

export const weldpanelKeys = {
  all: ['weldpanel'] as const,
  projects: () => [...weldpanelKeys.all, 'projects'] as const,
  projectList: () => [...weldpanelKeys.projects(), 'list'] as const,
  project: (id: string) => [...weldpanelKeys.projects(), 'detail', id] as const,
  /** Nested under the project: invalidating the project refreshes the install check too. */
  install: (id: string) => [...weldpanelKeys.project(id), 'install'] as const,
  /** Secret keys, nested under the project. */
  secretKeys: (projectId: string) => [...weldpanelKeys.project(projectId), 'keys'] as const,

  /** Every query result. A spec is part of the key, so each distinct spec caches on its own. */
  queries: () => [...weldpanelKeys.all, 'query'] as const,
  query: (spec: PanelQuerySpec) => [...weldpanelKeys.queries(), spec.kind, spec] as const,
  queriesOfKind: (kind: PanelQueryKind) => [...weldpanelKeys.queries(), kind] as const,

  reports: () => [...weldpanelKeys.all, 'reports'] as const,
  reportList: (params: PanelReportListParams | undefined) => [...weldpanelKeys.reports(), 'list', params ?? {}] as const,
  report: (id: string) => [...weldpanelKeys.reports(), 'detail', id] as const,

  dashboards: () => [...weldpanelKeys.all, 'dashboards'] as const,
  dashboardList: (params: PanelDashboardListParams | undefined) => [...weldpanelKeys.dashboards(), 'list', params ?? {}] as const,
  dashboard: (id: string) => [...weldpanelKeys.dashboards(), 'detail', id] as const,

  cohorts: () => [...weldpanelKeys.all, 'cohorts'] as const,
  cohortList: (projectId: string | undefined) => [...weldpanelKeys.cohorts(), 'list', projectId ?? ''] as const,
  cohort: (id: string) => [...weldpanelKeys.cohorts(), 'detail', id] as const,

  lexicon: (projectId: string) => [...weldpanelKeys.all, 'lexicon', projectId] as const,

  people: () => [...weldpanelKeys.all, 'people'] as const,
  peopleList: (params: PanelPeopleListParams) => [...weldpanelKeys.people(), 'list', params] as const,
  person: (projectId: string, distinctId: string) => [...weldpanelKeys.people(), 'profile', projectId, distinctId] as const,
  peopleByEmail: (email: string) => [...weldpanelKeys.people(), 'by-email', email.toLowerCase()] as const,

  sessions: () => [...weldpanelKeys.all, 'sessions'] as const,
  session: (projectId: string, sessionId: string) => [...weldpanelKeys.sessions(), 'detail', projectId, sessionId] as const,
  sessionSummary: (projectId: string, sessionId: string) => [...weldpanelKeys.session(projectId, sessionId), 'summary'] as const,
  /** The recordings list, paged. */
  recordings: (spec: PanelSessionsSpec) => [...weldpanelKeys.sessions(), 'list', spec] as const,

  heatmapPages: (projectId: string) => [...weldpanelKeys.all, 'heatmap-pages', projectId] as const,
  live: (projectId: string) => [...weldpanelKeys.all, 'live', projectId] as const,
  usage: () => [...weldpanelKeys.all, 'usage'] as const,
};

/** How often the install check runs while no event has arrived yet. */
export const INSTALL_POLL_MS = 10_000;
/** How often the live view refreshes. */
export const LIVE_POLL_MS = 15_000;
/** Query results are fresh for a minute (the server caches two). */
export const QUERY_STALE_MS = 60_000;

// ---------------------------------------------------------------------------
// Projects (phase 1)
// ---------------------------------------------------------------------------

export function useWeldPanelProjects() {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.projectList(),
    queryFn: () => weldpanel.projects.list(),
    select: (res) => res.data,
  });
}

export function useWeldPanelProject(id: string) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.project(id),
    queryFn: () => weldpanel.projects.get(id),
    select: (res) => res.data,
    enabled: id !== '',
  });
}

/**
 * Whether events have arrived for a project, with the snippets to paste.
 * Re-checks every 10 seconds until the first event is in, then stops.
 */
export function useWeldPanelInstall(id: string, enabled = true) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.install(id),
    queryFn: () => weldpanel.projects.install(id),
    select: (res) => res.data,
    enabled: enabled && id !== '',
    refetchInterval: (query) => (query.state.data?.data.status === 'waiting' ? INSTALL_POLL_MS : false),
    // The status changes by the minute: a copy restored from storage would show a stale one.
    meta: { persist: false },
  });
}

/** Puts a changed project in the cache and refreshes the list it appears in. */
function useStoreProject() {
  const queryClient = useQueryClient();
  return (project: PanelProjectDto) => {
    queryClient.setQueryData(weldpanelKeys.project(project.id), { data: project });
    void queryClient.invalidateQueries({ queryKey: weldpanelKeys.projectList() });
  };
}

export function useCreateWeldPanelProject() {
  const { weldpanel } = useAppApi();
  const store = useStoreProject();
  return useMutation({
    mutationFn: (input: CreatePanelProjectInput) => weldpanel.projects.create(input).then((res) => res.data),
    onSuccess: store,
  });
}

/** Name, type and allowed domains (`panel_projects:update`). */
export function useUpdateWeldPanelProject(id: string) {
  const { weldpanel } = useAppApi();
  const store = useStoreProject();
  return useMutation({
    mutationFn: (input: UpdatePanelProjectInput) => weldpanel.projects.update(id, input).then((res) => res.data),
    onSuccess: store,
  });
}

/** Collector and privacy settings, and pausing or resuming (`panel_projects:manage`). */
export function useUpdateWeldPanelProjectSettings(id: string) {
  const { weldpanel } = useAppApi();
  const store = useStoreProject();
  return useMutation({
    mutationFn: (input: UpdatePanelProjectSettingsInput) => weldpanel.projects.updateSettings(id, input).then((res) => res.data),
    onSuccess: store,
  });
}

/** A new token: the old snippet stops working at once, so the install check and snippets are refetched. */
export function useRotateWeldPanelToken(id: string) {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  const store = useStoreProject();
  return useMutation({
    mutationFn: () => weldpanel.projects.rotateToken(id).then((res) => res.data),
    onSuccess: (project) => {
      store(project);
      void queryClient.invalidateQueries({ queryKey: weldpanelKeys.install(id) });
    },
  });
}

export function useDeleteWeldPanelProject() {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldpanel.projects.remove(id),
    onSuccess: (_void, id) => {
      queryClient.removeQueries({ queryKey: weldpanelKeys.project(id) });
      void queryClient.invalidateQueries({ queryKey: weldpanelKeys.projectList() });
    },
  });
}

// ---------------------------------------------------------------------------
// Secret keys (`panel_projects:manage`)
// ---------------------------------------------------------------------------

export function useWeldPanelProjectKeys(projectId: string) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.secretKeys(projectId),
    queryFn: () => weldpanel.keys.list(projectId),
    select: (res) => res.data,
    enabled: projectId !== '',
    meta: { persist: false },
  });
}

/** The result carries the whole key (`wps_…`), once: show it, never cache it. */
export function useCreateWeldPanelKey(projectId: string) {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePanelKeyInput) => weldpanel.keys.create(projectId, input).then((res) => res.data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldpanelKeys.secretKeys(projectId) }),
  });
}

export function useRevokeWeldPanelKey(projectId: string) {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => weldpanel.keys.revoke(projectId, keyId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldpanelKeys.secretKeys(projectId) }),
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface WeldPanelQueryOptions {
  enabled?: boolean;
  /** Refetch on this interval (ms), for a live-ish chart. */
  refetchInterval?: number | false;
}

/** Runs any query spec. The data is the whole response: `{ kind, result, dataAsOf, cached }`. */
export function useWeldPanelQuery(spec: PanelQuerySpec, options: WeldPanelQueryOptions = {}) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.query(spec),
    queryFn: () => weldpanel.query.run(spec),
    select: (res) => res.data,
    enabled: (options.enabled ?? true) && spec.projectId !== '',
    staleTime: QUERY_STALE_MS,
    refetchInterval: options.refetchInterval ?? false,
    // Keep the old chart on screen while a new range or filter loads.
    placeholderData: keepPreviousData,
    meta: { persist: false },
  });
}

/** A result narrowed to its kind, with how fresh it is. */
export interface WeldPanelResult<K extends PanelQueryKind> {
  result: PanelQueryResultOf<K>;
  dataAsOf: string;
  cached: boolean;
}

function useKindQuery<K extends PanelQueryKind>(kind: K, spec: PanelQuerySpec, options: WeldPanelQueryOptions) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.query(spec),
    queryFn: () => weldpanel.query.run(spec),
    select: (res): WeldPanelResult<K> => ({
      result: expectPanelResult(res.data, kind),
      dataAsOf: res.data.dataAsOf,
      cached: res.data.cached,
    }),
    enabled: (options.enabled ?? true) && spec.projectId !== '',
    staleTime: QUERY_STALE_MS,
    refetchInterval: options.refetchInterval ?? false,
    placeholderData: keepPreviousData,
    meta: { persist: false },
  });
}

/** Overview: visitors, visits, pageviews, bounce rate, top pages, sources, countries, devices. */
export function useWeldPanelWeb(spec: PanelWebSpec, options: WeldPanelQueryOptions = {}) {
  return useKindQuery('web', spec, options);
}

export function useWeldPanelTrends(spec: PanelTrendsSpec, options: WeldPanelQueryOptions = {}) {
  return useKindQuery('trends', spec, options);
}

export function useWeldPanelFunnel(spec: PanelFunnelSpec, options: WeldPanelQueryOptions = {}) {
  return useKindQuery('funnel', spec, options);
}

export function useWeldPanelRetention(spec: PanelRetentionSpec, options: WeldPanelQueryOptions = {}) {
  return useKindQuery('retention', spec, options);
}

export function useWeldPanelFlows(spec: PanelFlowsSpec, options: WeldPanelQueryOptions = {}) {
  return useKindQuery('flows', spec, options);
}

/** Heatmap data for a page group (or URL pattern), device class and type. */
export function useWeldPanelHeatmap(spec: PanelHeatmapSpec, options: WeldPanelQueryOptions = {}) {
  return useKindQuery('heatmap', spec, options);
}

/**
 * The recordings list, paged: `data.pages` each hold the sessions of one
 * request, `fetchNextPage()` loads the next ones (`hasNextPage`). Pass the
 * spec without `cursor`. Needs `panel_recordings:read`.
 */
export function useWeldPanelRecordings(spec: PanelSessionsSpec, options: WeldPanelQueryOptions = {}) {
  const { weldpanel } = useAppApi();
  return useInfiniteQuery({
    queryKey: weldpanelKeys.recordings(spec),
    queryFn: ({ pageParam }) => weldpanel.sessions.list({ ...spec, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => {
      const response = last.data;
      return response.kind === 'sessions' ? response.result.nextCursor : null;
    },
    select: (data) => ({
      pages: data.pages.map((page) => expectPanelResult(page.data, 'sessions')),
      sessions: data.pages.flatMap((page) => expectPanelResult(page.data, 'sessions').sessions),
      dataAsOf: data.pages[0]?.data.dataAsOf ?? null,
    }),
    enabled: (options.enabled ?? true) && spec.projectId !== '',
    staleTime: QUERY_STALE_MS,
    refetchInterval: options.refetchInterval ?? false,
    meta: { persist: false },
  });
}

/** Refreshes every query result of these kinds (after a favourite, an erasure, a settings change). */
function refreshQueries(queryClient: QueryClient, ...kinds: PanelQueryKind[]) {
  for (const kind of kinds) void queryClient.invalidateQueries({ queryKey: weldpanelKeys.queriesOfKind(kind) });
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export function useWeldPanelReports(params: PanelReportListParams | undefined, enabled = true) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.reportList(params),
    queryFn: () => weldpanel.reports.list(params ?? ({} as PanelReportListParams)),
    select: (res) => res.data,
    enabled,
  });
}

export function useWeldPanelReport(id: string) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.report(id),
    queryFn: () => weldpanel.reports.get(id),
    select: (res) => res.data,
    enabled: id !== '',
  });
}

export function useCreateWeldPanelReport() {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePanelReportInput) => weldpanel.reports.create(input).then((res) => res.data),
    onSuccess: (report) => {
      queryClient.setQueryData(weldpanelKeys.report(report.id), { data: report });
      void queryClient.invalidateQueries({ queryKey: [...weldpanelKeys.reports(), 'list'] });
    },
  });
}

export function useUpdateWeldPanelReport(id: string) {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePanelReportInput) => weldpanel.reports.update(id, input).then((res) => res.data),
    onSuccess: (report) => {
      queryClient.setQueryData(weldpanelKeys.report(report.id), { data: report });
      void queryClient.invalidateQueries({ queryKey: [...weldpanelKeys.reports(), 'list'] });
      // Dashboards show the report's spec.
      void queryClient.invalidateQueries({ queryKey: weldpanelKeys.dashboards() });
    },
  });
}

export function useDeleteWeldPanelReport() {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldpanel.reports.remove(id),
    onSuccess: (_void, id) => {
      queryClient.removeQueries({ queryKey: weldpanelKeys.report(id) });
      void queryClient.invalidateQueries({ queryKey: [...weldpanelKeys.reports(), 'list'] });
      // The report leaves every dashboard.
      void queryClient.invalidateQueries({ queryKey: weldpanelKeys.dashboards() });
    },
  });
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

export function useWeldPanelDashboards(params: PanelDashboardListParams | undefined, enabled = true) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.dashboardList(params),
    queryFn: () => weldpanel.dashboards.list(params ?? ({} as PanelDashboardListParams)),
    select: (res) => res.data,
    enabled,
  });
}

/** The dashboard with its tiles and the reports on them. */
export function useWeldPanelDashboard(id: string) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.dashboard(id),
    queryFn: () => weldpanel.dashboards.get(id),
    select: (res) => res.data,
    enabled: id !== '',
  });
}

export function useCreateWeldPanelDashboard() {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePanelDashboardInput) => weldpanel.dashboards.create(input).then((res) => res.data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [...weldpanelKeys.dashboards(), 'list'] }),
  });
}

function useRefreshDashboard(id: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: weldpanelKeys.dashboard(id) });
    void queryClient.invalidateQueries({ queryKey: [...weldpanelKeys.dashboards(), 'list'] });
  };
}

export function useUpdateWeldPanelDashboard(id: string) {
  const { weldpanel } = useAppApi();
  const refresh = useRefreshDashboard(id);
  return useMutation({
    mutationFn: (input: UpdatePanelDashboardInput) => weldpanel.dashboards.update(id, input).then((res) => res.data),
    onSuccess: refresh,
  });
}

export function useDeleteWeldPanelDashboard() {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldpanel.dashboards.remove(id),
    onSuccess: (_void, id) => {
      queryClient.removeQueries({ queryKey: weldpanelKeys.dashboard(id) });
      void queryClient.invalidateQueries({ queryKey: [...weldpanelKeys.dashboards(), 'list'] });
    },
  });
}

export function useAddWeldPanelDashboardTile(dashboardId: string) {
  const { weldpanel } = useAppApi();
  const refresh = useRefreshDashboard(dashboardId);
  return useMutation({
    mutationFn: (input: AddPanelDashboardTileInput) => weldpanel.dashboards.addTile(dashboardId, input).then((res) => res.data),
    onSuccess: refresh,
  });
}

export function useUpdateWeldPanelDashboardTile(dashboardId: string) {
  const { weldpanel } = useAppApi();
  const refresh = useRefreshDashboard(dashboardId);
  return useMutation({
    mutationFn: (input: { tileId: string } & UpdatePanelDashboardTileInput) =>
      weldpanel.dashboards.updateTile(dashboardId, input.tileId, { layout: input.layout }).then((res) => res.data),
    onSuccess: refresh,
  });
}

export function useRemoveWeldPanelDashboardTile(dashboardId: string) {
  const { weldpanel } = useAppApi();
  const refresh = useRefreshDashboard(dashboardId);
  return useMutation({
    mutationFn: (tileId: string) => weldpanel.dashboards.removeTile(dashboardId, tileId),
    onSuccess: refresh,
  });
}

/** Moves and resizes every tile at once; the answer (the whole dashboard) replaces the cached detail. */
export function useSetWeldPanelDashboardLayout(dashboardId: string) {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetPanelDashboardLayoutInput) => weldpanel.dashboards.setLayout(dashboardId, input).then((res) => res.data),
    onSuccess: (dashboard) => queryClient.setQueryData(weldpanelKeys.dashboard(dashboardId), { data: dashboard }),
  });
}

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

export function useWeldPanelCohorts(projectId: string | undefined, enabled = true) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.cohortList(projectId),
    queryFn: () => weldpanel.cohorts.list(projectId ?? ''),
    select: (res) => res.data,
    enabled: enabled && projectId !== '',
  });
}

export function useWeldPanelCohort(id: string) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.cohort(id),
    queryFn: () => weldpanel.cohorts.get(id),
    select: (res) => res.data,
    enabled: id !== '',
  });
}

export function useCreateWeldPanelCohort() {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePanelCohortInput) => weldpanel.cohorts.create(input).then((res) => res.data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [...weldpanelKeys.cohorts(), 'list'] }),
  });
}

export function useUpdateWeldPanelCohort(id: string) {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePanelCohortInput) => weldpanel.cohorts.update(id, input).then((res) => res.data),
    onSuccess: (cohort) => {
      queryClient.setQueryData(weldpanelKeys.cohort(cohort.id), { data: cohort });
      void queryClient.invalidateQueries({ queryKey: [...weldpanelKeys.cohorts(), 'list'] });
      // Reports that filter by the cohort now mean something else.
      void queryClient.invalidateQueries({ queryKey: weldpanelKeys.queries() });
    },
  });
}

export function useDeleteWeldPanelCohort() {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldpanel.cohorts.remove(id),
    onSuccess: (_void, id) => {
      queryClient.removeQueries({ queryKey: weldpanelKeys.cohort(id) });
      void queryClient.invalidateQueries({ queryKey: [...weldpanelKeys.cohorts(), 'list'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Lexicon
// ---------------------------------------------------------------------------

export function useWeldPanelLexicon(projectId: string, enabled = true) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.lexicon(projectId),
    queryFn: () => weldpanel.lexicon.get(projectId),
    select: (res) => res.data,
    enabled: enabled && projectId !== '',
    staleTime: 5 * 60_000,
    meta: { persist: false },
  });
}

export function useUpdateWeldPanelLexicon(projectId: string) {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<UpdatePanelLexiconInput, 'projectId'>) =>
      weldpanel.lexicon.update({ ...input, projectId } as UpdatePanelLexiconInput).then((res) => res.data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldpanelKeys.lexicon(projectId) }),
  });
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** The people list, paged by cursor: pass the params without `cursor`. */
export function useWeldPanelPeople(params: Omit<PanelPeopleListParams, 'cursor'>, enabled = true) {
  const { weldpanel } = useAppApi();
  return useInfiniteQuery({
    queryKey: weldpanelKeys.peopleList(params),
    queryFn: ({ pageParam }) => weldpanel.people.list({ ...params, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.pagination.hasMore ? last.pagination.cursor : null),
    select: (data) => ({
      people: data.pages.flatMap((page) => page.data),
      totalCount: data.pages[0]?.pagination.totalCount ?? 0,
    }),
    enabled: enabled && params.projectId !== '',
    meta: { persist: false },
  });
}

/** A profile with its properties, recent events and sessions. Needs `panel_people:read`. */
export function useWeldPanelPerson(projectId: string, distinctId: string) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.person(projectId, distinctId),
    queryFn: () => weldpanel.people.get(projectId, distinctId),
    select: (res) => res.data,
    enabled: projectId !== '' && distinctId !== '',
    meta: { persist: false },
  });
}

/** For the WeldCRM person card: website activity by email, across projects. */
export function useWeldPanelPeopleByEmail(email: string | null | undefined) {
  const { weldpanel } = useAppApi();
  const address = email?.trim() ?? '';
  return useQuery({
    queryKey: weldpanelKeys.peopleByEmail(address),
    queryFn: () => weldpanel.people.byEmail(address),
    select: (res) => res.data,
    enabled: address !== '',
    staleTime: QUERY_STALE_MS,
    meta: { persist: false },
  });
}

/** GDPR erasure (`panel_people:delete`). Everything that could show the person is refetched. */
export function useEraseWeldPanelPerson(projectId: string) {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (distinctId: string) => weldpanel.people.erase(projectId, distinctId).then((res) => res.data),
    onSuccess: (_result, distinctId) => {
      queryClient.removeQueries({ queryKey: weldpanelKeys.person(projectId, distinctId) });
      void queryClient.invalidateQueries({ queryKey: weldpanelKeys.people() });
      void queryClient.invalidateQueries({ queryKey: weldpanelKeys.sessions() });
      refreshQueries(queryClient, 'web', 'trends', 'funnel', 'retention', 'flows', 'sessions');
    },
  });
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

/** One recording: metadata, chunk manifest, timeline events, the person and their other sessions. */
export function useWeldPanelSession(projectId: string, sessionId: string) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.session(projectId, sessionId),
    queryFn: () => weldpanel.sessions.get(projectId, sessionId),
    select: (res) => res.data,
    enabled: projectId !== '' && sessionId !== '',
    meta: { persist: false },
  });
}

/**
 * Loads one chunk's compressed bytes (gzip of rrweb events JSON) for the
 * player. A function, not a query: chunks are big and the player owns them.
 */
export function useWeldPanelChunkLoader() {
  const { weldpanel } = useAppApi();
  return (projectId: string, sessionId: string, seq: number): Promise<ArrayBuffer> =>
    weldpanel.sessions.chunkBytes(projectId, sessionId, seq);
}

function useRefreshRecordings() {
  const queryClient = useQueryClient();
  return (projectId: string, sessionId: string) => {
    void queryClient.invalidateQueries({ queryKey: weldpanelKeys.session(projectId, sessionId) });
    void queryClient.invalidateQueries({ queryKey: [...weldpanelKeys.sessions(), 'list'] });
    refreshQueries(queryClient, 'sessions');
  };
}

export function useFavoriteWeldPanelSession(projectId: string) {
  const { weldpanel } = useAppApi();
  const refresh = useRefreshRecordings();
  return useMutation({
    mutationFn: (input: { sessionId: string; note?: string | null }) =>
      weldpanel.sessions.favorite(input.sessionId, { projectId, note: input.note } as FavoritePanelSessionInput).then((res) => res.data),
    onSuccess: (favorite) => refresh(projectId, favorite.sessionId),
  });
}

export function useUnfavoriteWeldPanelSession(projectId: string) {
  const { weldpanel } = useAppApi();
  const refresh = useRefreshRecordings();
  return useMutation({
    mutationFn: (sessionId: string) => weldpanel.sessions.unfavorite(projectId, sessionId),
    onSuccess: (_void, sessionId) => refresh(projectId, sessionId),
  });
}

// ---------------------------------------------------------------------------
// AI summaries
// ---------------------------------------------------------------------------

/** The cached summary (`data` is null when there is none); never charges. */
export function useWeldPanelSessionSummary(projectId: string, sessionId: string, enabled = true) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.sessionSummary(projectId, sessionId),
    queryFn: () => weldpanel.sessions.getSummary(projectId, sessionId),
    select: (res) => res.data,
    enabled: enabled && projectId !== '' && sessionId !== '',
    meta: { persist: false },
  });
}

/**
 * Generates a summary (charged unless one is cached). Fails with a 402
 * `insufficient_credits` error when the wallet is empty; the new summary
 * replaces the cached one and the wallet balance is refetched by the caller's
 * credits hooks.
 */
export function useGenerateWeldPanelSessionSummary(projectId: string) {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { sessionId: string } & Omit<GeneratePanelSessionSummaryInput, 'projectId'>) =>
      weldpanel.sessions.summarise(input.sessionId, { projectId, regenerate: input.regenerate }).then((res) => res.data),
    onSuccess: (summary) => {
      queryClient.setQueryData(weldpanelKeys.sessionSummary(projectId, summary.sessionId), { data: summary });
      void queryClient.invalidateQueries({ queryKey: weldpanelKeys.session(projectId, summary.sessionId) });
    },
  });
}

/** Themes across up to 20 sessions from a recordings filter or a funnel drop-off. 402 when the wallet is empty. */
export function useSummariseWeldPanelSet() {
  const { weldpanel } = useAppApi();
  return useMutation({
    mutationFn: (input: SummarisePanelSetInput) => weldpanel.insights.summarise(input).then((res) => res.data),
  });
}

// ---------------------------------------------------------------------------
// Heatmaps
// ---------------------------------------------------------------------------

export function useWeldPanelHeatmapPages(projectId: string, enabled = true) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.heatmapPages(projectId),
    queryFn: () => weldpanel.heatmaps.listPages(projectId),
    select: (res) => res.data,
    enabled: enabled && projectId !== '',
  });
}

export function useCreateWeldPanelHeatmapPage() {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePanelHeatmapPageInput) => weldpanel.heatmaps.createPage(input).then((res) => res.data),
    onSuccess: (page) => void queryClient.invalidateQueries({ queryKey: weldpanelKeys.heatmapPages(page.projectId) }),
  });
}

export function useUpdateWeldPanelHeatmapPage(projectId: string) {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string } & UpdatePanelHeatmapPageInput) => {
      const { id, ...body } = input;
      return weldpanel.heatmaps.updatePage(id, body).then((res) => res.data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: weldpanelKeys.heatmapPages(projectId) });
      // A page group's pattern decides what its heatmap shows.
      refreshQueries(queryClient, 'heatmap');
    },
  });
}

export function useDeleteWeldPanelHeatmapPage(projectId: string) {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldpanel.heatmaps.removePage(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldpanelKeys.heatmapPages(projectId) }),
  });
}

/** Loads the masked snapshot (gzip rrweb full snapshot) a heat layer is drawn on; rejects with a 404 when none exists yet. */
export function useWeldPanelHeatmapSnapshotLoader() {
  const { weldpanel } = useAppApi();
  return (pageGroupId: string, deviceClass: PanelDeviceClass): Promise<Response> => weldpanel.heatmaps.snapshot(pageGroupId, deviceClass);
}

// ---------------------------------------------------------------------------
// Live and usage
// ---------------------------------------------------------------------------

/** Visitors right now, refreshed every 15 seconds. */
export function useWeldPanelLive(projectId: string, enabled = true) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.live(projectId),
    queryFn: () => weldpanel.live.get(projectId),
    select: (res) => res.data,
    enabled: enabled && projectId !== '',
    refetchInterval: LIVE_POLL_MS,
    meta: { persist: false },
  });
}

/** This month's events and recordings against the plan, the quota state and the retention. */
export function useWeldPanelUsage(enabled = true) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.usage(),
    queryFn: () => weldpanel.usage.get(),
    select: (res) => res.data,
    enabled,
    staleTime: QUERY_STALE_MS,
    meta: { persist: false },
  });
}

export type { PanelQueryResponse };
