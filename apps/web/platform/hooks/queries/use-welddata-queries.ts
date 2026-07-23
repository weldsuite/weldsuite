import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { personKeys } from '@/components/objects/person/use-person-data';
import { companyKeys } from '@/components/objects/company/use-company-data';
import { listKeys } from '@/hooks/queries/use-lists-queries';
import type {
  AddLeadsInput,
  ConvertLeadResult,
  ConvertSearchLeadsInput,
  ConvertSearchLeadsResult,
  ConvertToCrmListInput,
  ConvertToCrmListResult,
  CreateColumnInput,
  CreateWelddataListInput,
  LemlistFilter,
  LemlistFilterCatalog,
  LemlistSearchResult,
  RunColumnInput,
  SearchLeadsInput,
  UpdateColumnInput,
  UpdateWelddataListInput,
  WelddataCell,
  WelddataColumn,
  WelddataLead,
  WelddataList,
} from '@weldsuite/app-api-client/schemas/welddata';

export interface AiModel {
  modelId: string;
  provider: string;
  displayName: string;
  tier: string;
  inputPriceCents: number;
  outputPriceCents: number;
  creditsPerKToken: number;
  sortOrder: number;
}

interface ListResponse<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

interface DetailResponse<T> {
  data: T;
}

const welddataKeys = {
  all: ['welddata'] as const,
  filters: () => [...welddataKeys.all, 'filters'] as const,
  lists: () => [...welddataKeys.all, 'lists'] as const,
  list: (id: string) => [...welddataKeys.all, 'list', id] as const,
  leads: (listId: string, filters?: Record<string, unknown>) =>
    [...welddataKeys.all, 'leads', listId, filters] as const,
  columns: (listId: string) => [...welddataKeys.all, 'columns', listId] as const,
  cells: (listId: string) => [...welddataKeys.all, 'cells', listId] as const,
  models: () => [...welddataKeys.all, 'models'] as const,
};

// ---------------------------------------------------------------------------
// Database search (Lemlist, proxied)
// ---------------------------------------------------------------------------

function useLemlistFilters() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: welddataKeys.filters(),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<DetailResponse<LemlistFilterCatalog>>('/welddata/filters');
      return res.data;
    },
    staleTime: 1000 * 60 * 60, // filters rarely change
  });
}

function useSearchLeads() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ kind, input }: { kind: 'person' | 'company'; input: SearchLeadsInput }) => {
      const client = await getClient();
      const path = kind === 'person' ? '/welddata/search/people' : '/welddata/search/companies';
      const res = await client.post<DetailResponse<LemlistSearchResult>>(path, input);
      return res.data;
    },
  });
}

/** The submitted search criteria. `null` keeps the query idle until the user
 * runs a search. */
export interface InfiniteSearchParams {
  kind: 'person' | 'company';
  filters: LemlistFilter[];
  keyword?: string;
  size?: number;
  /** WeldData list ids whose already-saved leads are filtered out of results. */
  excludeListIds?: string[];
}

/**
 * Page-based infinite search over the lead database. Each page returns
 * `{ rows, page, hasMore }`; `getNextPageParam` advances `page` until the
 * provider reports no more results. The query stays disabled until `params`
 * is non-null (i.e. the user has run a search).
 */
export function useInfiniteSearchLeads(params: InfiniteSearchParams | null) {
  const { getClient } = useAppApiClient();
  const size = params?.size ?? 25;
  return useInfiniteQuery({
    queryKey: [
      ...welddataKeys.all,
      'search',
      params?.kind,
      params?.keyword ?? '',
      params?.filters ?? [],
      params?.excludeListIds ?? [],
      size,
    ],
    enabled: !!params,
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      const path =
        params!.kind === 'person' ? '/welddata/search/people' : '/welddata/search/companies';
      const res = await client.post<DetailResponse<LemlistSearchResult>>(path, {
        filters: params!.filters,
        keyword: params!.keyword,
        page: pageParam,
        size,
        excludeListIds: params!.excludeListIds,
      });
      return res.data;
    },
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.page + 1 : undefined),
  });
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export function useWelddataLists(search?: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...welddataKeys.lists(), search ?? ''],
    queryFn: async () => {
      const client = await getClient();
      const q = search ? `?search=${encodeURIComponent(search)}` : '';
      return client.get<ListResponse<WelddataList>>(`/welddata/lists${q}`);
    },
    enabled,
  });
}

export function useWelddataList(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: welddataKeys.list(id),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<DetailResponse<WelddataList>>(`/welddata/lists/${id}`);
      return res.data;
    },
    enabled: !!id && enabled,
  });
}

