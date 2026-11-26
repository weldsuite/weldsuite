import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@weldsuite/api-client';

const mocks = vi.hoisted(() => ({
  available: true,
  project: { data: undefined as unknown, isLoading: false },
  flowAgile: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ flowAgile: mocks.flowAgile }) }));
vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => mocks.available }));
vi.mock('@/hooks/queries/use-projects-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/queries/use-projects-queries')>()),
  useProject: () => mocks.project,
}));

import {
  agileKeys,
  isAgileAvailable,
  useBulkUpdateTaskAgile,
  useCompleteSprint,
  useCreateRetroCard,
  useCreateSprint,
  useDeleteRetroCard,
  useDeleteSprint,
  useProjectDelivery,
  useProjectEpics,
  useProjectSprints,
  useRetroCards,
  useSprint,
  useSprintReport,
  useStartSprint,
  useUpdateProjectDelivery,
  useUpdateRetroCard,
  useUpdateSprint,
  useUpdateTaskAgile,
  useVoteRetroCard,
} from './use-flow-agile-queries';
import { projectKeys } from '@/hooks/queries/use-projects-queries';

const METHODS = [
  'listSprints',
  'getSprint',
  'getSprintReport',
  'createSprint',
  'updateSprint',
  'deleteSprint',
  'startSprint',
  'completeSprint',
  'listEpics',
  'updateTaskAgile',
  'updateDelivery',
  'listRetroCards',
  'createRetroCard',
  'updateRetroCard',
  'deleteRetroCard',
  'voteRetroCard',
  'unvoteRetroCard',
];

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

beforeEach(() => {
  mocks.available = true;
  mocks.project = { data: undefined, isLoading: false };
  mocks.flowAgile = Object.fromEntries(METHODS.map((m) => [m, vi.fn().mockResolvedValue({ data: `${m} result` })]));
});

describe('isAgileAvailable', () => {
  it('follows the edition feature', () => {
    expect(isAgileAvailable()).toBe(true);
    mocks.available = false;
    expect(isAgileAvailable()).toBe(false);
  });
});

describe('useProjectDelivery', () => {
  it('reads a project without delivery settings as a task list', () => {
    mocks.project = { data: { data: { settings: {} } }, isLoading: true };
    const { wrapper } = setup();
    const { result } = renderHook(() => useProjectDelivery('p1'), { wrapper });
    expect(result.current.approach).toBe('tasklist');
    expect(result.current.isAgile).toBe(false);
    expect(result.current.isLoading).toBe(true);
  });

  it('reads the stored approach and its defaults', () => {
    mocks.project = { data: { data: { settings: { delivery: { approach: 'scrum' } } } }, isLoading: false };
    const { wrapper } = setup();
    const { result } = renderHook(() => useProjectDelivery('p1'), { wrapper });
    expect(result.current.approach).toBe('scrum');
    expect(result.current.usesSprints).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it('is a task list where the edition has no agile delivery', () => {
    mocks.available = false;
    mocks.project = { data: { data: { settings: { delivery: { approach: 'scrum' } } } }, isLoading: false };
    const { wrapper } = setup();
    const { result } = renderHook(() => useProjectDelivery('p1'), { wrapper });
    expect(result.current.approach).toBe('tasklist');
    expect(result.current.available).toBe(false);
  });
});

describe('useUpdateProjectDelivery', () => {
  const key = projectKeys.detail('p1');
  const detail = { data: { id: 'p1', settings: { other: 1, delivery: { approach: 'tasklist' } } } };

  it('shows the new setting at once and then takes the saved one', async () => {
    const { client, wrapper } = setup();
    client.setQueryData(key, detail);
    const saved = { approach: 'scrum', sprintLengthDays: 14 };
    let release: (value: unknown) => void = () => undefined;
    mocks.flowAgile.updateDelivery.mockReturnValue(new Promise((resolve) => (release = resolve)));

    const { result } = renderHook(() => useUpdateProjectDelivery('p1'), { wrapper });
    act(() => result.current.mutate({ approach: 'scrum' }));

    await waitFor(() =>
      expect((client.getQueryData(key) as typeof detail).data.settings.delivery).toEqual({ approach: 'scrum' }),
    );
    expect((client.getQueryData(key) as typeof detail).data.settings).toMatchObject({ other: 1 });

    release({ data: saved });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.flowAgile.updateDelivery).toHaveBeenCalledWith('p1', { approach: 'scrum' });
    expect((client.getQueryData(key) as typeof detail).data.settings.delivery).toEqual(saved);
  });

  it('rolls the project back when the save fails', async () => {
    const { client, wrapper } = setup();
    client.setQueryData(key, detail);
    mocks.flowAgile.updateDelivery.mockRejectedValue(new Error('nope'));

    const { result } = renderHook(() => useUpdateProjectDelivery('p1'), { wrapper });
    act(() => result.current.mutate({ approach: 'kanban' }));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(key)).toEqual(detail);
  });

  it('leaves an unloaded project alone and ignores an empty answer', async () => {
    const { client, wrapper } = setup();
    mocks.flowAgile.updateDelivery.mockResolvedValue({});
    const { result } = renderHook(() => useUpdateProjectDelivery('p1'), { wrapper });
    await act(() => result.current.mutateAsync({ approach: 'scrum' }));
    expect(client.getQueryData(key)).toBeUndefined();
  });

  it('does not restore anything when there was nothing to roll back', async () => {
    const { client, wrapper } = setup();
    mocks.flowAgile.updateDelivery.mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => useUpdateProjectDelivery('p1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ approach: 'scrum' }).catch(() => undefined);
    });
    expect(client.getQueryData(key)).toBeUndefined();
  });
});

