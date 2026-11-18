/**
 * WeldPanel analysis hooks (the gaps PR, section E): the new report kinds
 * (stickiness, lifecycle, web vitals, impact, signal, funnel correlation), root
 * cause ("explain this change"), metric trees and their values, the data
 * definitions the builders offer (custom events, computed properties, path
 * rules) and groups with their types.
 *
 * Keys build on `weldpanelKeys.all` like every other WeldPanel hook, and query
 * results reuse `weldpanelKeys.query(spec)`, so refreshing the query kinds
 * after an erasure or a settings change also refreshes these.
 */

import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { expectPanelResult } from '@weldsuite/app-api-client/domains/weldpanel';
import type {
  ExplainPanelChangeInput,
  PanelMetricTreeValuesInput,
  PanelSavedMetricTreeValuesInput,
} from '@weldsuite/app-api-client/schemas/weldpanel-analysis';
import type {
  CreatePanelComputedPropertyInput,
  CreatePanelCustomEventInput,
  CreatePanelMetricTreeInput,
  PanelMetricTreeListParams,
  SetPanelPathRulesInput,
  TestPanelPathRulesInput,
  UpdatePanelComputedPropertyInput,
  UpdatePanelCustomEventInput,
  UpdatePanelMetricTreeInput,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { CreatePanelGroupTypeInput, PanelGroupListParams, UpdatePanelGroupTypeInput } from '@weldsuite/app-api-client/schemas/weldpanel-groups';
import type {
  PanelFunnelCorrelationSpec,
  PanelLifecycleSpec,
  PanelImpactSpec,
  PanelQueryKind,
  PanelQuerySpec,
  PanelSignalSpec,
  PanelStickinessSpec,
  PanelVitalsSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { QUERY_STALE_MS, weldpanelKeys, type WeldPanelQueryOptions, type WeldPanelResult } from './use-weldpanel-queries';

export const weldpanelAnalysisKeys = {
  customEvents: (projectId: string) => [...weldpanelKeys.all, 'custom-events', projectId] as const,
  computedProperties: (projectId: string) => [...weldpanelKeys.all, 'computed-properties', projectId] as const,
  pathRules: (projectId: string) => [...weldpanelKeys.all, 'path-rules', projectId] as const,
  groupTypes: (projectId: string) => [...weldpanelKeys.all, 'group-types', projectId] as const,
  groups: () => [...weldpanelKeys.all, 'groups'] as const,
  groupList: (params: Omit<PanelGroupListParams, 'cursor'>) => [...weldpanelAnalysisKeys.groups(), 'list', params] as const,
  group: (projectId: string, groupType: string, groupKey: string) => [...weldpanelAnalysisKeys.groups(), 'profile', projectId, groupType, groupKey] as const,
  metricTrees: () => [...weldpanelKeys.all, 'metric-trees'] as const,
  metricTreeList: (params: PanelMetricTreeListParams) => [...weldpanelAnalysisKeys.metricTrees(), 'list', params] as const,
  metricTree: (id: string) => [...weldpanelAnalysisKeys.metricTrees(), 'detail', id] as const,
  /** Values of a saved tree, nested under it so a change to the tree refreshes them. */
  metricTreeValues: (id: string, input: PanelSavedMetricTreeValuesInput) => [...weldpanelAnalysisKeys.metricTree(id), 'values', input] as const,
  metricTreePreview: (input: PanelMetricTreeValuesInput) => [...weldpanelAnalysisKeys.metricTrees(), 'preview', input] as const,
};

// ---------------------------------------------------------------------------
// New report kinds
// ---------------------------------------------------------------------------

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

/** How often people (or groups) do an event: intervals active, or times done. */
export function useWeldPanelStickiness(spec: PanelStickinessSpec, options: WeldPanelQueryOptions = {}) {
  return useKindQuery('stickiness', spec, options);
}

/** New, returning, resurrecting and dormant per bucket. */
export function useWeldPanelLifecycle(spec: PanelLifecycleSpec, options: WeldPanelQueryOptions = {}) {
  return useKindQuery('lifecycle', spec, options);
}

/** Core Web Vitals from `$webvitals` events. */
export function useWeldPanelVitals(spec: PanelVitalsSpec, options: WeldPanelQueryOptions = {}) {
  return useKindQuery('vitals', spec, options);
}

/** Did a launch move a metric: adopters against everyone else, before and after. */
export function useWeldPanelImpact(spec: PanelImpactSpec, options: WeldPanelQueryOptions = {}) {
  return useKindQuery('impact', spec, options);
}

/** Which early events go with reaching a goal. */
export function useWeldPanelSignal(spec: PanelSignalSpec, options: WeldPanelQueryOptions = {}) {
  return useKindQuery('signal', spec, options);
}

/** What sets a funnel's converters apart from the people who dropped. */
export function useWeldPanelFunnelCorrelation(spec: PanelFunnelCorrelationSpec, options: WeldPanelQueryOptions = {}) {
  return useKindQuery('funnel_correlation', spec, options);
}

// ---------------------------------------------------------------------------
// Root cause
// ---------------------------------------------------------------------------

/**
 * "Explain this change". A mutation, not a query: it runs on a click, and with
 * `narrate` it charges AI credits (402 `insufficient_credits` when the wallet
 * is empty; a narrative the project cannot have comes back as
 * `narrativeUnavailable`).
 */
export function useExplainWeldPanelChange() {
  const { weldpanelAnalysis } = useAppApi();
  return useMutation({
    mutationFn: (input: ExplainPanelChangeInput) => weldpanelAnalysis.insights.explain(input).then((res) => res.data),
  });
}

// ---------------------------------------------------------------------------
// Custom events and computed properties
// ---------------------------------------------------------------------------

export function useWeldPanelCustomEvents(projectId: string, enabled = true) {
  const { weldpanelCollab } = useAppApi();
  return useQuery({
    queryKey: weldpanelAnalysisKeys.customEvents(projectId),
    queryFn: () => weldpanelCollab.customEvents.list(projectId),
    select: (res) => res.data,
    enabled: enabled && projectId !== '',
    staleTime: 5 * 60_000,
  });
}

/** A definition changed: every result may mean something else now. */
function useRefreshAfterDefinition() {
  const queryClient = useQueryClient();
  return (key: readonly unknown[]) => {
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: weldpanelKeys.queries() });
  };
}

