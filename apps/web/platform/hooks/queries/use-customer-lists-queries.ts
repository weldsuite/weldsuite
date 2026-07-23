/**
 * Customer/contact list hooks — app-api `/api/lists`.
 *
 * W5 repoint. The legacy `/crm/lists/*` routes were deleted in 42ff1442a, so
 * every hook here has been 404ing; this restores them against the successor.
 *
 * Two model shifts to be aware of:
 *  - app-api discriminates lists by `kind: 'company' | 'person'` (the identity
 *    layer after the Companies/People refactor). The UI still speaks
 *    `customer` / `contact`, so the hooks translate `kind` in both directions
 *    and callers need no change.
 *  - customers and contacts no longer have separate sub-resources; both go
 *    through `/:id/members` with `entityIds`. The server drops ids that don't
 *    match the list's `kind`, so adding a company to a person list is a no-op
 *    rather than an error.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { CustomerList, CustomerListFilters, CustomerListMemberFilters } from '@/lib/api/domains/weldcrm';

export type { CustomerList } from '@/lib/api/domains/weldcrm';

/** app-api list envelope. */
interface ListEnvelope<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

interface Envelope<T> {
  data: T;
}

/**
 * app-api's identity-layer kind ↔ the `customer`/`contact` vocabulary the UI
 * still speaks. `CustomerList` carries no `kind` in its type, but the rows do at
 * runtime and `customer-detail-header.tsx` filters on it, so translate both ways.
 */
type ApiListKind = 'company' | 'person';

const toApiKind = (kind?: string): ApiListKind | undefined =>
  kind === 'contact' ? 'person' : kind === 'customer' ? 'company' : undefined;

const fromApiKind = (kind?: string): string =>
  kind === 'person' ? 'contact' : kind === 'company' ? 'customer' : (kind ?? '');

function mapList(row: CustomerList): CustomerList {
  const kind = (row as { kind?: string }).kind;
  return { ...row, kind: fromApiKind(kind) } as CustomerList;
}

function buildQueryString(params: Record<string, any>): string {
  const queryParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      queryParams.set(key, String(value));
    }
  }
  const query = queryParams.toString();
  return query ? `?${query}` : '';
}

const customerListKeys = {
  all: ['crm', 'lists'] as const,
  lists: () => [...customerListKeys.all, 'list'] as const,
  list: (filters?: Record<string, any>) => [...customerListKeys.lists(), filters] as const,
  detail: (id: string) => [...customerListKeys.all, 'detail', id] as const,
  customers: (listId: string, filters?: Record<string, any>) => filters ? [...customerListKeys.all, listId, 'customers', filters] as const : [...customerListKeys.all, listId, 'customers'] as const,
  contacts: (listId: string, filters?: Record<string, any>) => filters ? [...customerListKeys.all, listId, 'contacts', filters] as const : [...customerListKeys.all, listId, 'contacts'] as const,
};

export function useCustomerLists(filters?: CustomerListFilters) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: customerListKeys.list(filters),
    queryFn: async () => {
      const client = await getClient();
      // Offset paging (`page`/`pageSize`) became cursor paging; `limit` caps at 200.
      const { page: _page, pageSize, kind, ...rest } = (filters ?? {}) as Record<string, any>;
      const query = buildQueryString({
        ...rest,
        ...(pageSize ? { limit: Math.min(Number(pageSize), 200) } : {}),
        ...(toApiKind(kind) ? { kind: toApiKind(kind) } : {}),
      });
      const result = await client.get<ListEnvelope<CustomerList>>(`/lists${query}`);
      return { ...result, data: (result.data ?? []).map(mapList) };
    },
  });
}

function useCustomerList(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: customerListKeys.detail(id),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<Envelope<CustomerList>>(`/lists/${id}`);
      return { ...result, data: result.data ? mapList(result.data) : result.data };
    },
    enabled: !!id && enabled,
  });
}

/**
 * Members of a `kind='company'` list. app-api returns
 * `{ memberId, entityId, addedAt, entity }` rows; unwrap to the entity so
 * callers keep seeing a plain customer array.
 */
function useCustomerListMembers(listId: string, _filters?: CustomerListMemberFilters) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: customerListKeys.customers(listId, _filters),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<Envelope<Array<{ entityId: string; addedAt: string; entity: any }>>>(
        `/lists/${listId}/members`,
      );
      return { data: (result.data ?? []).map((row) => row.entity) };
    },
    enabled: !!listId,
  });
}

/** Members of a `kind='person'` list — same endpoint, kind is a property of the list. */
function useContactListMembers(listId: string, _filters?: CustomerListMemberFilters) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: customerListKeys.contacts(listId, _filters),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<Envelope<Array<{ entityId: string; addedAt: string; entity: any }>>>(
        `/lists/${listId}/members`,
      );
      return { data: (result.data ?? []).map((row) => row.entity) };
    },
    enabled: !!listId,
  });
}

function useCreateCustomerList() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; color: string; icon: string; description?: string; kind?: string }) => {
      const client = await getClient();
      const { kind, ...rest } = data;
      // `kind` is immutable server-side and required at create; default to
      // company lists, matching the legacy customer-first behaviour.
      const result = await client.post<Envelope<CustomerList>>('/lists', {
        ...rest,
        kind: toApiKind(kind) ?? 'company',
      });
      return { ...result, data: result.data ? mapList(result.data) : result.data };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: customerListKeys.all });
    },
  });
}

function useUpdateCustomerList() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<{ name: string; color: string; icon: string; description: string }> }) => {
      const client = await getClient();
      const result = await client.patch<Envelope<CustomerList>>(`/lists/${id}`, data);
      return { ...result, data: result.data ? mapList(result.data) : result.data };
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: customerListKeys.all });
      qc.invalidateQueries({ queryKey: customerListKeys.detail(variables.id) });
    },
  });
}

function useDeleteCustomerList() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<Record<string, never>>(`/lists/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: customerListKeys.all });
    },
  });
}

export function useAddCustomersToList() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ listId, customerIds }: { listId: string; customerIds: string[] }) => {
      const client = await getClient();
      return client.post<Envelope<{ id: string; added: number }>>(`/lists/${listId}/members`, {
        entityIds: customerIds,
      });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: customerListKeys.customers(variables.listId) });
      qc.invalidateQueries({ queryKey: customerListKeys.detail(variables.listId) });
    },
  });
}

function useRemoveCustomerFromList() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ listId, customerId }: { listId: string; customerId: string }) => {
      const client = await getClient();
      return client.delete<Record<string, never>>(`/lists/${listId}/members/${customerId}`);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: customerListKeys.customers(variables.listId) });
      qc.invalidateQueries({ queryKey: customerListKeys.detail(variables.listId) });
    },
  });
}

export function useAddContactsToList() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ listId, contactIds }: { listId: string; contactIds: string[] }) => {
      const client = await getClient();
      return client.post<Envelope<{ id: string; added: number }>>(`/lists/${listId}/members`, {
        entityIds: contactIds,
      });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: customerListKeys.contacts(variables.listId) });
      qc.invalidateQueries({ queryKey: customerListKeys.detail(variables.listId) });
    },
  });
}

function useRemoveContactFromList() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ listId, contactId }: { listId: string; contactId: string }) => {
      const client = await getClient();
      return client.delete<Record<string, never>>(`/lists/${listId}/members/${contactId}`);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: customerListKeys.contacts(variables.listId) });
      qc.invalidateQueries({ queryKey: customerListKeys.detail(variables.listId) });
    },
  });
}
