import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  available: true,
  project: { data: undefined as unknown, isLoading: false },
  listControlLinks: vi.fn(),
  tasksApi: {
    listAllPages: vi.fn(),
    reorderTasks: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApi: () => ({ flowAgile: {}, projectControl: { listControlLinks: mocks.listControlLinks } }),
}));
vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => mocks.available }));
vi.mock('@/hooks/queries/use-projects-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/queries/use-projects-queries')>()),
  useProject: () => mocks.project,
}));
vi.mock('@/app/weldflow/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/weldflow/lib/api-client')>()),
  tasksApi: mocks.tasksApi,
}));

import {
  agileBacklogKeys,
  useBacklogItems,
  useCreateItem,
  useDeleteItems,
  useEpicItems,
  useEpicLinks,
  useReorderItems,
} from './use-flow-agile-backlog-queries';
import { agileKeys } from '@/hooks/queries/use-flow-agile-queries';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 1 }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

const TASK = { id: 't1', number: 1, title: 'Login', type: 'story', status: 'todo', priority: 'high', storyPoints: 3 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.available = true;
  mocks.project = { data: { data: { settings: { delivery: { approach: 'scrum' } } } }, isLoading: false };
});

describe('agileBacklogKeys', () => {
  it('sit under the project agile root', () => {
    expect(agileBacklogKeys.items('p1').slice(0, 3)).toEqual(agileKeys.root('p1'));
    expect(agileBacklogKeys.epicItems('p1', 'e1')).toContain('e1');
    expect(agileBacklogKeys.epicLinks('p1', 'e1')).toContain('epic-links');
  });
});

