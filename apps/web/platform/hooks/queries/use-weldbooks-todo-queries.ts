import { useEffect } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { accountingApi, type TodoKind } from '@/lib/api/domains/weldbooks';
import { isFeatureAvailable } from '@/lib/edition';
import { useIdleAwareRefetchInterval } from '@/hooks/use-user-idle';
import { accountingKeys } from './use-accounting-queries';

// ============================================================================
// Query keys
//
// Every key sits under ['accounting', ...], so switching the accounting entity
// resets them with the rest of the entity-scoped accounting data.
// ============================================================================

export const todoKeys = {
  all: [...accountingKeys.all, 'todo'] as const,
  summary: () => [...todoKeys.all, 'summary'] as const,
  top: (kind: TodoKind, limit: number) => [...todoKeys.all, 'top', kind, limit] as const,
  infinite: (kind: TodoKind) => [...todoKeys.all, 'infinite', kind] as const,
};

/** How often the counts refresh while somebody is at the screen. */
export const TODO_REFETCH_MS = 60_000;

/** The items a card lists before "Show all". */
export const TODO_TOP_LIMIT = 3;

/** The items a "Show all" list loads per page. */
export const TODO_PAGE_SIZE = 25;

/** Whether this deployment serves the to-process routes (the Rust backend only). */
export function isTodoAvailable(): boolean {
  return isFeatureAvailable('books-todo');
}

/**
 * The counts per kind and their total: the badges, the To process cards and
 * the overview callout share this one query. Polls while the person is active
 * (`useIdleAwareRefetchInterval`), never from an idle tab.
 */
export function useTodoSummary(options: { enabled?: boolean } = {}) {
  const enabled = (options.enabled ?? true) && isTodoAvailable();
  const queryKey = todoKeys.summary();
  const refetchInterval = useIdleAwareRefetchInterval(queryKey, TODO_REFETCH_MS, { active: enabled });
  return useQuery({
    queryKey,
    queryFn: async () => (await accountingApi.getTodoSummary()).data,
    enabled,
    staleTime: 15_000,
    refetchInterval,
    placeholderData: keepPreviousData,
  });
}

/** The first few items of one kind, for its card. */
export function useTodoTopItems(kind: TodoKind, limit = TODO_TOP_LIMIT, options: { enabled?: boolean } = {}) {
  const enabled = (options.enabled ?? true) && isTodoAvailable();
  const queryKey = todoKeys.top(kind, limit);
  const refetchInterval = useIdleAwareRefetchInterval(queryKey, TODO_REFETCH_MS, { active: enabled });
  return useQuery({
    queryKey,
    queryFn: async () => (await accountingApi.listTodo({ kind, limit })).data,
    enabled,
    staleTime: 15_000,
    refetchInterval,
  });
}

/** Every item of one kind, a page at a time by the server's cursor ("Show all"). */
export function useInfiniteTodoItems(kind: TodoKind, options: { enabled?: boolean } = {}) {
  const enabled = (options.enabled ?? true) && isTodoAvailable();
  return useInfiniteQuery({
    queryKey: todoKeys.infinite(kind),
    queryFn: ({ pageParam }) => accountingApi.listTodo({ kind, cursor: pageParam, limit: TODO_PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.pagination.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
    enabled,
    select: (data) => {
      // An item that moved between pages while loading would show twice.
      const seen = new Set<string>();
      const items = data.pages
        .flatMap((page) => page.data)
        .filter((item) => {
          const key = `${item.objectType}:${item.objectId}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      return { items, totalCount: data.pages.at(-1)?.pagination.totalCount ?? items.length };
    },
  });
}

/** The parts of the accounting cache whose change can add or remove something to process. */
const TODO_SOURCES: ReadonlySet<string> = new Set([
  'invoices',
  'bills',
  'bank-transactions',
  'bank-accounts',
  'bank-feeds',
  'documents',
  'payments',
  'vat-returns',
]);

/**
 * Refreshes the to-process queries whenever one of the records they count is
 * invalidated: a reconciled or matched bank line, an approved bill, a payment,
 * a processed document. The mutation hooks already invalidate those records, so
 * this follows them instead of every hook naming the to-process keys. Several
 * invalidations in one tick refresh the counts once.
 */
export function useInvalidateTodoWithAccounting(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    let scheduled = false;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'invalidate') return;
      const [root, source] = event.query.queryKey;
      if (root !== 'accounting' || typeof source !== 'string' || !TODO_SOURCES.has(source)) return;
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        void queryClient.invalidateQueries({ queryKey: todoKeys.all });
      });
    });
    return unsubscribe;
  }, [queryClient]);
}