describe('sprint queries', () => {
  it('lists the sprints of the project and selects the rows', async () => {
    mocks.flowAgile.listSprints.mockResolvedValue({ data: [{ id: 's1' }] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useProjectSprints('p1'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ id: 's1' }]));
    expect(mocks.flowAgile.listSprints).toHaveBeenCalledWith({ projectId: 'p1', limit: 100 });
  });

  it('asks nothing when disabled, without a project or without the feature', () => {
    const { wrapper } = setup();
    renderHook(() => useProjectSprints('p1', false), { wrapper });
    renderHook(() => useProjectSprints('', true), { wrapper });
    mocks.available = false;
    renderHook(() => useProjectSprints('p1'), { wrapper });
    renderHook(() => useSprint('p1', 's1'), { wrapper });
    renderHook(() => useSprintReport('p1', 's1'), { wrapper });
    renderHook(() => useProjectEpics('p1'), { wrapper });
    renderHook(() => useRetroCards('p1', 's1'), { wrapper });
    expect(mocks.flowAgile.listSprints).not.toHaveBeenCalled();
    expect(mocks.flowAgile.getSprint).not.toHaveBeenCalled();
    expect(mocks.flowAgile.getSprintReport).not.toHaveBeenCalled();
    expect(mocks.flowAgile.listEpics).not.toHaveBeenCalled();
    expect(mocks.flowAgile.listRetroCards).not.toHaveBeenCalled();
  });

  it('reads one sprint', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useSprint('p1', 's1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBe('getSprint result'));
    expect(mocks.flowAgile.getSprint).toHaveBeenCalledWith('s1');
  });

  it('reads the report of a sprint and waits for a sprint id', async () => {
    const { wrapper } = setup();
    const idle = renderHook(() => useSprintReport('p1', null), { wrapper });
    expect(idle.result.current.fetchStatus).toBe('idle');
    const { result } = renderHook(() => useSprintReport('p1', 's1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBe('getSprintReport result'));
    expect(mocks.flowAgile.getSprintReport).toHaveBeenCalledWith('s1');
  });

  it('reads the epics', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useProjectEpics('p1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBe('listEpics result'));
    expect(mocks.flowAgile.listEpics).toHaveBeenCalledWith('p1');
  });

  it('does not retry a client error but retries a server error', async () => {
    const { client } = setup();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } })}>
        {children}
      </QueryClientProvider>
    );
    void client;
    mocks.flowAgile.getSprint.mockRejectedValue(new ApiError('forbidden', 403));
    const denied = renderHook(() => useSprint('p1', 's1'), { wrapper });
    await waitFor(() => expect(denied.result.current.isError).toBe(true));
    expect(mocks.flowAgile.getSprint).toHaveBeenCalledTimes(1);

    mocks.flowAgile.getSprintReport.mockRejectedValueOnce(new ApiError('boom', 500)).mockResolvedValue({ data: 'ok' });
    const flaky = renderHook(() => useSprintReport('p1', 's2'), { wrapper });
    await waitFor(() => expect(flaky.result.current.data).toBe('ok'));
    expect(mocks.flowAgile.getSprintReport).toHaveBeenCalledTimes(2);
  });
});

