import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { makeAssignedIssue, makeReviewRequest } from '@/app/weldmerge/test-fixtures';

const api = vi.hoisted(() => ({
  weldmerge: {
    inbox: { list: vi.fn(), updateItem: vi.fn(), readAll: vi.fn() },
    accounts: { authorizeUrl: vi.fn(), unlink: vi.fn() },
    connections: { authorizeUrl: vi.fn() },
    oauth: { callback: vi.fn() },
    repositories: { importIssues: vi.fn() },
    issues: { external: { create: vi.fn(), remove: vi.fn() } },
  },
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));

import { weldmergeKeys } from './use-weldmerge-queries';
import {
  useCreateMergeExternalIssue,
  useImportMergeIssues,
  useMarkAllMergeInboxRead,
  useMergeAccountAuthorizeUrl,
  useMergeConnectionAuthorizeUrl,
  useMergeInboxView,
  useMergeOauthCallback,
  useUnlinkMergeAccount,
  useUpdateMergeInboxItem,
} from './use-weldmerge-sync-queries';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

describe('useMergeInboxView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists the live items for the active view', async () => {
    api.weldmerge.inbox.list.mockResolvedValue({ data: [makeReviewRequest()] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useMergeInboxView('active'), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(api.weldmerge.inbox.list).toHaveBeenCalledWith({});
  });

  it('keeps only items that still have a wake-up time in the snoozed view', async () => {
    api.weldmerge.inbox.list.mockResolvedValue({
      data: [makeReviewRequest(), makeAssignedIssue({ snoozedUntil: '2026-11-12T08:00:00.000Z' })],
    });
    const { wrapper } = setup();
    const { result } = renderHook(() => useMergeInboxView('snoozed'), { wrapper });
    await waitFor(() => expect(result.current.data?.map((item) => item.id)).toEqual(['assigned:mis_2']));
    expect(api.weldmerge.inbox.list).toHaveBeenCalledWith({ include: 'snoozed' });
  });

  it('is what include=archived adds to the live list in the archived view', async () => {
    api.weldmerge.inbox.list.mockImplementation(async (params: { include?: string }) =>
      params.include === 'archived' ? { data: [makeReviewRequest(), makeAssignedIssue()] } : { data: [makeReviewRequest()] },
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useMergeInboxView('archived'), { wrapper });
    await waitFor(() => expect(result.current.data?.map((item) => item.id)).toEqual(['assigned:mis_2']));
  });
});

describe('inbox mutations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates one item by its key and refreshes the inbox', async () => {
    api.weldmerge.inbox.updateItem.mockResolvedValue({
      data: { itemKey: 'assigned:mis_2', read: true, snoozedUntil: null, archived: false },
    });
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateMergeInboxItem(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ itemKey: 'assigned:mis_2', input: { read: true } });
    });
    expect(api.weldmerge.inbox.updateItem).toHaveBeenCalledWith('assigned:mis_2', { read: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: weldmergeKeys.inbox() });
  });

  it('marks everything read', async () => {
    api.weldmerge.inbox.readAll.mockResolvedValue({ data: { updated: 3 } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useMarkAllMergeInboxRead(), { wrapper });
    let updated = 0;
    await act(async () => {
      updated = (await result.current.mutateAsync()).updated;
    });
    expect(updated).toBe(3);
  });
});

describe('connections and accounts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks for the consent page of a workspace connection', async () => {
    api.weldmerge.connections.authorizeUrl.mockResolvedValue({ data: { url: 'https://gitlab.com/oauth/authorize' } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useMergeConnectionAuthorizeUrl(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ provider: 'gitlab', returnTo: '/settings/apps/weldmerge?tab=providers' });
    });
    expect(api.weldmerge.connections.authorizeUrl).toHaveBeenCalledWith('gitlab', '/settings/apps/weldmerge?tab=providers');
  });

  it('asks for the consent page of a member account link with its return path', async () => {
    api.weldmerge.accounts.authorizeUrl.mockResolvedValue({ data: { url: 'https://github.com/login/oauth/authorize' } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useMergeAccountAuthorizeUrl(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ provider: 'github', returnTo: '/settings/apps/weldmerge?tab=accounts' });
    });
    expect(api.weldmerge.accounts.authorizeUrl).toHaveBeenCalledWith('github', { returnTo: '/settings/apps/weldmerge?tab=accounts' });
  });

  it('unlinks an account, naming the self-managed host when there is one', async () => {
    api.weldmerge.accounts.unlink.mockResolvedValue(undefined);
    const { wrapper } = setup();
    const { result } = renderHook(() => useUnlinkMergeAccount(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ provider: 'gitlab', host: 'https://git.example.com' });
      await result.current.mutateAsync({ provider: 'github', host: null });
    });
    expect(api.weldmerge.accounts.unlink).toHaveBeenNthCalledWith(1, 'gitlab', 'https://git.example.com');
    expect(api.weldmerge.accounts.unlink).toHaveBeenNthCalledWith(2, 'github', undefined);
  });

  it('completes the OAuth round trip and refreshes connections and accounts', async () => {
    api.weldmerge.oauth.callback.mockResolvedValue({
      data: { purpose: 'connection', provider: 'gitlab', returnTo: null, connectionId: 'mcn_1', accountId: null },
    });
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useMergeOauthCallback(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ code: 'c', state: 's' });
    });
    expect(api.weldmerge.oauth.callback).toHaveBeenCalledWith({ code: 'c', state: 's' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: weldmergeKeys.connections() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: weldmergeKeys.accountsMe() });
  });
});

describe('issue sync', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates the issue on the chosen repository and refreshes issues', async () => {
    api.weldmerge.issues.external.create.mockResolvedValue({ data: { provider: 'github', number: 7 } });
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCreateMergeExternalIssue('mis_1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ repositoryId: 'mrp_1' });
    });
    expect(api.weldmerge.issues.external.create).toHaveBeenCalledWith('mis_1', { repositoryId: 'mrp_1' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: weldmergeKeys.issues() });
  });

  it('imports a repository and returns the counts', async () => {
    api.weldmerge.repositories.importIssues.mockResolvedValue({ data: { imported: 4, updated: 1, skipped: 0 } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useImportMergeIssues(), { wrapper });
    let counts = { imported: 0, updated: 0, skipped: 0 };
    await act(async () => {
      counts = await result.current.mutateAsync('mrp_1');
    });
    expect(counts).toEqual({ imported: 4, updated: 1, skipped: 0 });
    expect(api.weldmerge.repositories.importIssues).toHaveBeenCalledWith('mrp_1');
  });
});