export function useCreateWeldPanelCustomEvent() {
  const { weldpanelCollab } = useAppApi();
  const refresh = useRefreshAfterDefinition();
  return useMutation({
    mutationFn: (input: CreatePanelCustomEventInput) => weldpanelCollab.customEvents.create(input).then((res) => res.data),
    onSuccess: (event) => refresh(weldpanelAnalysisKeys.customEvents(event.projectId)),
  });
}

export function useUpdateWeldPanelCustomEvent(projectId: string) {
  const { weldpanelCollab } = useAppApi();
  const refresh = useRefreshAfterDefinition();
  return useMutation({
    mutationFn: (input: { id: string } & UpdatePanelCustomEventInput) => {
      const { id, ...body } = input;
      return weldpanelCollab.customEvents.update(id, body).then((res) => res.data);
    },
    onSuccess: () => refresh(weldpanelAnalysisKeys.customEvents(projectId)),
  });
}

export function useDeleteWeldPanelCustomEvent(projectId: string) {
  const { weldpanelCollab } = useAppApi();
  const refresh = useRefreshAfterDefinition();
  return useMutation({
    mutationFn: (id: string) => weldpanelCollab.customEvents.remove(id),
    onSuccess: () => refresh(weldpanelAnalysisKeys.customEvents(projectId)),
  });
}

export function useWeldPanelComputedProperties(projectId: string, enabled = true) {
  const { weldpanelCollab } = useAppApi();
  return useQuery({
    queryKey: weldpanelAnalysisKeys.computedProperties(projectId),
    queryFn: () => weldpanelCollab.computedProperties.list(projectId),
    select: (res) => res.data,
    enabled: enabled && projectId !== '',
    staleTime: 5 * 60_000,
  });
}

export function useCreateWeldPanelComputedProperty() {
  const { weldpanelCollab } = useAppApi();
  const refresh = useRefreshAfterDefinition();
  return useMutation({
    mutationFn: (input: CreatePanelComputedPropertyInput) => weldpanelCollab.computedProperties.create(input).then((res) => res.data),
    onSuccess: (property) => refresh(weldpanelAnalysisKeys.computedProperties(property.projectId)),
  });
}

export function useUpdateWeldPanelComputedProperty(projectId: string) {
  const { weldpanelCollab } = useAppApi();
  const refresh = useRefreshAfterDefinition();
  return useMutation({
    mutationFn: (input: { id: string } & UpdatePanelComputedPropertyInput) => {
      const { id, ...body } = input;
      return weldpanelCollab.computedProperties.update(id, body).then((res) => res.data);
    },
    onSuccess: () => refresh(weldpanelAnalysisKeys.computedProperties(projectId)),
  });
}

