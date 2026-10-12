/**
 * WeldReach prospect hooks: prospects, saved lists and the imports (CSV rows
 * parsed in the browser, a WeldCRM list, a WeldData list).
 *
 * Keys live under the `['reach', …]` prefix shared by every WeldReach hook.
 */

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type { ListResponse } from '@weldsuite/app-api-client/types';
import type {
  ImportReachProspectsInput,
  ReachProspect,
  ReachProspectInput,
  ReachProspectValidation,
  UpdateReachProspectInput,
} from '@weldsuite/app-api-client/schemas/reach';

const PAGE_SIZE = 50;

export interface ReachProspectFilters {
  search?: string;
  listId?: string;
  validation?: ReachProspectValidation;
}

export const reachProspectKeys = {
  all: ['reach', 'prospects'] as const,
  lists: () => [...reachProspectKeys.all, 'list'] as const,
  list: (filters: ReachProspectFilters) => [...reachProspectKeys.lists(), filters] as const,
  prospectLists: () => ['reach', 'prospect-lists'] as const,
};

function flattenPages<T>(pages: Array<ListResponse<T>> | undefined): T[] {
  return pages?.flatMap((page) => page.data) ?? [];
}

// ---------------------------------------------------------------------------
// Prospects
// ---------------------------------------------------------------------------

/** Prospects matching the filters, following cursor pages as the table scrolls. */
export function useReachProspects(
  filters: ReachProspectFilters = {},
  options: { limit?: number; enabled?: boolean } = {},
) {
  const { reach } = useAppApi();
  const limit = options.limit ?? PAGE_SIZE;
  const search = filters.search?.trim() || undefined;

  const query = useInfiniteQuery({
    queryKey: [...reachProspectKeys.list({ ...filters, search }), limit],
    queryFn: ({ pageParam }) =>
      reach.listProspects({
        search,
        listId: filters.listId,
        validation: filters.validation,
        cursor: pageParam,
        limit,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pagination.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
    enabled: options.enabled ?? true,
    // Typing in the search box or switching a filter keeps the table (and its
    // toolbar) on screen while the next page of results loads.
    placeholderData: keepPreviousData,
  });

  return {
    ...query,
    prospects: flattenPages<ReachProspect>(query.data?.pages),
    totalCount: query.data?.pages[0]?.pagination.totalCount ?? 0,
  };
}

/** Anything a prospect write can change: the table, list counts. */
function useInvalidateProspects() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: reachProspectKeys.all });
    void qc.invalidateQueries({ queryKey: reachProspectKeys.prospectLists() });
  };
}

export function useCreateReachProspect() {
  const { reach } = useAppApi();
  const invalidate = useInvalidateProspects();

  return useMutation({
    mutationFn: (input: ReachProspectInput & { listId?: string }) => reach.createProspect(input),
    onSuccess: invalidate,
  });
}

export function useUpdateReachProspect() {
  const { reach } = useAppApi();
  const invalidate = useInvalidateProspects();

  return useMutation({
    mutationFn: (input: { id: string; changes: UpdateReachProspectInput }) =>
      reach.updateProspect(input.id, input.changes),
    onSuccess: invalidate,
  });
}

export function useDeleteReachProspect() {
  const { reach } = useAppApi();
  const invalidate = useInvalidateProspects();

  return useMutation<void, Error, string>({
    mutationFn: (id) => reach.deleteProspect(id),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/** One chunk of CSV rows. The caller sends at most `REACH_IMPORT_MAX_ROWS` per request. */
export function useImportReachProspects() {
  const { reach } = useAppApi();
  const invalidate = useInvalidateProspects();

  return useMutation({
    mutationFn: (input: ImportReachProspectsInput) => reach.importProspects(input),
    onSuccess: invalidate,
  });
}

export function useImportReachFromCrmList() {
  const { reach } = useAppApi();
  const invalidate = useInvalidateProspects();

  return useMutation({
    mutationFn: (input: { crmListId: string; listName?: string }) => reach.importFromCrmList(input),
    onSuccess: invalidate,
  });
}

export function useImportReachFromWeldData() {
  const { reach } = useAppApi();
  const invalidate = useInvalidateProspects();

  return useMutation({
    mutationFn: (input: { welddataListId: string; listName?: string }) =>
      reach.importFromWeldData(input),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Saved lists
// ---------------------------------------------------------------------------

export function useReachProspectLists() {
  const { reach } = useAppApi();

  return useQuery({
    queryKey: reachProspectKeys.prospectLists(),
    queryFn: () => reach.listLists(),
    select: (res) => res.data,
  });
}

export function useCreateReachList() {
  const { reach } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { name: string; description?: string }) => reach.createList(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: reachProspectKeys.prospectLists() });
    },
  });
}

export function useUpdateReachList() {
  const { reach } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; name?: string; description?: string }) =>
      reach.updateList(input.id, { name: input.name, description: input.description }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: reachProspectKeys.prospectLists() });
    },
  });
}

export function useDeleteReachList() {
  const { reach } = useAppApi();
  const invalidate = useInvalidateProspects();

  return useMutation<void, Error, string>({
    mutationFn: (id) => reach.deleteList(id),
    onSuccess: invalidate,
  });
}

export function useAddReachListMembers() {
  const { reach } = useAppApi();
  const invalidate = useInvalidateProspects();

  return useMutation({
    mutationFn: (input: { listId: string; prospectIds: string[] }) =>
      reach.addListMembers(input.listId, input.prospectIds),
    onSuccess: invalidate,
  });
}
