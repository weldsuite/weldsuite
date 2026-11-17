/**
 * Every analysis hook, table by table: the new report kinds run their spec
 * under the query key and narrow to their kind; the definition, group and
 * metric tree queries call their client with the right arguments under their
 * key and wait for what they need; each mutation refreshes (or drops) the
 * queries it changes.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => {
  const fns = <N extends string>(names: readonly N[]) => Object.fromEntries(names.map((n) => [n, vi.fn()])) as Record<N, Mock>;
  return {
    weldpanel: { query: fns(['run']) },
    weldpanelAnalysis: { insights: fns(['explain']), metricTreeValues: fns(['preview', 'get']) },
    weldpanelCollab: {
      customEvents: fns(['list', 'create', 'update', 'remove']),
      computedProperties: fns(['list', 'create', 'update', 'remove']),
      pathRules: fns(['list', 'replace', 'test']),
      metricTrees: fns(['list', 'get', 'create', 'update', 'remove']),
    },
    weldpanelGroups: fns(['listGroupTypes', 'createGroupType', 'updateGroupType', 'deleteGroupType', 'listGroups', 'getGroup', 'deleteGroup']),
  };
});
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));

import type { PanelQuerySpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import {
  useCreateWeldPanelComputedProperty,
  useCreateWeldPanelMetricTree,
  useDeleteWeldPanelComputedProperty,
  useDeleteWeldPanelCustomEvent,
  useDeleteWeldPanelGroupType,
  useDeleteWeldPanelMetricTree,
  useReplaceWeldPanelPathRules,
  useTestWeldPanelPathRules,
  useUpdateWeldPanelComputedProperty,
  useUpdateWeldPanelCustomEvent,
  useUpdateWeldPanelGroupType,
  useUpdateWeldPanelMetricTree,
  useWeldPanelComputedProperties,
  useWeldPanelCustomEvents,
  useWeldPanelFunnelCorrelation,
  useWeldPanelGroup,
  useWeldPanelGroups,
  useWeldPanelGroupTypes,
  useWeldPanelImpact,
  useWeldPanelLifecycle,
  useWeldPanelMetricTree,
  useWeldPanelMetricTreePreview,
  useWeldPanelMetricTrees,
  useWeldPanelMetricTreeValues,
  useWeldPanelPathRules,
  useWeldPanelSignal,
  useWeldPanelStickiness,
  useWeldPanelVitals,
  weldpanelAnalysisKeys,
} from './use-weldpanel-analysis-queries';
import { weldpanelKeys } from './use-weldpanel-queries';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const remove = vi.spyOn(client, 'removeQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const invalidated = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);
  const removed = () => remove.mock.calls.map(([filters]) => filters?.queryKey);
  return { client, wrapper, invalidated, removed };
}

function resetAll(value: unknown) {
  if (typeof value === 'function' && 'mockReset' in value) (value as Mock).mockReset();
  else if (value && typeof value === 'object') for (const inner of Object.values(value)) resetAll(inner);
}

beforeEach(() => resetAll(api));

const nodes = [{ id: 'root', label: 'Revenue', parentId: null, relation: null, metric: { reportId: 'wpr_1' } }];

interface KindCase {
  kind: string;
  spec: PanelQuerySpec;
  use: (spec: PanelQuerySpec) => { data: unknown };
}

const lifecycle = { kind: 'lifecycle' as const, projectId: 'wpp_1', event: 'Signed up' };
const impact = { kind: 'impact' as const, projectId: 'wpp_1', launchEvent: 'Used export', launchDate: '2026-10-01', metric: { event: '$pageview' } };
const signal = { kind: 'signal' as const, projectId: 'wpp_1', goal: { event: 'Paid' } };
const correlation = { kind: 'funnel_correlation' as const, projectId: 'wpp_1', steps: [{ event: 'Signed up' }, { event: 'Paid' }] };
const stickiness = { kind: 'stickiness' as const, projectId: 'wpp_1', event: '$pageview' };
const vitals = { kind: 'vitals' as const, projectId: 'wpp_1', metric: 'inp' as const };

const kindCases: KindCase[] = [
  { kind: 'lifecycle', spec: lifecycle, use: () => useWeldPanelLifecycle(lifecycle) },
  { kind: 'impact', spec: impact, use: () => useWeldPanelImpact(impact) },
  { kind: 'signal', spec: signal, use: () => useWeldPanelSignal(signal) },
  { kind: 'funnel_correlation', spec: correlation, use: () => useWeldPanelFunnelCorrelation(correlation) },
  { kind: 'stickiness', spec: stickiness, use: () => useWeldPanelStickiness(stickiness) },
  { kind: 'vitals', spec: vitals, use: () => useWeldPanelVitals(vitals) },
];

describe('new report kinds', () => {
  it.each(kindCases)('$kind: runs the spec under its query key and narrows the result', async ({ kind, spec, use }) => {
    api.weldpanel.query.run.mockResolvedValue({ data: { kind, result: { marker: kind }, dataAsOf: '2026-11-14T12:00:00.000Z', cached: false } });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => use(spec), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ result: { marker: kind }, dataAsOf: '2026-11-14T12:00:00.000Z', cached: false }));
    expect(api.weldpanel.query.run).toHaveBeenCalledWith(spec);
    expect(client.getQueryCache().find({ queryKey: weldpanelKeys.query(spec), exact: true })).toBeDefined();
  });

  it('can be switched off', async () => {
    const { wrapper } = setup();
    renderHook(() => useWeldPanelLifecycle(lifecycle, { enabled: false }), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.weldpanel.query.run).not.toHaveBeenCalled();
  });
});

interface QueryCase {
  name: string;
  fn: Mock;
  use: () => { data: unknown };
  args: unknown[];
  key: readonly unknown[];
}

const previewInput = { projectId: 'wpp_1', nodes };

const queryCases: QueryCase[] = [
  {
    name: 'custom events of a project',
    fn: api.weldpanelCollab.customEvents.list,
    use: () => useWeldPanelCustomEvents('wpp_1'),
    args: ['wpp_1'],
    key: weldpanelAnalysisKeys.customEvents('wpp_1'),
  },
  {
    name: 'computed properties of a project',
    fn: api.weldpanelCollab.computedProperties.list,
    use: () => useWeldPanelComputedProperties('wpp_1'),
    args: ['wpp_1'],
    key: weldpanelAnalysisKeys.computedProperties('wpp_1'),
  },
  {
    name: 'path rules of a project',
    fn: api.weldpanelCollab.pathRules.list,
    use: () => useWeldPanelPathRules('wpp_1'),
    args: ['wpp_1'],
    key: weldpanelAnalysisKeys.pathRules('wpp_1'),
  },
  {
    name: 'group types of a project',
    fn: api.weldpanelGroups.listGroupTypes,
    use: () => useWeldPanelGroupTypes('wpp_1'),
    args: ['wpp_1'],
    key: weldpanelAnalysisKeys.groupTypes('wpp_1'),
  },
  {
    name: "a group's profile",
    fn: api.weldpanelGroups.getGroup,
    use: () => useWeldPanelGroup('wpp_1', 'company', 'acme'),
    args: ['wpp_1', 'company', 'acme'],
    key: weldpanelAnalysisKeys.group('wpp_1', 'company', 'acme'),
  },
  {
    name: 'metric trees of a project',
    fn: api.weldpanelCollab.metricTrees.list,
    use: () => useWeldPanelMetricTrees({ projectId: 'wpp_1', scope: 'shared' }),
    args: [{ projectId: 'wpp_1', scope: 'shared' }],
    key: weldpanelAnalysisKeys.metricTreeList({ projectId: 'wpp_1', scope: 'shared' }),
  },
  {
    name: 'one metric tree',
    fn: api.weldpanelCollab.metricTrees.get,
    use: () => useWeldPanelMetricTree('pnmt_1'),
    args: ['pnmt_1'],
    key: weldpanelAnalysisKeys.metricTree('pnmt_1'),
  },
  {
    name: "a saved tree's values for the default period",
    fn: api.weldpanelAnalysis.metricTreeValues.get,
    use: () => useWeldPanelMetricTreeValues('pnmt_1'),
    args: ['pnmt_1', {}],
    key: weldpanelAnalysisKeys.metricTreeValues('pnmt_1', {}),
  },
  {
    name: 'values of unsaved nodes',
    fn: api.weldpanelAnalysis.metricTreeValues.preview,
    use: () => useWeldPanelMetricTreePreview(previewInput),
    args: [previewInput],
    key: weldpanelAnalysisKeys.metricTreePreview(previewInput),
  },
];

describe('queries', () => {
  it.each(queryCases)('$name: calls the client and answers its data under its key', async ({ fn, use, args, key }) => {
    const payload = [{ id: 'x_1' }];
    fn.mockResolvedValue({ data: payload });
    const { client, wrapper } = setup();
    const { result } = renderHook(use, { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(payload));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(...args);
    expect(client.getQueryCache().find({ queryKey: key, exact: true })).toBeDefined();
  });

  const waiting: { name: string; fn: Mock; use: () => unknown }[] = [
    { name: 'custom events without a project', fn: api.weldpanelCollab.customEvents.list, use: () => useWeldPanelCustomEvents('') },
    { name: 'computed properties when switched off', fn: api.weldpanelCollab.computedProperties.list, use: () => useWeldPanelComputedProperties('wpp_1', false) },
    { name: 'path rules without a project', fn: api.weldpanelCollab.pathRules.list, use: () => useWeldPanelPathRules('') },
    { name: 'group types without a project', fn: api.weldpanelGroups.listGroupTypes, use: () => useWeldPanelGroupTypes('') },
    { name: 'groups without a type', fn: api.weldpanelGroups.listGroups, use: () => useWeldPanelGroups({ projectId: 'wpp_1', type: '' }) },
    { name: 'a group without a key', fn: api.weldpanelGroups.getGroup, use: () => useWeldPanelGroup('wpp_1', 'company', '') },
    { name: 'metric trees without a project', fn: api.weldpanelCollab.metricTrees.list, use: () => useWeldPanelMetricTrees({ projectId: '' }) },
    { name: 'a metric tree without an id', fn: api.weldpanelCollab.metricTrees.get, use: () => useWeldPanelMetricTree('') },
    { name: 'tree values without an id', fn: api.weldpanelAnalysis.metricTreeValues.get, use: () => useWeldPanelMetricTreeValues('') },
    { name: 'a preview without a project', fn: api.weldpanelAnalysis.metricTreeValues.preview, use: () => useWeldPanelMetricTreePreview({ projectId: '', nodes }) },
  ];

  it.each(waiting)('$name: does not call the client', async ({ fn, use }) => {
    const { wrapper } = setup();
    renderHook(use, { wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fn).not.toHaveBeenCalled();
  });
});

interface MutationCase {
  name: string;
  fn: Mock;
  answer: unknown;
  use: () => () => Promise<unknown>;
  args: unknown[];
  invalidates: (readonly unknown[])[];
  removes?: (readonly unknown[])[];
  resolves?: unknown;
}

const tree = { id: 'pnmt_1', projectId: 'wpp_1', name: 'Revenue', nodes };

const mutationCases: MutationCase[] = [
  {
    name: 'renaming a custom event',
    fn: api.weldpanelCollab.customEvents.update,
    answer: { data: { id: 'pnce_1', projectId: 'wpp_1' } },
    use: () => {
      const m = useUpdateWeldPanelCustomEvent('wpp_1');
      return () => m.mutateAsync({ id: 'pnce_1', name: 'Activated' });
    },
    args: ['pnce_1', { name: 'Activated' }],
    invalidates: [weldpanelAnalysisKeys.customEvents('wpp_1'), weldpanelKeys.queries()],
    resolves: { id: 'pnce_1', projectId: 'wpp_1' },
  },
  {
    name: 'deleting a custom event',
    fn: api.weldpanelCollab.customEvents.remove,
    answer: undefined,
    use: () => {
      const m = useDeleteWeldPanelCustomEvent('wpp_1');
      return () => m.mutateAsync('pnce_1');
    },
    args: ['pnce_1'],
    invalidates: [weldpanelAnalysisKeys.customEvents('wpp_1'), weldpanelKeys.queries()],
  },
  {
    name: 'creating a computed property',
    fn: api.weldpanelCollab.computedProperties.create,
    answer: { data: { id: 'pncp_1', projectId: 'wpp_2' } },
    use: () => {
      const m = useCreateWeldPanelComputedProperty();
      return () => m.mutateAsync({ projectId: 'wpp_2', name: 'Revenue', definition: { kind: 'formula', expression: 'price * quantity' } });
    },
    args: [{ projectId: 'wpp_2', name: 'Revenue', definition: { kind: 'formula', expression: 'price * quantity' } }],
    invalidates: [weldpanelAnalysisKeys.computedProperties('wpp_2'), weldpanelKeys.queries()],
  },
  {
    name: 'changing a computed property',
    fn: api.weldpanelCollab.computedProperties.update,
    answer: { data: { id: 'pncp_1', projectId: 'wpp_1' } },
    use: () => {
      const m = useUpdateWeldPanelComputedProperty('wpp_1');
      return () => m.mutateAsync({ id: 'pncp_1', description: null });
    },
    args: ['pncp_1', { description: null }],
    invalidates: [weldpanelAnalysisKeys.computedProperties('wpp_1'), weldpanelKeys.queries()],
  },
  {
    name: 'deleting a computed property',
    fn: api.weldpanelCollab.computedProperties.remove,
    answer: undefined,
    use: () => {
      const m = useDeleteWeldPanelComputedProperty('wpp_1');
      return () => m.mutateAsync('pncp_1');
    },
    args: ['pncp_1'],
    invalidates: [weldpanelAnalysisKeys.computedProperties('wpp_1'), weldpanelKeys.queries()],
  },
  {
    name: 'replacing the path rules',
    fn: api.weldpanelCollab.pathRules.replace,
    answer: { data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } },
    use: () => {
      const m = useReplaceWeldPanelPathRules('wpp_1');
      return () => m.mutateAsync({ rules: [] });
    },
    args: ['wpp_1', { rules: [] }],
    invalidates: [weldpanelKeys.queries()],
  },
  {
    name: 'testing path rules on sample paths',
    fn: api.weldpanelCollab.pathRules.test,
    answer: { data: { results: [{ path: '/u/42', cleaned: '/u/:id' }] } },
    use: () => {
      const m = useTestWeldPanelPathRules();
      return () => m.mutateAsync({ projectId: 'wpp_1', paths: ['/u/42'] });
    },
    args: [{ projectId: 'wpp_1', paths: ['/u/42'] }],
    invalidates: [],
    resolves: [{ path: '/u/42', cleaned: '/u/:id' }],
  },
  {
    name: 'renaming a group type',
    fn: api.weldpanelGroups.updateGroupType,
    answer: { data: { id: 'pngt_1' } },
    use: () => {
      const m = useUpdateWeldPanelGroupType('wpp_1');
      return () => m.mutateAsync({ id: 'pngt_1', namePlural: 'Accounts', crmMatchProperty: 'domain' });
    },
    args: ['pngt_1', { namePlural: 'Accounts', crmMatchProperty: 'domain' }],
    invalidates: [weldpanelAnalysisKeys.groupTypes('wpp_1'), weldpanelAnalysisKeys.groups()],
    resolves: { id: 'pngt_1' },
  },
  {
    name: 'deleting a group type',
    fn: api.weldpanelGroups.deleteGroupType,
    answer: undefined,
    use: () => {
      const m = useDeleteWeldPanelGroupType('wpp_1');
      return () => m.mutateAsync('pngt_1');
    },
    args: ['pngt_1'],
    invalidates: [weldpanelAnalysisKeys.groupTypes('wpp_1')],
  },
  {
    name: 'creating a metric tree',
    fn: api.weldpanelCollab.metricTrees.create,
    answer: { data: tree },
    use: () => {
      const m = useCreateWeldPanelMetricTree();
      return () => m.mutateAsync({ projectId: 'wpp_1', name: 'Revenue', nodes });
    },
    args: [{ projectId: 'wpp_1', name: 'Revenue', nodes }],
    invalidates: [[...weldpanelAnalysisKeys.metricTrees(), 'list']],
    resolves: tree,
  },
  {
    name: 'deleting a metric tree',
    fn: api.weldpanelCollab.metricTrees.remove,
    answer: undefined,
    use: () => {
      const m = useDeleteWeldPanelMetricTree();
      return () => m.mutateAsync('pnmt_1');
    },
    args: ['pnmt_1'],
    invalidates: [[...weldpanelAnalysisKeys.metricTrees(), 'list']],
    removes: [weldpanelAnalysisKeys.metricTree('pnmt_1')],
  },
  {
    name: 'updating a metric tree',
    fn: api.weldpanelCollab.metricTrees.update,
    answer: { data: tree },
    use: () => {
      const m = useUpdateWeldPanelMetricTree('pnmt_1');
      return () => m.mutateAsync({ visibility: 'workspace' });
    },
    args: ['pnmt_1', { visibility: 'workspace' }],
    invalidates: [
      [...weldpanelAnalysisKeys.metricTree('pnmt_1'), 'values'],
      [...weldpanelAnalysisKeys.metricTrees(), 'list'],
    ],
  },
];

describe('mutations', () => {
  it.each(mutationCases)('$name: calls the client and refreshes what it changed', async ({ fn, answer, use, args, invalidates, removes, resolves }) => {
    fn.mockResolvedValue(answer);
    const { wrapper, invalidated, removed } = setup();
    const { result } = renderHook(use, { wrapper });
    let value: unknown;
    await act(async () => {
      value = await result.current();
    });
    expect(fn).toHaveBeenCalledWith(...args);
    expect(invalidated()).toEqual(invalidates);
    if (removes) expect(removed()).toEqual(removes);
    if (resolves !== undefined) expect(value).toEqual(resolves);
  });

  it('puts a created or updated metric tree in the cache', async () => {
    api.weldpanelCollab.metricTrees.create.mockResolvedValue({ data: tree });
    api.weldpanelCollab.metricTrees.update.mockResolvedValue({ data: { ...tree, name: 'Net revenue' } });
    const { client, wrapper } = setup();
    const { result: created } = renderHook(() => useCreateWeldPanelMetricTree(), { wrapper });
    await act(() => created.current.mutateAsync({ projectId: 'wpp_1', name: 'Revenue', nodes }));
    expect(client.getQueryData(weldpanelAnalysisKeys.metricTree('pnmt_1'))).toEqual({ data: tree });
    const { result: updated } = renderHook(() => useUpdateWeldPanelMetricTree('pnmt_1'), { wrapper });
    await act(() => updated.current.mutateAsync({ name: 'Net revenue' }));
    expect(client.getQueryData(weldpanelAnalysisKeys.metricTree('pnmt_1'))).toEqual({ data: { ...tree, name: 'Net revenue' } });
  });
});