describe('useBacklogItems', () => {
  it('loads every task of the project as a backlog row', async () => {
    mocks.tasksApi.listAllPages.mockResolvedValue({ success: true, data: [TASK] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useBacklogItems('p1'), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data?.[0]).toMatchObject({ id: 't1', title: 'Login', storyPoints: 3 });
    expect(mocks.tasksApi.listAllPages).toHaveBeenCalledWith('p1');
  });

  it('shows the task API error', async () => {
    mocks.tasksApi.listAllPages.mockResolvedValue({ success: false, error: 'Broken' });
    const { wrapper } = setup();
    const { result } = renderHook(() => useBacklogItems('p1'), { wrapper });
    await waitFor(() => expect((result.current.error as Error | null)?.message).toBe('Broken'));
  });

  it('falls back to a generic message when the envelope has none', async () => {
    mocks.tasksApi.listAllPages.mockResolvedValue({ success: true });
    const { wrapper } = setup();
    const { result } = renderHook(() => useBacklogItems('p1'), { wrapper });
    await waitFor(() => expect((result.current.error as Error | null)?.message).toBe('Failed to load the backlog'));
  });

  it('is off when disabled or where the edition has no agile delivery', () => {
    const { wrapper } = setup();
    renderHook(() => useBacklogItems('p1', false), { wrapper });
    mocks.available = false;
    renderHook(() => useBacklogItems('p1'), { wrapper });
    expect(mocks.tasksApi.listAllPages).not.toHaveBeenCalled();
  });
});

describe('useEpicItems', () => {
  it('loads the items of one epic', async () => {
    mocks.tasksApi.listAllPages.mockResolvedValue({ success: true, data: [TASK] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useEpicItems('p1', 'e1'), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(mocks.tasksApi.listAllPages).toHaveBeenCalledWith('p1', { epicId: 'e1' });
  });

  it('reports a failure to load the epic', async () => {
    mocks.tasksApi.listAllPages.mockResolvedValue({ success: false });
    const { wrapper } = setup();
    const { result } = renderHook(() => useEpicItems('p1', 'e1'), { wrapper });
    await waitFor(() => expect((result.current.error as Error | null)?.message).toBe('Failed to load the epic'));
  });

  it('waits for an epic id', () => {
    const { wrapper } = setup();
    renderHook(() => useEpicItems('p1', ''), { wrapper });
    expect(mocks.tasksApi.listAllPages).not.toHaveBeenCalled();
  });
});

describe('useEpicLinks', () => {
  it('merges both ends of a link, drops duplicates and keeps RAID items and milestones', async () => {
    const raid = { id: 'l1', target: { type: 'raid_item', id: 'r1' } };
    const milestone = { id: 'l2', target: { type: 'milestone', id: 'm1' } };
    const other = { id: 'l3', target: { type: 'task', id: 'x' } };
    mocks.listControlLinks.mockImplementation(async (params: { from?: unknown; to?: unknown }) =>
      params.from ? { data: [raid, other] } : { data: [raid, milestone] },
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useEpicLinks('p1', 'e1'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([raid, milestone]));
    expect(mocks.listControlLinks).toHaveBeenCalledWith({ from: { type: 'task', id: 'e1' } });
    expect(mocks.listControlLinks).toHaveBeenCalledWith({ to: { type: 'task', id: 'e1' } });
  });

  it('waits for an epic id', () => {
    const { wrapper } = setup();
    renderHook(() => useEpicLinks('p1', ''), { wrapper });
    expect(mocks.listControlLinks).not.toHaveBeenCalled();
  });
});

describe('mutations', () => {
  it('saves an order and refreshes the project', async () => {
    mocks.tasksApi.reorderTasks.mockResolvedValue({ success: true, data: [] });
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useReorderItems('p1'), { wrapper });
    await act(() => result.current.mutateAsync(['b', 'a']));
    expect(mocks.tasksApi.reorderTasks).toHaveBeenCalledWith('p1', ['b', 'a']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: agileKeys.project('p1') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['task'] });
  });

  it('fails an order the API refused, and still refreshes', async () => {
    mocks.tasksApi.reorderTasks.mockResolvedValue({ success: false });
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useReorderItems('p1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(['a']).catch(() => undefined);
    });
    await waitFor(() => expect((result.current.error as Error | null)?.message).toBe('Failed to reorder'));
    expect(invalidate).toHaveBeenCalled();
  });

  it('creates an item with its type, sprint and epic', async () => {
    mocks.tasksApi.create.mockResolvedValue({ success: true, data: { id: 'new' } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useCreateItem('p1'), { wrapper });
    await act(() => result.current.mutateAsync({ title: 'A', type: 'bug', sprintId: 's1', epicId: null }));
    expect(mocks.tasksApi.create).toHaveBeenCalledWith('p1', {
      title: 'A',
      type: 'bug',
      sprintId: 's1',
      epicId: undefined,
    });
  });

  it('shows why an item could not be created', async () => {
    mocks.tasksApi.create.mockResolvedValue({ success: false, error: 'Too many' });
    const { wrapper } = setup();
    const { result } = renderHook(() => useCreateItem('p1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ title: 'A' }).catch(() => undefined);
    });
    await waitFor(() => expect((result.current.error as Error | null)?.message).toBe('Too many'));
  });

  it('deletes items one after the other and stops at the first failure', async () => {
    mocks.tasksApi.delete.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
    const { wrapper } = setup();
    const { result } = renderHook(() => useDeleteItems('p1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(['a', 'b', 'c']).catch(() => undefined);
    });
    expect(mocks.tasksApi.delete.mock.calls).toEqual([
      ['p1', 'a'],
      ['p1', 'b'],
    ]);
    await waitFor(() => expect((result.current.error as Error | null)?.message).toBe('Failed to delete'));
  });

  it('deletes every item when all go through', async () => {
    mocks.tasksApi.delete.mockResolvedValue({ success: true });
    const { wrapper } = setup();
    const { result } = renderHook(() => useDeleteItems('p1'), { wrapper });
    await act(() => result.current.mutateAsync(['a', 'b']));
    expect(mocks.tasksApi.delete).toHaveBeenCalledTimes(2);
  });
});