describe('sprint and task mutations', () => {
  it('calls the api and refreshes the project, the task lists and the task panel', async () => {
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const create = renderHook(() => useCreateSprint('p1'), { wrapper });
    await act(() => create.result.current.mutateAsync({ name: 'Sprint 1' }));
    expect(mocks.flowAgile.createSprint).toHaveBeenCalledWith({ name: 'Sprint 1', projectId: 'p1' });
    const keys = invalidate.mock.calls.map(([filter]) => filter?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([agileKeys.project('p1'), ['task'], ['app-api', 'task-panel']]),
    );

    const update = renderHook(() => useUpdateSprint('p1'), { wrapper });
    await act(() => update.result.current.mutateAsync({ id: 's1', input: { goal: 'g' } }));
    expect(mocks.flowAgile.updateSprint).toHaveBeenCalledWith('s1', { goal: 'g' });

    const del = renderHook(() => useDeleteSprint('p1'), { wrapper });
    await act(() => del.result.current.mutateAsync('s1'));
    expect(mocks.flowAgile.deleteSprint).toHaveBeenCalledWith('s1');

    const start = renderHook(() => useStartSprint('p1'), { wrapper });
    await act(() => start.result.current.mutateAsync({ id: 's1', input: { goal: 'go' } }));
    expect(mocks.flowAgile.startSprint).toHaveBeenCalledWith('s1', { goal: 'go' });

    const complete = renderHook(() => useCompleteSprint('p1'), { wrapper });
    await act(() => complete.result.current.mutateAsync({ id: 's1', input: { moveTo: 'next' } }));
    expect(mocks.flowAgile.completeSprint).toHaveBeenCalledWith('s1', { moveTo: 'next' });

    const task = renderHook(() => useUpdateTaskAgile('p1'), { wrapper });
    await act(() => task.result.current.mutateAsync({ taskId: 't1', input: { type: 'bug' } }));
    expect(mocks.flowAgile.updateTaskAgile).toHaveBeenCalledWith('t1', { type: 'bug' });
  });

  it('updates several tasks in order and refreshes even when one fails', async () => {
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useBulkUpdateTaskAgile('p1'), { wrapper });

    await act(() => result.current.mutateAsync({ taskIds: ['a', 'b'], input: { sprintId: 's1' } }));
    expect(mocks.flowAgile.updateTaskAgile.mock.calls).toEqual([
      ['a', { sprintId: 's1' }],
      ['b', { sprintId: 's1' }],
    ]);

    mocks.flowAgile.updateTaskAgile.mockReset().mockRejectedValue(new Error('x'));
    invalidate.mockClear();
    await act(async () => {
      await result.current.mutateAsync({ taskIds: ['a', 'b'], input: {} }).catch(() => undefined);
    });
    expect(mocks.flowAgile.updateTaskAgile).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalled();
  });
});

describe('retros', () => {
  it('lists the cards of a sprint', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useRetroCards('p1', 's1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBe('listRetroCards result'));
    expect(mocks.flowAgile.listRetroCards).toHaveBeenCalledWith('p1', 's1');
  });

  it('writes cards and refreshes the retro', async () => {
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const create = renderHook(() => useCreateRetroCard('p1', 's1'), { wrapper });
    await act(() => create.result.current.mutateAsync({ category: 'action', text: 'Do' }));
    expect(mocks.flowAgile.createRetroCard).toHaveBeenCalledWith({
      category: 'action',
      text: 'Do',
      projectId: 'p1',
      sprintId: 's1',
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: agileKeys.retro('p1', 's1') });

    const update = renderHook(() => useUpdateRetroCard('p1', 's1'), { wrapper });
    await act(() => update.result.current.mutateAsync({ id: 'r1', input: { text: 'y' } }));
    expect(mocks.flowAgile.updateRetroCard).toHaveBeenCalledWith('r1', { text: 'y' });

    const del = renderHook(() => useDeleteRetroCard('p1', 's1'), { wrapper });
    await act(() => del.result.current.mutateAsync('r1'));
    expect(mocks.flowAgile.deleteRetroCard).toHaveBeenCalledWith('r1');
  });

  it('votes, and takes the vote back when the card was already voted', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useVoteRetroCard('p1', 's1'), { wrapper });
    await act(() => result.current.mutateAsync({ id: 'r1', voted: false }));
    expect(mocks.flowAgile.voteRetroCard).toHaveBeenCalledWith('r1');
    await act(() => result.current.mutateAsync({ id: 'r1', voted: true }));
    expect(mocks.flowAgile.unvoteRetroCard).toHaveBeenCalledWith('r1');
  });
});
