import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({
  weldmerge: {
    issues: { list: vi.fn(), create: vi.fn(), links: { create: vi.fn(), remove: vi.fn() } },
    pullRequests: { list: vi.fn(), review: vi.fn(), comment: vi.fn() },
    releases: { list: vi.fn(), create: vi.fn(), ship: vi.fn() },
    recordLinks: { list: vi.fn() },
    chatSubscriptions: { list: vi.fn(), create: vi.fn() },
  },
  client: { get: vi.fn(), post: vi.fn() },
}));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApi: () => api,
  useAppApiClient: () => ({ getClient: async () => api.client }),
}));

import {
  sumMinutes,
  useCreateMergeRelease,
  useEscalateToMergeIssue,
  useLogMergeIssueTime,
  useMergeIssueTime,
  useMergeRecordLinks,
  useMergeShareSearch,
  useMergeReleases,
  useRemoveMergeIssueLink,
  weldmergeAcrossKeys,
} from './use-weldmerge-across-queries';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('weldmerge across query keys', () => {
  it('all sit under the realtime root', () => {
    const keys = [
      weldmergeAcrossKeys.releases(),
      weldmergeAcrossKeys.releaseList({ status: 'draft' }),
      weldmergeAcrossKeys.release('mrl_1'),
      weldmergeAcrossKeys.recordLinks('desk_ticket', 'tkt_1'),
      weldmergeAcrossKeys.issueTime('mis_1'),
      weldmergeAcrossKeys.chatSubscriptions(),
      weldmergeAcrossKeys.share('x'),
    ];
    for (const key of keys) expect(key[0]).toBe('weldmerge');
  });
});

describe('releases', () => {
  it('lists with the status filter and returns the rows', async () => {
    api.weldmerge.releases.list.mockResolvedValue({ data: [{ id: 'mrl_1' }], pagination: { totalCount: 1, hasMore: false, cursor: null } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useMergeReleases({ status: 'shipped' }), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ id: 'mrl_1' }]));
    expect(api.weldmerge.releases.list).toHaveBeenCalledWith({ limit: 100, status: 'shipped' });
  });

  it('creating one refetches the release lists and what tickets show as shipped', async () => {
    api.weldmerge.releases.create.mockResolvedValue({ data: { id: 'mrl_2' } });
    const { client, wrapper } = setup();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCreateMergeRelease(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ teamId: 'mtm_1', repositoryId: 'mrp_1', name: 'Spring' });
    });
    const keys = spy.mock.calls.map((call) => (call[0] as { queryKey: readonly unknown[] }).queryKey);
    expect(keys).toContainEqual(weldmergeAcrossKeys.releases());
    expect(keys).toContainEqual(['weldmerge', 'record-links']);
  });
});

describe('record links', () => {
  it('reads the issues linked to a ticket, and waits for an id', async () => {
    api.weldmerge.recordLinks.list.mockResolvedValue({ data: [{ link: { id: 'mrl_1' } }], pagination: {} });
    const { wrapper } = setup();
    const idle = renderHook(() => useMergeRecordLinks('desk_ticket', ''), { wrapper });
    expect(idle.result.current.fetchStatus).toBe('idle');
    const { result } = renderHook(() => useMergeRecordLinks('desk_ticket', 'tkt_1'), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(api.weldmerge.recordLinks.list).toHaveBeenCalledWith({ recordType: 'desk_ticket', recordId: 'tkt_1' });
  });

  it('removing a link refetches the issue and the records that show it', async () => {
    api.weldmerge.issues.links.remove.mockResolvedValue(undefined);
    const { client, wrapper } = setup();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useRemoveMergeIssueLink('mis_1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('mrl_9');
    });
    expect(api.weldmerge.issues.links.remove).toHaveBeenCalledWith('mis_1', 'mrl_9');
    const keys = spy.mock.calls.map((call) => (call[0] as { queryKey: readonly unknown[] }).queryKey);
    expect(keys).toContainEqual(['weldmerge', 'issues']);
    expect(keys).toContainEqual(['weldmerge', 'record-links']);
  });

  it('escalating creates the issue with the links it is given', async () => {
    api.weldmerge.issues.create.mockResolvedValue({ data: { id: 'mis_1', key: 'PLAT-1' } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useEscalateToMergeIssue(), { wrapper });
    const links = [{ recordType: 'desk_ticket' as const, recordId: 'tkt_1', title: 'Login broken' }];
    await act(async () => {
      await result.current.mutateAsync({ teamId: 'mtm_1', title: 'Login broken', links });
    });
    expect(api.weldmerge.issues.create).toHaveBeenCalledWith({ teamId: 'mtm_1', title: 'Login broken', links });
  });
});

describe('time on an issue', () => {
  it('reads the entries for the issue and sums the minutes', async () => {
    api.client.get.mockResolvedValue({ data: [{ id: 'a', date: '2026-11-01', duration: '90' }, { id: 'b', date: '2026-11-02', duration: 30 }] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useMergeIssueTime('mis_1'), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(api.client.get).toHaveBeenCalledWith('/time-entries?mergeIssueId=mis_1&limit=200');
    expect(sumMinutes(result.current.data ?? [])).toBe(120);
  });

  it('logs minutes against the issue and refetches its entries', async () => {
    api.client.post.mockResolvedValue({ data: { id: 'te_1' } });
    const { client, wrapper } = setup();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useLogMergeIssueTime(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ issueId: 'mis_1', minutes: 45, date: '2026-11-05', description: 'Investigated' });
    });
    expect(api.client.post).toHaveBeenCalledWith('/time-entries', {
      mergeIssueId: 'mis_1',
      date: '2026-11-05',
      duration: 45,
      description: 'Investigated',
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: weldmergeAcrossKeys.issueTime('mis_1') });
  });

  it('leaves the description out when there is none', async () => {
    api.client.post.mockResolvedValue({});
    const { wrapper } = setup();
    const { result } = renderHook(() => useLogMergeIssueTime(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ issueId: 'mis_1', minutes: 15, date: '2026-11-05', description: '' });
    });
    expect(api.client.post).toHaveBeenCalledWith('/time-entries', { mergeIssueId: 'mis_1', date: '2026-11-05', duration: 15 });
  });
});

describe('/merge search', () => {
  it('finds issues and open pull requests', async () => {
    api.weldmerge.issues.list.mockResolvedValue({ data: [{ id: 'mis_1', key: 'PLAT-209', title: 'Login slow' }] });
    api.weldmerge.pullRequests.list.mockResolvedValue({
      data: [{ id: 'mpr_1', repositoryFullName: 'acme/api', number: 12, title: 'Fix login' }],
    });
    const { wrapper } = setup();
    const { result } = renderHook(() => useMergeShareSearch('login'), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(result.current.data).toEqual([
      { type: 'issue', id: 'mis_1', key: 'PLAT-209', title: 'Login slow' },
      { type: 'pull_request', id: 'mpr_1', key: 'acme/api #12', title: 'Fix login' },
    ]);
    expect(api.weldmerge.pullRequests.list).toHaveBeenCalledWith({ q: 'login', view: 'open', limit: 5 });
  });

  it('does not search for nothing', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useMergeShareSearch('   '), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(api.weldmerge.issues.list).not.toHaveBeenCalled();
  });
});