export function useDeleteWeldPanelComputedProperty(projectId: string) {
  const { weldpanelCollab } = useAppApi();
  const refresh = useRefreshAfterDefinition();
  return useMutation({
    mutationFn: (id: string) => weldpanelCollab.computedProperties.remove(id),
    onSuccess: () => refresh(weldpanelAnalysisKeys.computedProperties(projectId)),
  });
}

// ---------------------------------------------------------------------------
// Path rules
// ---------------------------------------------------------------------------

export function useWeldPanelPathRules(projectId: string, enabled = true) {
  const { weldpanelCollab } = useAppApi();
  return useQuery({
    queryKey: weldpanelAnalysisKeys.pathRules(projectId),
    queryFn: () => weldpanelCollab.pathRules.list(projectId),
    select: (res) => res.data,
    enabled: enabled && projectId !== '',
  });
}

/** Replaces the project's whole ordered list; the answer replaces the cached list. */
export function useReplaceWeldPanelPathRules(projectId: string) {
  const { weldpanelCollab } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetPanelPathRulesInput) => weldpanelCollab.pathRules.replace(projectId, input),
    onSuccess: (res) => {
      queryClient.setQueryData(weldpanelAnalysisKeys.pathRules(projectId), res);
      // Pages are grouped by the cleaned path.
      void queryClient.invalidateQueries({ queryKey: weldpanelKeys.queries() });
    },
  });
}

/** Applies rules (unsaved ones, or the project's) to sample paths. Changes nothing. */
export function useTestWeldPanelPathRules() {
  const { weldpanelCollab } = useAppApi();
  return useMutation({
    mutationFn: (input: TestPanelPathRulesInput) => weldpanelCollab.pathRules.test(input).then((res) => res.data.results),
  });
}

// ---------------------------------------------------------------------------
// Groups and group types
// ---------------------------------------------------------------------------

export function useWeldPanelGroupTypes(projectId: string, enabled = true) {
  const { weldpanelGroups } = useAppApi();
  return useQuery({
    queryKey: weldpanelAnalysisKeys.groupTypes(projectId),
    queryFn: () => weldpanelGroups.listGroupTypes(projectId),
    select: (res) => res.data,
    enabled: enabled && projectId !== '',
    staleTime: 5 * 60_000,
  });
}

export function useCreateWeldPanelGroupType(projectId: string) {
  const { weldpanelGroups } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CreatePanelGroupTypeInput, 'projectId'>) => weldpanelGroups.createGroupType({ ...input, projectId }).then((res) => res.data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldpanelAnalysisKeys.groupTypes(projectId) }),
  });
}

export function useUpdateWeldPanelGroupType(projectId: string) {
  const { weldpanelGroups } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string } & UpdatePanelGroupTypeInput) => {
      const { id, ...body } = input;
      return weldpanelGroups.updateGroupType(id, body).then((res) => res.data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: weldpanelAnalysisKeys.groupTypes(projectId) });
      // The CRM match decides which company a profile links to.
      void queryClient.invalidateQueries({ queryKey: weldpanelAnalysisKeys.groups() });
    },
  });
}

export function useDeleteWeldPanelGroupType(projectId: string) {
  const { weldpanelGroups } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldpanelGroups.deleteGroupType(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldpanelAnalysisKeys.groupTypes(projectId) }),
  });
}