export function useCreateWelddataList() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateWelddataListInput) => {
      const client = await getClient();
      const res = await client.post<DetailResponse<WelddataList>>('/welddata/lists', data);
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: welddataKeys.lists() }),
  });
}

export function useUpdateWelddataList() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateWelddataListInput }) => {
      const client = await getClient();
      const res = await client.patch<DetailResponse<WelddataList>>(`/welddata/lists/${id}`, data);
      return res.data;
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: welddataKeys.lists() });
      qc.invalidateQueries({ queryKey: welddataKeys.list(v.id) });
    },
  });
}

export function useDeleteWelddataList() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete<void>(`/welddata/lists/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: welddataKeys.lists() }),
  });
}

// ---------------------------------------------------------------------------
// Saved leads
// ---------------------------------------------------------------------------

export function useWelddataLeads(listId: string, filters?: Record<string, unknown>, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: welddataKeys.leads(listId, filters),
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filters ?? {})) {
        if (v === undefined || v === null || v === '') continue;
        params.set(k, String(v));
      }
      const q = params.toString();
      return client.get<ListResponse<WelddataLead>>(`/welddata/lists/${listId}/leads${q ? `?${q}` : ''}`);
    },
    enabled: !!listId && enabled,
  });
}

export function useAddLeads() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ listId, input }: { listId: string; input: AddLeadsInput }) => {
      const client = await getClient();
      const res = await client.post<DetailResponse<{ added: number; skipped: number }>>(
        `/welddata/lists/${listId}/leads`,
        input,
      );
      return res.data;
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: welddataKeys.lists() });
      qc.invalidateQueries({ queryKey: welddataKeys.list(v.listId) });
      qc.invalidateQueries({ queryKey: [...welddataKeys.all, 'leads', v.listId] });
    },
  });
}

export function useRemoveLead() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, listId: _listId }: { id: string; listId: string }) => {
      const client = await getClient();
      await client.delete<void>(`/welddata/leads/${id}`);
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: welddataKeys.list(v.listId) });
      qc.invalidateQueries({ queryKey: [...welddataKeys.all, 'leads', v.listId] });
    },
  });
}

export function useConvertLead() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      listId: _listId,
      createCompany = true,
    }: {
      id: string;
      listId: string;
      createCompany?: boolean;
    }) => {
      const client = await getClient();
      const res = await client.post<DetailResponse<ConvertLeadResult>>(
        `/welddata/leads/${id}/convert`,
        { createCompany },
      );
      return res.data;
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: [...welddataKeys.all, 'leads', v.listId] });
      qc.invalidateQueries({ queryKey: welddataKeys.list(v.listId) });
    },
  });
}

/**
 * Convert search-result rows straight into CRM people/companies, bypassing the
 * WeldData list. Invalidates the CRM lists so the new records appear there.
 */
export function useConvertSearchLeads() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConvertSearchLeadsInput) => {
      const client = await getClient();
      const res = await client.post<DetailResponse<ConvertSearchLeadsResult>>(
        '/welddata/convert',
        input,
      );
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: personKeys.lists() });
      qc.invalidateQueries({ queryKey: companyKeys.lists() });
    },
  });
}

/**
 * Convert leads to CRM and add the new person/company to an existing CRM list
 * in one step. Used by the search grid (inline `leads`) and the saved-leads
 * grid (`leadIds`). Invalidates the CRM people/company + lists caches.
 */
export function useConvertToCrmList() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConvertToCrmListInput) => {
      const client = await getClient();
      const res = await client.post<DetailResponse<ConvertToCrmListResult>>(
        '/welddata/convert-to-list',
        input,
      );
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: personKeys.lists() });
      qc.invalidateQueries({ queryKey: companyKeys.lists() });
      qc.invalidateQueries({ queryKey: listKeys.all });
    },
  });
}

// ---------------------------------------------------------------------------
// Enrichment columns + cells
// ---------------------------------------------------------------------------

export function useAiModels() {
  // AI has been removed platform-wide — the AI enrichment column type is no
  // longer offered (see AddColumnDialog), so this never needs to hit the
  // (now-503) models endpoint. Kept as a no-op query so any remaining call
  // site still gets a well-typed, empty result instead of a network error.
  return useQuery({
    queryKey: welddataKeys.models(),
    queryFn: async (): Promise<AiModel[]> => [],
    staleTime: Infinity,
  });
}

export function useWelddataColumns(listId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: welddataKeys.columns(listId),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<DetailResponse<WelddataColumn[]>>(
        `/welddata/lists/${listId}/columns`,
      );
      return res.data;
    },
    enabled: !!listId && enabled,
  });
}

/**
 * Cells for a list, keyed `${columnId}:${leadId}`. Polls every 4s while any
 * cell is still pending/running so the grid fills in live during a run.
 */
export function useWelddataCells(listId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: welddataKeys.cells(listId),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<DetailResponse<WelddataCell[]>>(
        `/welddata/lists/${listId}/cells`,
      );
      const map: Record<string, WelddataCell> = {};
      for (const cell of res.data) map[`${cell.columnId}:${cell.leadId}`] = cell;
      return map;
    },
    enabled: !!listId && enabled,
    refetchInterval: (query) => {
      const data = query.state.data as Record<string, WelddataCell> | undefined;
      if (!data) return false;
      const active = Object.values(data).some(
        (c) => c.status === 'pending' || c.status === 'running',
      );
      return active ? 4000 : false;
    },
  });
}

export function useCreateColumn() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ listId, data }: { listId: string; data: CreateColumnInput }) => {
      const client = await getClient();
      const res = await client.post<DetailResponse<WelddataColumn>>(
        `/welddata/lists/${listId}/columns`,
        data,
      );
      return res.data;
    },
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: welddataKeys.columns(v.listId) }),
  });
}

export function useUpdateColumn() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      listId: _listId,
      data,
    }: {
      id: string;
      listId: string;
      data: UpdateColumnInput;
    }) => {
      const client = await getClient();
      const res = await client.patch<DetailResponse<WelddataColumn>>(`/welddata/columns/${id}`, data);
      return res.data;
    },
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: welddataKeys.columns(v.listId) }),
  });
}

export function useDeleteColumn() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, listId: _listId }: { id: string; listId: string }) => {
      const client = await getClient();
      await client.delete<void>(`/welddata/columns/${id}`);
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: welddataKeys.columns(v.listId) });
      qc.invalidateQueries({ queryKey: welddataKeys.cells(v.listId) });
    },
  });
}

type CellMap = Record<string, WelddataCell>;

/** Build a `pending` cell so the grid shows the spinner the instant a run is
 * clicked — before the POST + refetch round-trips resolve. Reuses the existing
 * cell when there is one so its prior value/id survive the optimistic flip. */
function optimisticPending(columnId: string, leadId: string, existing?: WelddataCell): WelddataCell {
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? `optimistic-${columnId}:${leadId}`,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    columnId,
    leadId,
    status: 'pending',
    value: existing?.value ?? null,
    data: existing?.data ?? null,
    error: null,
    creditsUsed: existing?.creditsUsed ?? null,
    ranAt: existing?.ranAt ?? null,
  };
}

export function useRunColumn() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      listId,
      columnId,
      input,
    }: {
      listId: string;
      columnId: string;
      input?: RunColumnInput;
    }) => {
      const client = await getClient();
      const res = await client.post<DetailResponse<{ queued: number }>>(
        `/welddata/lists/${listId}/columns/${columnId}/run`,
        input ?? {},
      );
      return res.data;
    },
    onMutate: async ({ listId, columnId, input }) => {
      const key = welddataKeys.cells(listId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<CellMap>(key);
      qc.setQueryData<CellMap>(key, (old) => {
        if (!old) return old;
        const targetLeads = input?.leadIds;
        const onlyMissing = input?.onlyMissing;
        const next: CellMap = { ...old };
        for (const [k, cell] of Object.entries(old)) {
          if (cell.columnId !== columnId) continue;
          if (targetLeads?.length && !targetLeads.includes(cell.leadId)) continue;
          if (onlyMissing && cell.status === 'done') continue;
          next[k] = optimisticPending(cell.columnId, cell.leadId, cell);
        }
        return next;
      });
      return { prev, key };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: (_d, _e, v) => qc.invalidateQueries({ queryKey: welddataKeys.cells(v.listId) }),
  });
}

export function useRunCell() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      columnId,
      leadId,
      listId: _listId,
    }: {
      columnId: string;
      leadId: string;
      listId: string;
    }) => {
      const client = await getClient();
      const res = await client.post<DetailResponse<{ queued: number }>>('/welddata/cells/run', {
        columnId,
        leadId,
      });
      return res.data;
    },
    onMutate: async ({ columnId, leadId, listId }) => {
      const key = welddataKeys.cells(listId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<CellMap>(key);
      qc.setQueryData<CellMap>(key, (old) => {
        const cellKey = `${columnId}:${leadId}`;
        return { ...(old ?? {}), [cellKey]: optimisticPending(columnId, leadId, old?.[cellKey]) };
      });
      return { prev, key };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: (_d, _e, v) => qc.invalidateQueries({ queryKey: welddataKeys.cells(v.listId) }),
  });
}
