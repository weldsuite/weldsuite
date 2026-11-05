import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { MergeIssueDto } from '@weldsuite/app-api-client/schemas/weldmerge';

const api = vi.hoisted(() => ({
  weldmerge: {
    issues: { list: vi.fn(), update: vi.fn() },
    inbox: { list: vi.fn() },
  },
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));

import { applyIssueUpdate, useMergeIssues, useMoveMergeIssue, weldmergeKeys } from './use-weldmerge-queries';

function makeIssue(overrides: Partial<MergeIssueDto> = {}): MergeIssueDto {
  return {
    id: 'mis_1',
    teamId: 'mtm_1',
    teamKey: 'PLAT',
    number: 1,
    key: 'PLAT-1',
    title: 'One',
    description: null,
    status: 'todo',
    priority: 0,
    assigneeUserId: null,
    creatorUserId: 'user_1',
    cycleId: null,
    parentIssueId: null,
    labelIds: [],
    estimate: null,
    dueDate: null,
    flowProjectId: null,
    agentId: null,
    sortOrder: 0,
    pullRequestCount: 0,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

describe('weldmerge query keys', () => {
  it('all sit under the realtime root', () => {
    const keys = [
      weldmergeKeys.teams(),
      weldmergeKeys.labels('t'),
      weldmergeKeys.cycles(),
      weldmergeKeys.issueList({ teamId: 't' }),
      weldmergeKeys.issue('PLAT-1'),
      weldmergeKeys.comments('i'),
      weldmergeKeys.pullRequestList({ view: 'open' }),
      weldmergeKeys.pullRequest('p'),
      weldmergeKeys.inbox(),
      weldmergeKeys.connections(),
      weldmergeKeys.repositories(),
      weldmergeKeys.accountsMe(),
    ];
    for (const key of keys) expect(key[0]).toBe('weldmerge');
  });
});

describe('applyIssueUpdate', () => {
  it('applies the changed fields and keeps the rest', () => {
    const next = applyIssueUpdate(makeIssue(), { status: 'done', sortOrder: 4, assigneeUserId: undefined });
    expect(next.status).toBe('done');
    expect(next.sortOrder).toBe(4);
    expect(next.assigneeUserId).toBeNull();
  });
});

describe('useMergeIssues', () => {
  beforeEach(() => vi.clearAllMocks());

  it('follows cursor pages until the list ends', async () => {
    api.weldmerge.issues.list
      .mockResolvedValueOnce({ data: [makeIssue({ id: 'a' })], pagination: { totalCount: 2, hasMore: true, cursor: 'c1' } })
      .mockResolvedValueOnce({ data: [makeIssue({ id: 'b' })], pagination: { totalCount: 2, hasMore: false, cursor: null } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useMergeIssues({ teamId: 'mtm_1' }), { wrapper });
    await waitFor(() => expect(result.current.data?.map((i) => i.id)).toEqual(['a', 'b']));
    expect(api.weldmerge.issues.list).toHaveBeenNthCalledWith(2, { teamId: 'mtm_1', limit: 200, cursor: 'c1' });
  });
});

describe('useMoveMergeIssue', () => {
  beforeEach(() => vi.clearAllMocks());

  const listKey = weldmergeKeys.issueList({ teamId: 'mtm_1' });

  it('updates the cached lists at once and writes status and order', async () => {
    api.weldmerge.issues.update.mockResolvedValue({ data: makeIssue() });
    const { client, wrapper } = setup();
    client.setQueryData(listKey, [makeIssue({ id: 'a' }), makeIssue({ id: 'b', sortOrder: 5 })]);
    const { result } = renderHook(() => useMoveMergeIssue(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        issueId: 'a',
        status: 'in_review',
        patches: [
          { id: 'a', sortOrder: 2048 },
          { id: 'b', sortOrder: 1024 },
        ],
      });
    });

    expect(api.weldmerge.issues.update).toHaveBeenCalledWith('a', { status: 'in_review', sortOrder: 2048 });
    expect(api.weldmerge.issues.update).toHaveBeenCalledWith('b', { sortOrder: 1024 });
  });

  it('rolls the cache back when a write fails', async () => {
    api.weldmerge.issues.update.mockRejectedValue(new Error('boom'));
    const { client, wrapper } = setup();
    const original = [makeIssue({ id: 'a', status: 'todo', sortOrder: 1 })];
    client.setQueryData(listKey, original);
    const { result } = renderHook(() => useMoveMergeIssue(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ issueId: 'a', status: 'done', patches: [{ id: 'a', sortOrder: 9 }] }).catch(() => undefined);
    });

    const cached = client.getQueryData<MergeIssueDto[]>(listKey);
    expect(cached?.[0]).toMatchObject({ status: 'todo', sortOrder: 1 });
  });

  it('shows the move in the cache before the write settles', async () => {
    let release: (value: unknown) => void = () => undefined;
    api.weldmerge.issues.update.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const { client, wrapper } = setup();
    client.setQueryData(listKey, [makeIssue({ id: 'a', status: 'todo' })]);
    const { result } = renderHook(() => useMoveMergeIssue(), { wrapper });

    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.mutateAsync({ issueId: 'a', status: 'done', patches: [{ id: 'a', sortOrder: 3 }] });
    });
    await waitFor(() => expect(client.getQueryData<MergeIssueDto[]>(listKey)?.[0]).toMatchObject({ status: 'done', sortOrder: 3 }));

    release({ data: makeIssue() });
    await act(async () => {
      await pending;
    });
  });
});
