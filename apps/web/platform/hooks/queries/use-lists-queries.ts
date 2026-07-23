/**
 * TanStack Query hooks for the kind-scoped Lists, backed by `apps/workers/app-api`
 * at `/api/lists/*` (the new unified backend — core-api lists are obsolete).
 *
 * Each list is scoped to one entity type (`company` or `person`). Pickers
 * and list management UIs filter by `kind` so a Companies page only sees
 * company lists and a People page only sees people lists.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { buildQueryString } from '@weldsuite/api-client';
import type {
  ListEntity,
  CreateListInput,
  UpdateListInput,
  ListListsQueryV2,
  AddListMembersInputV2,
  ListKind,
} from '@weldsuite/core-api-client/schemas/lists';
import type { Company } from '@weldsuite/app-api-client/schemas/companies';
import type { Person } from '@weldsuite/core-api-client/schemas/people';

export type { ListEntity, ListKind, CreateListInput, UpdateListInput };

interface PaginationMeta {
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

interface DataEnvelope<T> {
  data: T;
}

interface ListEnvelope<T> {
  data: T[];
  pagination: PaginationMeta;
}

/**
 * Members endpoint returns the resolved entity row joined inline, so
 * callers don't have to do an N+1 lookup to render names/avatars.
 */
export interface ListMemberWithEntity<T = Company | Person> {
  memberId: string;
  entityId: string;
  addedAt: string;
  entity: T;
}

export const listKeys = {
  all: ['lists'] as const,
  byKind: (kind?: ListKind) => [...listKeys.all, 'kind', kind] as const,
  list: (filters?: Partial<ListListsQueryV2>) => [...listKeys.all, 'list', filters] as const,
  detail: (id: string) => [...listKeys.all, 'detail', id] as const,
  members: (id: string) => [...listKeys.all, 'members', id] as const,
};

/**
 * `kind` is optional — pass undefined to load lists of both kinds (used by
 * the CRM sidebar, which groups all lists together).
 */
export function useLists(kind?: ListKind, search?: string) {
  const { getClient } = useAppApiClient();
  const filters: Partial<ListListsQueryV2> = {};
  if (kind) filters.kind = kind;
  if (search) filters.search = search;
  return useQuery({
    queryKey: listKeys.list(filters),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListEnvelope<ListEntity>>(
        `/lists${buildQueryString(filters as Record<string, unknown>)}`,
      );
    },
  });
}

export function useList(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: listKeys.detail(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataEnvelope<ListEntity>>(`/lists/${id}`);
    },
    enabled: !!id && enabled,
  });
}

export function useListMembers(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: listKeys.members(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataEnvelope<ListMemberWithEntity[]>>(`/lists/${id}/members`);
    },
    enabled: !!id && enabled,
  });
}

export function useCreateList() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateListInput) => {
      const client = await getClient();
      return client.post<DataEnvelope<ListEntity>>('/lists', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: listKeys.all });
    },
    onError: (err) => {
      console.error('[Lists] create failed:', err);
      toast.error('Failed to create list');
    },
  });
}

export function useUpdateList() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateListInput }) => {
      const client = await getClient();
      return client.patch<DataEnvelope<ListEntity>>(`/lists/${id}`, data);
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: listKeys.detail(variables.id) });
      qc.invalidateQueries({ queryKey: listKeys.all });
    },
    onError: (err) => {
      console.error('[Lists] update failed:', err);
      toast.error('Failed to update list');
    },
  });
}

export function useDeleteList() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/lists/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: listKeys.all });
    },
    onError: (err) => {
      console.error('[Lists] delete failed:', err);
      toast.error('Failed to delete list');
    },
  });
}

export function useAddListMembers() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ listId, data }: { listId: string; data: AddListMembersInputV2 }) => {
      const client = await getClient();
      return client.post<DataEnvelope<{ id: string; added: number }>>(
        `/lists/${listId}/members`,
        data,
      );
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: listKeys.members(variables.listId) });
      qc.invalidateQueries({ queryKey: listKeys.all });
    },
    onError: (err) => {
      console.error('[Lists] add members failed:', err);
      toast.error('Failed to add members');
    },
  });
}

export function useRemoveListMember() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ listId, entityId }: { listId: string; entityId: string }) => {
      const client = await getClient();
      return client.delete<void>(`/lists/${listId}/members/${entityId}`);
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: listKeys.members(variables.listId) });
      qc.invalidateQueries({ queryKey: listKeys.all });
    },
  });
}
