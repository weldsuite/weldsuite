import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { setRuntimeConfig } from '@/lib/runtime-config';

const api = vi.hoisted(() => ({
  getTodoSummary: vi.fn(),
  listTodo: vi.fn(),
}));
vi.mock('@/lib/api/domains/weldbooks', () => ({ accountingApi: api }));

const idle = vi.hoisted(() => ({ calls: [] as Array<{ key: unknown; ms: number; options: unknown }> }));
vi.mock('@/hooks/use-user-idle', () => ({
  useIdleAwareRefetchInterval: (key: unknown, ms: number, options: unknown) => {
    idle.calls.push({ key, ms, options });
    return false;
  },
}));

import {
  TODO_PAGE_SIZE,
  TODO_REFETCH_MS,
  TODO_TOP_LIMIT,
  todoKeys,
  useInfiniteTodoItems,
  useInvalidateTodoWithAccounting,
  useTodoSummary,
  useTodoTopItems,
} from './use-weldbooks-todo-queries';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

const SUMMARY = { total: 19, currency: 'EUR', kinds: { bank_lines: { count: 12, amount: null } } };

function item(id: string) {
  return {
    kind: 'bank_lines',
    objectType: 'bank_transaction',
    objectId: id,
    title: id,
    subtitle: null,
    amount: null,
    currency: null,
    date: null,
    dueDate: null,
    severity: 'info',
    hint: null,
  };
}

beforeEach(() => {
  api.getTodoSummary.mockReset();
  api.listTodo.mockReset();
  idle.calls = [];
  // The to-process routes exist on the Rust backend only.
  setRuntimeConfig({ backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] });
});

afterEach(() => setRuntimeConfig(null));

describe('useTodoSummary', () => {
  it('reads the summary and polls through the idle-aware interval, never a plain one', async () => {
    api.getTodoSummary.mockResolvedValue({ data: SUMMARY });
    const { wrapper } = setup();
    const { result } = renderHook(() => useTodoSummary(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(SUMMARY));
    expect(idle.calls[0]).toMatchObject({ key: todoKeys.summary(), ms: TODO_REFETCH_MS, options: { active: true } });
    expect(TODO_REFETCH_MS).toBeGreaterThanOrEqual(30_000);
  });

  it('keeps its key under the entity-scoped accounting data', () => {
    expect(todoKeys.summary().slice(0, 2)).toEqual(['accounting', 'todo']);
    expect(todoKeys.top('bank_lines', 3).slice(0, 2)).toEqual(['accounting', 'todo']);
    expect(todoKeys.infinite('documents').slice(0, 2)).toEqual(['accounting', 'todo']);
  });

  it('does not fetch or poll on Global, where the route does not exist', () => {
    setRuntimeConfig(null);
    const { wrapper } = setup();
    renderHook(() => useTodoSummary(), { wrapper });
    expect(api.getTodoSummary).not.toHaveBeenCalled();
    expect(idle.calls[0]).toMatchObject({ options: { active: false } });
  });

  it('does not fetch when the caller leaves it off', () => {
    const { wrapper } = setup();
    renderHook(() => useTodoSummary({ enabled: false }), { wrapper });
    expect(api.getTodoSummary).not.toHaveBeenCalled();
    expect(idle.calls[0]).toMatchObject({ options: { active: false } });
  });
});

describe('useTodoTopItems', () => {
  it('asks for the first three items of a kind', async () => {
    api.listTodo.mockResolvedValue({ data: [item('a')], pagination: { totalCount: 12, hasMore: true, cursor: 'c1' } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useTodoTopItems('bank_lines'), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(api.listTodo).toHaveBeenCalledWith({ kind: 'bank_lines', limit: TODO_TOP_LIMIT });
    expect(TODO_TOP_LIMIT).toBe(3);
  });
});

describe('useInfiniteTodoItems', () => {
  it('pages through a kind with the server cursor and counts every item once', async () => {
    api.listTodo
      .mockResolvedValueOnce({ data: [item('a'), item('b')], pagination: { totalCount: 4, hasMore: true, cursor: 'c1' } })
      .mockResolvedValueOnce({ data: [item('b'), item('c')], pagination: { totalCount: 4, hasMore: false, cursor: null } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useInfiniteTodoItems('bank_lines'), { wrapper });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(2));
    expect(api.listTodo).toHaveBeenNthCalledWith(1, { kind: 'bank_lines', cursor: null, limit: TODO_PAGE_SIZE });
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(api.listTodo).toHaveBeenNthCalledWith(2, { kind: 'bank_lines', cursor: 'c1', limit: TODO_PAGE_SIZE });
    // `b` moved between pages: it is listed once.
    await waitFor(() => expect(result.current.data?.items.map((i) => i.objectId)).toEqual(['a', 'b', 'c']));
    expect(result.current.hasNextPage).toBe(false);
  });
});

describe('useInvalidateTodoWithAccounting', () => {
  const sources = ['invoices', 'bills', 'bank-transactions', 'bank-accounts', 'bank-feeds', 'documents', 'payments', 'vat-returns'];

  async function mounted() {
    const { client, wrapper } = setup();
    client.setQueryData(todoKeys.summary(), SUMMARY);
    for (const source of [...sources, 'customers', 'reports']) client.setQueryData(['accounting', source, 'x'], 1);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    renderHook(() => useInvalidateTodoWithAccounting(), { wrapper });
    return { client, invalidate };
  }

  const todoInvalidations = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.filter(([filters]) => JSON.stringify((filters as { queryKey?: unknown })?.queryKey) === JSON.stringify(todoKeys.all));

  it.each(sources)('refreshes the to-process queries when %s are invalidated', async (source) => {
    const { client, invalidate } = await mounted();
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['accounting', source] });
    });
    await waitFor(() => expect(todoInvalidations(invalidate)).toHaveLength(1));
    expect(client.getQueryState(todoKeys.summary())?.isInvalidated).toBe(true);
  });

  it('leaves them alone when something else in the books changes', async () => {
    const { client, invalidate } = await mounted();
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['accounting', 'customers'] });
      await client.invalidateQueries({ queryKey: ['accounting', 'reports'] });
    });
    expect(todoInvalidations(invalidate)).toHaveLength(0);
  });

  it('refreshes them once when several records are invalidated in one go', async () => {
    const { client, invalidate } = await mounted();
    await act(async () => {
      await Promise.all(sources.map((source) => client.invalidateQueries({ queryKey: ['accounting', source] })));
    });
    await waitFor(() => expect(todoInvalidations(invalidate)).toHaveLength(1));
  });

  it('does not loop on its own invalidation', async () => {
    const { client, invalidate } = await mounted();
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['accounting', 'bills'] });
    });
    await waitFor(() => expect(todoInvalidations(invalidate)).toHaveLength(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(todoInvalidations(invalidate)).toHaveLength(1);
  });

  it('stops following once the module unmounts', async () => {
    const { client, wrapper } = setup();
    client.setQueryData(['accounting', 'bills', 'x'], 1);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { unmount } = renderHook(() => useInvalidateTodoWithAccounting(), { wrapper });
    unmount();
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['accounting', 'bills'] });
    });
    expect(todoInvalidations(invalidate)).toHaveLength(0);
  });
});