/** One type's groups, most recently seen first, paged by cursor: pass the params without `cursor`. */
export function useWeldPanelGroups(params: Omit<PanelGroupListParams, 'cursor'>, enabled = true) {
  const { weldpanelGroups } = useAppApi();
  return useInfiniteQuery({
    queryKey: weldpanelAnalysisKeys.groupList(params),
    queryFn: ({ pageParam }) => weldpanelGroups.listGroups({ ...params, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.pagination.hasMore ? last.pagination.cursor : null),
    select: (data) => ({ groups: data.pages.flatMap((page) => page.data) }),
    enabled: enabled && params.projectId !== '' && params.type !== '',
    meta: { persist: false },
  });
}

/** A group's profile: properties, recent events, members and the matched WeldCRM company. */
export function useWeldPanelGroup(projectId: string, groupType: string, groupKey: string) {
  const { weldpanelGroups } = useAppApi();
  return useQuery({
    queryKey: weldpanelAnalysisKeys.group(projectId, groupType, groupKey),
    queryFn: () => weldpanelGroups.getGroup(projectId, groupType, groupKey),
    select: (res) => res.data,
    enabled: projectId !== '' && groupType !== '' && groupKey !== '',
    meta: { persist: false },
  });
}

export function useDeleteWeldPanelGroup(projectId: string) {
  const { weldpanelGroups } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { groupType: string; groupKey: string }) => weldpanelGroups.deleteGroup(projectId, input.groupType, input.groupKey),
    onSuccess: (_void, input) => {
      queryClient.removeQueries({ queryKey: weldpanelAnalysisKeys.group(projectId, input.groupType, input.groupKey) });
      void queryClient.invalidateQueries({ queryKey: [...weldpanelAnalysisKeys.groups(), 'list'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Metric trees
// ---------------------------------------------------------------------------

export function useWeldPanelMetricTrees(params: PanelMetricTreeListParams, enabled = true) {
  const { weldpanelCollab } = useAppApi();
  return useQuery({
    queryKey: weldpanelAnalysisKeys.metricTreeList(params),
    queryFn: () => weldpanelCollab.metricTrees.list(params),
    select: (res) => res.data,
    enabled: enabled && params.projectId !== '',
  });
}

export function useWeldPanelMetricTree(id: string) {
  const { weldpanelCollab } = useAppApi();
  return useQuery({
    queryKey: weldpanelAnalysisKeys.metricTree(id),
    queryFn: () => weldpanelCollab.metricTrees.get(id),
    select: (res) => res.data,
    enabled: id !== '',
  });
}

export function useCreateWeldPanelMetricTree() {
  const { weldpanelCollab } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePanelMetricTreeInput) => weldpanelCollab.metricTrees.create(input).then((res) => res.data),
    onSuccess: (tree) => {
      queryClient.setQueryData(weldpanelAnalysisKeys.metricTree(tree.id), { data: tree });
      void queryClient.invalidateQueries({ queryKey: [...weldpanelAnalysisKeys.metricTrees(), 'list'] });
    },
  });
}

export function useUpdateWeldPanelMetricTree(id: string) {
  const { weldpanelCollab } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePanelMetricTreeInput) => weldpanelCollab.metricTrees.update(id, input).then((res) => res.data),
    onSuccess: (tree) => {
      queryClient.setQueryData(weldpanelAnalysisKeys.metricTree(tree.id), { data: tree });
      void queryClient.invalidateQueries({ queryKey: [...weldpanelAnalysisKeys.metricTree(tree.id), 'values'] });
      void queryClient.invalidateQueries({ queryKey: [...weldpanelAnalysisKeys.metricTrees(), 'list'] });
    },
  });
}

export function useDeleteWeldPanelMetricTree() {
  const { weldpanelCollab } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldpanelCollab.metricTrees.remove(id),
    onSuccess: (_void, id) => {
      queryClient.removeQueries({ queryKey: weldpanelAnalysisKeys.metricTree(id) });
      void queryClient.invalidateQueries({ queryKey: [...weldpanelAnalysisKeys.metricTrees(), 'list'] });
    },
  });
}

/** Each node's value for the period, the change against the period before and its correlation with the parent. */
export function useWeldPanelMetricTreeValues(id: string, input: PanelSavedMetricTreeValuesInput = {}, enabled = true) {
  const { weldpanelAnalysis } = useAppApi();
  return useQuery({
    queryKey: weldpanelAnalysisKeys.metricTreeValues(id, input),
    queryFn: () => weldpanelAnalysis.metricTreeValues.get(id, input),
    select: (res) => res.data,
    enabled: enabled && id !== '',
    staleTime: QUERY_STALE_MS,
    placeholderData: keepPreviousData,
    meta: { persist: false },
  });
}

/** The same for nodes that are not saved yet (the editor's preview). */
export function useWeldPanelMetricTreePreview(input: PanelMetricTreeValuesInput, enabled = true) {
  const { weldpanelAnalysis } = useAppApi();
  return useQuery({
    queryKey: weldpanelAnalysisKeys.metricTreePreview(input),
    queryFn: () => weldpanelAnalysis.metricTreeValues.preview(input),
    select: (res) => res.data,
    enabled: enabled && input.projectId !== '',
    staleTime: QUERY_STALE_MS,
    placeholderData: keepPreviousData,
    meta: { persist: false },
  });
}
