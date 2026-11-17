/**
 * The analysis hooks: new report kinds narrow to their result, explain is a
 * mutation, definitions refresh every query result when they change, path
 * rules replace the cached list, groups page by cursor and metric tree values
 * are keyed by tree and period.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => {
  const fns = (names: string[]) => Object.fromEntries(names.map((n) => [n, vi.fn()]));
  return {
    weldpanel: { query: fns(['run']) },
    weldpanelAnalysis: { insights: fns(['explain']), metricTreeValues: fns(['preview', 'get']) },
    weldpanelCollab: {
      customEvents: fns(['list', 'get', 'create', 'update', 'remove']),
      computedProperties: fns(['list', 'get', 'create', 'update', 'remove']),
      pathRules: fns(['list', 'replace', 'test']),
      metricTrees: fns(['list', 'get', 'create', 'update', 'remove']),
    },
    weldpanelGroups: fns(['listGroupTypes', 'createGroupType', 'updateGroupType', 'deleteGroupType', 'listGroups', 'getGroup', 'deleteGroup']),
  };
});
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));

import {
  useCreateWeldPanelCustomEvent,
  useCreateWeldPanelGroupType,
  useDeleteWeldPanelGroup,
  useExplainWeldPanelChange,
  useReplaceWeldPanelPathRules,
  useUpdateWeldPanelMetricTree,
  useWeldPanelGroups,
  useWeldPanelMetricTreeValues,
  useWeldPanelStickiness,
  useWeldPanelVitals,
  weldpanelAnalysisKeys,
} from './use-weldpanel-analysis-queries';
import { weldpanelKeys } from './use-weldpanel-queries';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const invalidated = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);
  return { client, wrapper, invalidated };
}

function resetAll(value: unknown) {
  if (typeof value === 'function' && 'mockReset' in value) (value as ReturnType<typeof vi.fn>).mockReset();
  else if (value && typeof value === 'object') for (const inner of Object.values(value)) resetAll(inner);
}

beforeEach(() => resetAll(api));

const response = <K extends string>(kind: K, result: object) => ({ data: { kind, result, dataAsOf: '2026-11-14T12:00:00.000Z', cached: true } });

describe('new report kinds', () => {
  it('narrow the result to their kind, with how fresh it is', async () => {
    api.weldpanel.query.run!.mockResolvedValue(response('stickiness', { total: 10, buckets: [] }));
    const { wrapper } = setup();
    const spec = { kind: 'stickiness' as const, projectId: 'wpp_1', event: '$pageview' };
    const { result } = renderHook(() => useWeldPanelStickiness(spec), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toEqual({ result: { total: 10, buckets: [] }, dataAsOf: '2026-11-14T12:00:00.000Z', cached: true });
    expect(api.weldpanel.query.run).toHaveBeenCalledWith(spec);
  });

  it('fail on a result of another kind', async () => {
    api.weldpanel.query.run!.mockResolvedValue(response('trends', { series: [] }));
    const { wrapper } = setup();
    const { result } = renderHook(() => useWeldPanelVitals({ kind: 'vitals', projectId: 'wpp_1' }), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('wait for a project', () => {
    const { wrapper } = setup();
    renderHook(() => useWeldPanelVitals({ kind: 'vitals', projectId: '' }), { wrapper });
    expect(api.weldpanel.query.run).not.toHaveBeenCalled();
  });
});

describe('explain', () => {
  it('runs only when asked, and returns the explanation', async () => {
    api.weldpanelAnalysis.insights.explain!.mockResolvedValue({ data: { dimensions: [], narrative: null } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useExplainWeldPanelChange(), { wrapper });
    expect(api.weldpanelAnalysis.insights.explain).not.toHaveBeenCalled();
    const input = { projectId: 'wpp_1', spec: { kind: 'trends' as const, projectId: 'wpp_1', series: [{ event: '$pageview' }] } };
    await act(() => result.current.mutateAsync(input));
    expect(api.weldpanelAnalysis.insights.explain).toHaveBeenCalledWith(input);
    await waitFor(() => expect(result.current.data).toEqual({ dimensions: [], narrative: null }));
  });
});

describe('definitions', () => {
  it('refresh the list and every query result after a change', async () => {
    api.weldpanelCollab.customEvents.create!.mockResolvedValue({ data: { id: 'pnce_1', projectId: 'wpp_1' } });
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useCreateWeldPanelCustomEvent(), { wrapper });
    await act(() => result.current.mutateAsync({ projectId: 'wpp_1', name: 'Signed up or invited', definition: { match: [{ event: 'Signed up' }] } }));
    expect(invalidated()).toEqual(expect.arrayContaining([weldpanelAnalysisKeys.customEvents('wpp_1'), weldpanelKeys.queries()]));
  });

  it('path rules: the answer replaces the cached list', async () => {
    const list = { data: [{ id: 'pnpr_1', position: 0, pattern: '^/u/\\d+', replacement: '/u/:id' }], pagination: { totalCount: 1, hasMore: false, cursor: null } };
    api.weldpanelCollab.pathRules.replace!.mockResolvedValue(list);
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useReplaceWeldPanelPathRules('wpp_1'), { wrapper });
    await act(() => result.current.mutateAsync({ rules: [{ pattern: '^/u/\\d+', replacement: '/u/:id' }] }));
    expect(api.weldpanelCollab.pathRules.replace).toHaveBeenCalledWith('wpp_1', { rules: [{ pattern: '^/u/\\d+', replacement: '/u/:id' }] });
    expect(client.getQueryData(weldpanelAnalysisKeys.pathRules('wpp_1'))).toEqual(list);
  });

  it('group types are created for the project', async () => {
    api.weldpanelGroups.createGroupType!.mockResolvedValue({ data: { id: 'pngt_1' } });
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useCreateWeldPanelGroupType('wpp_1'), { wrapper });
    await act(() => result.current.mutateAsync({ groupType: 'company', nameSingular: 'Company', namePlural: 'Companies' }));
    expect(api.weldpanelGroups.createGroupType).toHaveBeenCalledWith({ projectId: 'wpp_1', groupType: 'company', nameSingular: 'Company', namePlural: 'Companies' });
    expect(invalidated()).toContainEqual(weldpanelAnalysisKeys.groupTypes('wpp_1'));
  });
});

describe('groups', () => {
  it('page by cursor', async () => {
    api.weldpanelGroups.listGroups!
      .mockResolvedValueOnce({ data: [{ groupKey: 'acme' }], pagination: { totalCount: 2, hasMore: true, cursor: 'c1' } })
      .mockResolvedValueOnce({ data: [{ groupKey: 'globex' }], pagination: { totalCount: 2, hasMore: false, cursor: null } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useWeldPanelGroups({ projectId: 'wpp_1', type: 'company' }), { wrapper });
    await waitFor(() => expect(result.current.data?.groups).toHaveLength(1));
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.data?.groups).toHaveLength(2));
    expect(api.weldpanelGroups.listGroups).toHaveBeenLastCalledWith({ projectId: 'wpp_1', type: 'company', cursor: 'c1' });
  });

  it('a deleted profile leaves the cache and the lists refresh', async () => {
    api.weldpanelGroups.deleteGroup!.mockResolvedValue(undefined);
    const { client, wrapper, invalidated } = setup();
    client.setQueryData(weldpanelAnalysisKeys.group('wpp_1', 'company', 'acme'), { data: {} });
    const { result } = renderHook(() => useDeleteWeldPanelGroup('wpp_1'), { wrapper });
    await act(() => result.current.mutateAsync({ groupType: 'company', groupKey: 'acme' }));
    expect(api.weldpanelGroups.deleteGroup).toHaveBeenCalledWith('wpp_1', 'company', 'acme');
    expect(client.getQueryData(weldpanelAnalysisKeys.group('wpp_1', 'company', 'acme'))).toBeUndefined();
    expect(invalidated()).toContainEqual([...weldpanelAnalysisKeys.groups(), 'list']);
  });
});

describe('metric trees', () => {
  it('values are fetched per tree and period', async () => {
    api.weldpanelAnalysis.metricTreeValues.get!.mockResolvedValue({ data: { nodes: [], range: null, dataAsOf: 'x' } });
    const { wrapper } = setup();
    const input = { dateRange: { preset: '7d' as const } };
    const { result } = renderHook(() => useWeldPanelMetricTreeValues('pnmt_1', input), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ nodes: [], range: null, dataAsOf: 'x' }));
    expect(api.weldpanelAnalysis.metricTreeValues.get).toHaveBeenCalledWith('pnmt_1', input);
  });

  it('an update refreshes the tree values', async () => {
    api.weldpanelCollab.metricTrees.update!.mockResolvedValue({ data: { id: 'pnmt_1', projectId: 'wpp_1' } });
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useUpdateWeldPanelMetricTree('pnmt_1'), { wrapper });
    await act(() => result.current.mutateAsync({ name: 'Revenue' }));
    expect(invalidated()).toContainEqual([...weldpanelAnalysisKeys.metricTree('pnmt_1'), 'values']);
  });
});
