/**
 * The phase 2-7 hooks: every client method has a hook, query results narrow
 * to their kind and stay out of the persisted cache, the recordings and people
 * lists page, and each mutation refreshes what it changes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createWeldPanelApi } from '@weldsuite/app-api-client/domains/weldpanel';

const api = vi.hoisted(() => {
  const fns = (names: string[]) => Object.fromEntries(names.map((n) => [n, vi.fn()]));
  return {
    weldpanel: {
      keys: fns(['list', 'create', 'revoke']),
      query: fns(['run']),
      reports: fns(['list', 'get', 'create', 'update', 'remove']),
      dashboards: fns(['list', 'get', 'create', 'update', 'remove', 'addTile', 'updateTile', 'removeTile', 'setLayout']),
      cohorts: fns(['list', 'get', 'create', 'update', 'remove']),
      lexicon: fns(['get', 'update']),
      people: fns(['list', 'get', 'byEmail', 'erase']),
      sessions: fns(['list', 'get', 'chunk', 'chunkBytes', 'favorite', 'unfavorite', 'getSummary', 'summarise']),
      insights: fns(['summarise']),
      heatmaps: fns(['listPages', 'createPage', 'updatePage', 'removePage', 'data', 'snapshot']),
      live: fns(['get']),
      usage: fns(['get']),
    },
  };
});
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));

import {
  LIVE_POLL_MS,
  useAddWeldPanelDashboardTile,
  useCreateWeldPanelCohort,
  useCreateWeldPanelKey,
  useCreateWeldPanelReport,
  useDeleteWeldPanelReport,
  useEraseWeldPanelPerson,
  useFavoriteWeldPanelSession,
  useGenerateWeldPanelSessionSummary,
  useSetWeldPanelDashboardLayout,
  useSummariseWeldPanelSet,
  useUpdateWeldPanelHeatmapPage,
  useUpdateWeldPanelLexicon,
  useWeldPanelChunkLoader,
  useWeldPanelDashboard,
  useWeldPanelFunnel,
  useWeldPanelHeatmapPages,
  useWeldPanelLive,
  useWeldPanelPeople,
  useWeldPanelPeopleByEmail,
  useWeldPanelPerson,
  useWeldPanelQuery,
  useWeldPanelRecordings,
  useWeldPanelReports,
  useWeldPanelSessionSummary,
  useWeldPanelUsage,
  useWeldPanelWeb,
  weldpanelKeys,
} from './use-weldpanel-queries';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const invalidated = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);
  return { client, wrapper, invalidated };
}

beforeEach(() => {
  for (const domain of Object.values(api.weldpanel)) for (const fn of Object.values(domain)) (fn as ReturnType<typeof vi.fn>).mockReset();
});

const range = { preset: '30d' } as const;
const response = <K extends string>(kind: K, result: object) => ({ data: { kind, result, dataAsOf: '2026-11-14T12:00:00.000Z', cached: false } });

describe('every client method has a hook', () => {
  it('covers the whole weldpanel domain client', () => {
    // The real client's shape: a method added there without a hook here fails this list.
    const real = createWeldPanelApi({} as never);
    const methods = Object.entries(real).flatMap(([domain, group]) => Object.keys(group).map((name) => `${domain}.${name}`));
    const covered = [
      'projects.list', 'projects.get', 'projects.create', 'projects.update', 'projects.updateSettings', 'projects.remove', 'projects.rotateToken', 'projects.install',
      'keys.list', 'keys.create', 'keys.revoke',
      'query.run',
      'reports.list', 'reports.get', 'reports.create', 'reports.update', 'reports.remove',
      'dashboards.list', 'dashboards.get', 'dashboards.create', 'dashboards.update', 'dashboards.remove', 'dashboards.addTile', 'dashboards.updateTile', 'dashboards.removeTile', 'dashboards.setLayout',
      'cohorts.list', 'cohorts.get', 'cohorts.create', 'cohorts.update', 'cohorts.remove',
      'lexicon.get', 'lexicon.update',
      'people.list', 'people.get', 'people.byEmail', 'people.erase',
      'sessions.list', 'sessions.get', 'sessions.chunk', 'sessions.chunkBytes', 'sessions.favorite', 'sessions.unfavorite', 'sessions.getSummary', 'sessions.summarise',
      'insights.summarise',
      'heatmaps.listPages', 'heatmaps.createPage', 'heatmaps.updatePage', 'heatmaps.removePage', 'heatmaps.data', 'heatmaps.snapshot',
      'live.get', 'usage.get',
    ];
    expect(methods.sort()).toEqual([...covered].sort());
  });
});

describe('keys', () => {
  it('put every saved-object and query key under the module root', () => {
    const keys = [
      weldpanelKeys.query({ kind: 'web', projectId: 'p' }),
      weldpanelKeys.reportList({ projectId: 'p' }),
      weldpanelKeys.report('r'),
      weldpanelKeys.dashboard('d'),
      weldpanelKeys.cohortList('p'),
      weldpanelKeys.lexicon('p'),
      weldpanelKeys.person('p', 'u'),
      weldpanelKeys.session('p', 's'),
      weldpanelKeys.live('p'),
      weldpanelKeys.usage(),
      weldpanelKeys.secretKeys('p'),
    ];
    for (const key of keys) expect(key.slice(0, 1)).toEqual(weldpanelKeys.all);
  });

  it('keep the summary under its session and the keys under their project', () => {
    expect(weldpanelKeys.sessionSummary('p', 's').slice(0, weldpanelKeys.session('p', 's').length)).toEqual(weldpanelKeys.session('p', 's'));
    expect(weldpanelKeys.secretKeys('p').slice(0, weldpanelKeys.project('p').length)).toEqual(weldpanelKeys.project('p'));
  });

  it('give each distinct spec its own entry, under its kind', () => {
    const a = weldpanelKeys.query({ kind: 'web', projectId: 'p', dateRange: range });
    const b = weldpanelKeys.query({ kind: 'web', projectId: 'p', dateRange: { preset: '7d' } });
    expect(a).not.toEqual(b);
    expect(a.slice(0, weldpanelKeys.queriesOfKind('web').length)).toEqual(weldpanelKeys.queriesOfKind('web'));
  });
});

describe('queries', () => {
  it('runs any spec and keeps the result out of the persisted cache', async () => {
    api.weldpanel.query.run.mockResolvedValue(response('web', {}));
    const spec = { kind: 'web', projectId: 'pnp_1', dateRange: range } as const;
    const { wrapper, client } = setup();
    const { result } = renderHook(() => useWeldPanelQuery(spec), { wrapper });
    await waitFor(() => expect(result.current.data?.kind).toBe('web'));
    expect(api.weldpanel.query.run).toHaveBeenCalledWith(spec);
    expect(client.getQueryCache().find({ queryKey: weldpanelKeys.query(spec) })!.meta).toEqual({ persist: false });
  });

  it('narrows a kind hook to its result and says how fresh it is', async () => {
    api.weldpanel.query.run.mockResolvedValue(response('web', { totals: { visitors: 3 } }));
    const { wrapper } = setup();
    const { result } = renderHook(() => useWeldPanelWeb({ kind: 'web', projectId: 'pnp_1' }), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toEqual({ result: { totals: { visitors: 3 } }, dataAsOf: '2026-11-14T12:00:00.000Z', cached: false });
  });

  it('fails a kind hook that got another kind back, instead of showing the wrong shape', async () => {
    api.weldpanel.query.run.mockResolvedValue(response('trends', {}));
    const { wrapper } = setup();
    const { result } = renderHook(
      () => useWeldPanelFunnel({ kind: 'funnel', projectId: 'pnp_1', steps: [{ event: 'A' }, { event: 'B' }] }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(String(result.current.error)).toContain('Expected a funnel result');
  });

  it('does not run without a project or when disabled', () => {
    const { wrapper } = setup();
    renderHook(() => useWeldPanelQuery({ kind: 'web', projectId: '' }), { wrapper });
    renderHook(() => useWeldPanelQuery({ kind: 'web', projectId: 'p' }, { enabled: false }), { wrapper });
    expect(api.weldpanel.query.run).not.toHaveBeenCalled();
  });

  it('pages the recordings list by cursor and flattens the sessions', async () => {
    const session = (id: string) => ({ sessionId: id });
    api.weldpanel.sessions.list
      .mockResolvedValueOnce(response('sessions', { sessions: [session('a'), session('b')], hasMore: true, nextCursor: 'o2' }))
      .mockResolvedValueOnce(response('sessions', { sessions: [session('c')], hasMore: false, nextCursor: null }));
    const spec = { kind: 'sessions', projectId: 'pnp_1' } as const;
    const { wrapper } = setup();
    const { result } = renderHook(() => useWeldPanelRecordings(spec), { wrapper });

    await waitFor(() => expect(result.current.data?.sessions).toHaveLength(2));
    expect(api.weldpanel.sessions.list).toHaveBeenLastCalledWith({ ...spec, cursor: null });
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(api.weldpanel.sessions.list).toHaveBeenLastCalledWith({ ...spec, cursor: 'o2' });
    await waitFor(() => expect(result.current.data?.sessions.map((s) => s.sessionId)).toEqual(['a', 'b', 'c']));
    expect(result.current.hasNextPage).toBe(false);
  });

  it('pages the people list with the server cursor', async () => {
    api.weldpanel.people.list
      .mockResolvedValueOnce({ data: [{ userId: 'u1' }], pagination: { totalCount: 2, hasMore: true, cursor: 'c1' } })
      .mockResolvedValueOnce({ data: [{ userId: 'u2' }], pagination: { totalCount: 2, hasMore: false, cursor: null } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useWeldPanelPeople({ projectId: 'pnp_1', search: 'ann' }), { wrapper });
    await waitFor(() => expect(result.current.data?.people).toHaveLength(1));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(api.weldpanel.people.list).toHaveBeenLastCalledWith({ projectId: 'pnp_1', search: 'ann', cursor: 'c1' });
    await waitFor(() => expect(result.current.data).toEqual({ people: [{ userId: 'u1' }, { userId: 'u2' }], totalCount: 2 }));
  });

  it('looks up the CRM card by email only when there is one', async () => {
    api.weldpanel.people.byEmail.mockResolvedValue({ data: { people: [] } });
    const { wrapper } = setup();
    renderHook(() => useWeldPanelPeopleByEmail(null), { wrapper });
    renderHook(() => useWeldPanelPeopleByEmail('  '), { wrapper });
    expect(api.weldpanel.people.byEmail).not.toHaveBeenCalled();
    const { result } = renderHook(() => useWeldPanelPeopleByEmail(' Ann@Example.com '), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ people: [] }));
    expect(api.weldpanel.people.byEmail).toHaveBeenCalledWith('Ann@Example.com');
  });

  it('reads one list, one detail and the plain lookups as data', async () => {
    api.weldpanel.reports.list.mockResolvedValue({ data: [{ id: 'pnr_1' }], pagination: {} });
    api.weldpanel.dashboards.get.mockResolvedValue({ data: { id: 'pnd_1', tiles: [], reports: [] } });
    api.weldpanel.heatmaps.listPages.mockResolvedValue({ data: [{ id: 'pnh_1' }], pagination: {} });
    api.weldpanel.people.get.mockResolvedValue({ data: { person: { userId: 'u' } } });
    api.weldpanel.usage.get.mockResolvedValue({ data: { month: '2026-11' } });
    api.weldpanel.sessions.getSummary.mockResolvedValue({ data: null });
    const { wrapper } = setup();
    const reports = renderHook(() => useWeldPanelReports({ projectId: 'p' }), { wrapper });
    const dashboard = renderHook(() => useWeldPanelDashboard('pnd_1'), { wrapper });
    const pages = renderHook(() => useWeldPanelHeatmapPages('p'), { wrapper });
    const person = renderHook(() => useWeldPanelPerson('p', 'u'), { wrapper });
    const usage = renderHook(() => useWeldPanelUsage(), { wrapper });
    const summary = renderHook(() => useWeldPanelSessionSummary('p', 's'), { wrapper });
    await waitFor(() => expect(reports.result.current.data).toEqual([{ id: 'pnr_1' }]));
    await waitFor(() => expect(dashboard.result.current.data?.id).toBe('pnd_1'));
    await waitFor(() => expect(pages.result.current.data).toEqual([{ id: 'pnh_1' }]));
    await waitFor(() => expect(person.result.current.data?.person.userId).toBe('u'));
    await waitFor(() => expect(usage.result.current.data).toEqual({ month: '2026-11' }));
    await waitFor(() => expect(summary.result.current.data).toBeNull());
  });

  it('refreshes the live view every 15 seconds and keeps it out of storage', async () => {
    api.weldpanel.live.get.mockResolvedValue({ data: { projectId: 'p', visitors: 1, sessions: [] } });
    const { wrapper, client } = setup();
    renderHook(() => useWeldPanelLive('p'), { wrapper });
    const observer = client.getQueryCache().find({ queryKey: weldpanelKeys.live('p') })!.observers[0]!;
    expect(observer.options.refetchInterval).toBe(LIVE_POLL_MS);
    expect(LIVE_POLL_MS).toBe(15_000);
    expect(client.getQueryCache().find({ queryKey: weldpanelKeys.live('p') })!.meta).toEqual({ persist: false });
  });
});

describe('mutations', () => {
  it('creating a report stores it and refreshes the report lists', async () => {
    api.weldpanel.reports.create.mockResolvedValue({ data: { id: 'pnr_1', name: 'R' } });
    const { wrapper, client, invalidated } = setup();
    const { result } = renderHook(() => useCreateWeldPanelReport(), { wrapper });
    const input = { projectId: 'p', name: 'R', spec: { kind: 'web', projectId: 'p' } } as const;
    await result.current.mutateAsync(input);
    expect(api.weldpanel.reports.create).toHaveBeenCalledWith(input);
    expect(client.getQueryData(weldpanelKeys.report('pnr_1'))).toEqual({ data: { id: 'pnr_1', name: 'R' } });
    expect(invalidated()).toContainEqual([...weldpanelKeys.reports(), 'list']);
  });

  it('deleting a report drops it and refreshes the dashboards it was on', async () => {
    api.weldpanel.reports.remove.mockResolvedValue(undefined);
    const { wrapper, client, invalidated } = setup();
    client.setQueryData(weldpanelKeys.report('pnr_1'), { data: {} });
    const { result } = renderHook(() => useDeleteWeldPanelReport(), { wrapper });
    await result.current.mutateAsync('pnr_1');
    expect(client.getQueryData(weldpanelKeys.report('pnr_1'))).toBeUndefined();
    expect(invalidated()).toContainEqual(weldpanelKeys.dashboards());
  });

  it('adding a tile refreshes that dashboard, and a new layout replaces its detail', async () => {
    api.weldpanel.dashboards.addTile.mockResolvedValue({ data: { id: 'pnt_1' } });
    api.weldpanel.dashboards.setLayout.mockResolvedValue({ data: { id: 'pnd_1', tiles: [] } });
    const { wrapper, client, invalidated } = setup();
    const add = renderHook(() => useAddWeldPanelDashboardTile('pnd_1'), { wrapper });
    await add.result.current.mutateAsync({ reportId: 'pnr_1', layout: { x: 0, y: 0, w: 6, h: 4 } });
    expect(api.weldpanel.dashboards.addTile).toHaveBeenCalledWith('pnd_1', { reportId: 'pnr_1', layout: { x: 0, y: 0, w: 6, h: 4 } });
    expect(invalidated()).toContainEqual(weldpanelKeys.dashboard('pnd_1'));

    const layout = renderHook(() => useSetWeldPanelDashboardLayout('pnd_1'), { wrapper });
    await layout.result.current.mutateAsync({ tiles: [] });
    expect(client.getQueryData(weldpanelKeys.dashboard('pnd_1'))).toEqual({ data: { id: 'pnd_1', tiles: [] } });
  });

  it('creating a cohort refreshes the cohort lists', async () => {
    api.weldpanel.cohorts.create.mockResolvedValue({ data: { id: 'pnc_1' } });
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useCreateWeldPanelCohort(), { wrapper });
    await result.current.mutateAsync({ projectId: 'p', name: 'Pro', filter: { conditions: [{ type: 'person_property', key: 'plan', operator: 'eq', value: 'pro' }] } });
    expect(invalidated()).toContainEqual([...weldpanelKeys.cohorts(), 'list']);
  });

  it('updating the lexicon sends the project and refreshes it', async () => {
    api.weldpanel.lexicon.update.mockResolvedValue({ data: {} });
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useUpdateWeldPanelLexicon('pnp_1'), { wrapper });
    await result.current.mutateAsync({ kind: 'event', name: 'Signed up', verified: true });
    expect(api.weldpanel.lexicon.update).toHaveBeenCalledWith({ projectId: 'pnp_1', kind: 'event', name: 'Signed up', verified: true });
    expect(invalidated()).toContainEqual(weldpanelKeys.lexicon('pnp_1'));
  });

  it('erasing a person refreshes everything that could show them', async () => {
    api.weldpanel.people.erase.mockResolvedValue({ data: { userId: 'u', erasedIdCount: 2, recordingChunksDeleted: 5 } });
    const { wrapper, client, invalidated } = setup();
    client.setQueryData(weldpanelKeys.person('pnp_1', 'u'), { data: {} });
    const { result } = renderHook(() => useEraseWeldPanelPerson('pnp_1'), { wrapper });
    await expect(result.current.mutateAsync('u')).resolves.toMatchObject({ erasedIdCount: 2 });
    expect(api.weldpanel.people.erase).toHaveBeenCalledWith('pnp_1', 'u');
    expect(client.getQueryData(weldpanelKeys.person('pnp_1', 'u'))).toBeUndefined();
    expect(invalidated()).toEqual(
      expect.arrayContaining([weldpanelKeys.people(), weldpanelKeys.sessions(), weldpanelKeys.queriesOfKind('web'), weldpanelKeys.queriesOfKind('sessions')]),
    );
  });

  it('favouriting refreshes the session and the recordings lists', async () => {
    api.weldpanel.sessions.favorite.mockResolvedValue({ data: { id: 'pnf_1', sessionId: 's_1' } });
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useFavoriteWeldPanelSession('pnp_1'), { wrapper });
    await result.current.mutateAsync({ sessionId: 's_1', note: 'Odd checkout' });
    expect(api.weldpanel.sessions.favorite).toHaveBeenCalledWith('s_1', { projectId: 'pnp_1', note: 'Odd checkout' });
    expect(invalidated()).toEqual(expect.arrayContaining([weldpanelKeys.session('pnp_1', 's_1'), weldpanelKeys.queriesOfKind('sessions')]));
  });

  it('a generated summary replaces the cached one and surfaces a 402 to the caller', async () => {
    api.weldpanel.sessions.summarise.mockResolvedValueOnce({ data: { sessionId: 's_1', summary: { goal: 'Buy' }, cached: false, creditsCharged: 3 } });
    const { wrapper, client } = setup();
    const { result } = renderHook(() => useGenerateWeldPanelSessionSummary('pnp_1'), { wrapper });
    await result.current.mutateAsync({ sessionId: 's_1' });
    expect(api.weldpanel.sessions.summarise).toHaveBeenCalledWith('s_1', { projectId: 'pnp_1', regenerate: undefined });
    expect(client.getQueryData<{ data: { summary: { goal: string } } }>(weldpanelKeys.sessionSummary('pnp_1', 's_1'))?.data.summary.goal).toBe('Buy');

    const payment = Object.assign(new Error('insufficient credits'), { status: 402 });
    api.weldpanel.sessions.summarise.mockRejectedValueOnce(payment);
    await expect(result.current.mutateAsync({ sessionId: 's_2' })).rejects.toBe(payment);
  });

  it('summarising a set returns the themes', async () => {
    api.weldpanel.insights.summarise.mockResolvedValue({ data: { summary: { themes: [] }, creditsCharged: 12, cached: false } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSummariseWeldPanelSet(), { wrapper });
    const input = { projectId: 'p', source: { type: 'sessions', spec: { kind: 'sessions', projectId: 'p' } } } as const;
    await expect(result.current.mutateAsync(input)).resolves.toMatchObject({ creditsCharged: 12 });
    expect(api.weldpanel.insights.summarise).toHaveBeenCalledWith(input);
  });

  it('changing a page group refreshes its list and the heatmaps built on it', async () => {
    api.weldpanel.heatmaps.updatePage.mockResolvedValue({ data: { id: 'pnh_1' } });
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useUpdateWeldPanelHeatmapPage('pnp_1'), { wrapper });
    await result.current.mutateAsync({ id: 'pnh_1', urlPattern: '/shop/*' });
    expect(api.weldpanel.heatmaps.updatePage).toHaveBeenCalledWith('pnh_1', { urlPattern: '/shop/*' });
    expect(invalidated()).toEqual(expect.arrayContaining([weldpanelKeys.heatmapPages('pnp_1'), weldpanelKeys.queriesOfKind('heatmap')]));
  });

  it('creating a secret key refreshes the key list; the key itself is only in the result', async () => {
    api.weldpanel.keys.create.mockResolvedValue({ data: { id: 'pnk_1', key: 'wps_abc' } });
    const { wrapper, client, invalidated } = setup();
    const { result } = renderHook(() => useCreateWeldPanelKey('pnp_1'), { wrapper });
    await expect(result.current.mutateAsync({ name: 'Server' })).resolves.toMatchObject({ key: 'wps_abc' });
    expect(api.weldpanel.keys.create).toHaveBeenCalledWith('pnp_1', { name: 'Server' });
    expect(invalidated()).toContainEqual(weldpanelKeys.secretKeys('pnp_1'));
    expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain('wps_abc');
  });

  it('loads chunk bytes through the client', async () => {
    const bytes = new ArrayBuffer(4);
    api.weldpanel.sessions.chunkBytes.mockResolvedValue(bytes);
    const { wrapper } = setup();
    const { result } = renderHook(() => useWeldPanelChunkLoader(), { wrapper });
    await expect(result.current('pnp_1', 's_1', 2)).resolves.toBe(bytes);
    expect(api.weldpanel.sessions.chunkBytes).toHaveBeenCalledWith('pnp_1', 's_1', 2);
  });
});
