import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const postMock = vi.fn();
const getMock = vi.fn();

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({
    getClient: async () => ({ post: postMock, get: getMock }),
  }),
}));
vi.mock('@weldsuite/realtime/react', () => ({ useTopic: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { hydrate, useCreateTask, useCrmTasks, type RawTask } from './use-crm-tasks';
import { calendarKeys } from '@/hooks/queries/use-calendar-queries';

const base: RawTask = {
  id: 'task_1',
  title: 'Send quote to Acme',
  status: 'todo',
  createdAt: '2026-09-01T10:00:00.000Z',
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

describe('use-crm-tasks hydrate()', () => {
  it('maps the server-resolved company onto linkedCompany (Company column + task panel)', () => {
    const task = hydrate({
      ...base,
      linkedCompany: { id: 'company_1', name: 'Acme Test BV', avatar: 'https://cdn.example.test/a.png' },
    });
    expect(task.linkedCompany).toEqual({
      id: 'company_1',
      name: 'Acme Test BV',
      avatar: 'https://cdn.example.test/a.png',
    });
  });

  it('leaves linkedCompany undefined for unlinked tasks and tolerates a null avatar', () => {
    expect(hydrate({ ...base, linkedCompany: null }).linkedCompany).toBeUndefined();
    expect(hydrate(base).linkedCompany).toBeUndefined();
    expect(
      hydrate({ ...base, linkedCompany: { id: 'company_2', name: 'No Logo', avatar: null } }).linkedCompany,
    ).toEqual({ id: 'company_2', name: 'No Logo', avatar: undefined });
  });

  it('reads the wire field `duration` (minutes) so the duration chip round-trips', () => {
    expect(hydrate({ ...base, duration: 30 }).duration).toBe(30);
  });

  it('falls back to the legacy `durationMinutes` alias and yields undefined when unset', () => {
    expect(hydrate({ ...base, durationMinutes: 45 }).duration).toBe(45);
    expect(hydrate({ ...base, duration: null }).duration).toBeUndefined();
    expect(hydrate(base).duration).toBeUndefined();
  });

  it('parses date strings into Date objects', () => {
    const task = hydrate({ ...base, dueDate: '2026-09-30T00:00:00.000Z', completedAt: null });
    expect(task.createdAt).toBeInstanceOf(Date);
    expect(task.dueDate).toEqual(new Date('2026-09-30T00:00:00.000Z'));
    expect(task.completedAt).toBeUndefined();
  });
});

describe('useCrmTasks()', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('hydrates the list response with the company and duration', async () => {
    getMock.mockResolvedValue({
      data: [
        {
          ...base,
          duration: 30,
          linkedCompany: { id: 'company_1', name: 'Acme Test BV', avatar: null },
        },
      ],
    });
    const { result } = renderHook(() => useCrmTasks('user_1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/tasks?assigneeId=user_1&crmLinked=true');
    expect(result.current.data?.[0]?.linkedCompany?.name).toBe('Acme Test BV');
    expect(result.current.data?.[0]?.duration).toBe(30);
  });
});

describe('useCreateTask()', () => {
  beforeEach(() => {
    postMock.mockReset();
    postMock.mockResolvedValue({ data: { id: 'task_new' } });
  });

  it('sends duration, the company link and all assignees in the create payload', async () => {
    const { result } = renderHook(() => useCreateTask(), { wrapper });
    result.current.mutate({
      title: 'Send quote to Acme',
      priority: 'high',
      duration: 30,
      linkedCompanyId: 'company_1',
      assigneeId: 'user_1',
      assigneeIds: ['user_1', 'user_2'],
    });
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [path, payload] = postMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/tasks');
    expect(payload).toMatchObject({
      title: 'Send quote to Acme',
      priority: 'high',
      duration: 30,
      customerId: 'company_1',
      assigneeId: 'user_1',
      assigneeIds: ['user_1', 'user_2'],
    });
  });

  it('sends startDate so a task created from a calendar slot is pinned there', async () => {
    const { result } = renderHook(() => useCreateTask(), { wrapper });
    const start = new Date('2026-10-14T09:00:00.000Z');
    result.current.mutate({ title: 'Pinned', dueDate: start, startDate: start });
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [, payload] = postMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).toMatchObject({ startDate: start.toISOString(), dueDate: start.toISOString() });
  });

  it('refreshes the calendar after a task is created', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCreateTask(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });
    result.current.mutate({ title: 'Shows up in the calendar' });
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: calendarKeys.all }),
    );
  });
});
