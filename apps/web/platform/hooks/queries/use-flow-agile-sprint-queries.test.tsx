import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  available: true,
  tasksApi: { listAllPages: vi.fn(), create: vi.fn() },
}));

vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => mocks.available }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ flowAgile: {} }) }));
vi.mock('@/app/weldflow/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/weldflow/lib/api-client')>()),
  tasksApi: mocks.tasksApi,
}));

import {
  isClosedStatus,
  useMakeRetroActionTask,
  useOpenBacklogPoints,
  useProjectItems,
  useSprintItems,
} from './use-flow-agile-sprint-queries';
import { agileKeys } from '@/hooks/queries/use-flow-agile-queries';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 1 }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.available = true;
});

describe('isClosedStatus', () => {
  it('counts finished statuses in any case and treats empty as open', () => {
    expect(isClosedStatus('Done')).toBe(true);
    expect(isClosedStatus('CANCELED')).toBe(true);
    expect(isClosedStatus('closed')).toBe(true);
    expect(isClosedStatus('in_progress')).toBe(false);
    expect(isClosedStatus(null)).toBe(false);
    expect(isClosedStatus(undefined)).toBe(false);
  });
});

describe('useSprintItems', () => {
  it('loads the items of a sprint', async () => {
    mocks.tasksApi.listAllPages.mockResolvedValue({ success: true, data: [{ id: 't1' }] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSprintItems('p1', 's1'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ id: 't1' }]));
    expect(mocks.tasksApi.listAllPages).toHaveBeenCalledWith('p1', { sprintId: 's1' });
  });

  it('shows the API error, or a generic one', async () => {
    mocks.tasksApi.listAllPages.mockResolvedValueOnce({ success: false, error: 'Nope' });
    const { wrapper } = setup();
    const first = renderHook(() => useSprintItems('p1', 's1'), { wrapper });
    await waitFor(() => expect(first.result.current.error?.message).toBe('Nope'));

    mocks.tasksApi.listAllPages.mockResolvedValueOnce({ success: false });
    const second = renderHook(() => useSprintItems('p1', 's2'), { wrapper });
    await waitFor(() => expect(second.result.current.error?.message).toBe('Failed to load items'));
  });

  it('waits for a sprint and for the feature', () => {
    const { wrapper } = setup();
    renderHook(() => useSprintItems('p1', null), { wrapper });
    renderHook(() => useSprintItems('p1', 's1', false), { wrapper });
    mocks.available = false;
    renderHook(() => useSprintItems('p1', 's1'), { wrapper });
    expect(mocks.tasksApi.listAllPages).not.toHaveBeenCalled();
  });
});

describe('useProjectItems and useOpenBacklogPoints', () => {
  const tasks = [
    { id: 'a', status: 'todo', storyPoints: 3 },
    { id: 'b', status: 'Done', storyPoints: 5 },
    { id: 'c', status: 'cancelled', storyPoints: 8 },
    { id: 'd', status: 'in_progress', storyPoints: null },
    { id: 'e', status: null },
  ];

  it('loads every item, optionally through a select', async () => {
    mocks.tasksApi.listAllPages.mockResolvedValue({ success: true, data: tasks });
    const { wrapper } = setup();
    const { result } = renderHook(() => useProjectItems('p1', true, (list) => list.length), { wrapper });
    await waitFor(() => expect(result.current.data).toBe(5));
    expect(mocks.tasksApi.listAllPages).toHaveBeenCalledWith('p1');
  });

  it('reports a failure', async () => {
    mocks.tasksApi.listAllPages.mockResolvedValue({ success: false, error: 'Bad' });
    const { wrapper } = setup();
    const { result } = renderHook(() => useProjectItems('p1'), { wrapper });
    await waitFor(() => expect(result.current.error?.message).toBe('Bad'));
  });

  it('sums the open and total points without cancelled items', async () => {
    mocks.tasksApi.listAllPages.mockResolvedValue({ success: true, data: tasks });
    const { wrapper } = setup();
    const { result } = renderHook(() => useOpenBacklogPoints('p1'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ open: 3, total: 8 }));
  });

  it('is off when disabled', () => {
    const { wrapper } = setup();
    renderHook(() => useOpenBacklogPoints('p1', false), { wrapper });
    expect(mocks.tasksApi.listAllPages).not.toHaveBeenCalled();
  });
});

describe('useMakeRetroActionTask', () => {
  it('creates a backlog task and refreshes the project and the task lists', async () => {
    mocks.tasksApi.create.mockResolvedValue({ success: true, data: { id: 'new' } });
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useMakeRetroActionTask('p1'), { wrapper });
    await act(async () => {
      expect(await result.current.mutateAsync('Fix CI')).toEqual({ id: 'new' });
    });
    expect(mocks.tasksApi.create).toHaveBeenCalledWith('p1', { title: 'Fix CI', type: 'task', sprintId: null });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: agileKeys.project('p1') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['task'] });
  });

  it('shows why the task could not be created', async () => {
    mocks.tasksApi.create.mockResolvedValue({ success: false });
    const { wrapper } = setup();
    const { result } = renderHook(() => useMakeRetroActionTask('p1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('x').catch(() => undefined);
    });
    await waitFor(() => expect(result.current.error?.message).toBe('Failed to create the task'));
  });
});
