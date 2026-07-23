/**
 * Supplier hooks — app-api `/api/wms-suppliers`.
 *
 * W5 repoint off api-worker's `/crm/suppliers` + `/wms/suppliers`, which app-api
 * unified into a single `/wms-suppliers` object route. Nothing imports this file
 * today (no hook below is exported), but the paths are kept correct so it can be
 * wired up without another migration.
 *
 * The supplier↔product join has no app-api equivalent — see the TODO(phase-out)
 * notes on the three product hooks at the bottom.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { Supplier } from '@/lib/api/domains/weldcrm';

/** app-api envelopes. */
interface ListEnvelope<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

interface Envelope<T> {
  data: T;
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

const supplierKeys = {
  all: ['crm', 'suppliers'] as const,
  lists: () => [...supplierKeys.all, 'list'] as const,
  list: (filters?: Record<string, any>) => [...supplierKeys.lists(), filters] as const,
  detail: (id: string) => [...supplierKeys.all, 'detail', id] as const,
};

function useSuppliers(filters?: { page?: number; pageSize?: number; search?: string; status?: string }) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: supplierKeys.list(filters),
    queryFn: async () => {
      const client = await getClient();
      // Offset paging became cursor paging; `limit` caps at 100.
      const { page: _page, pageSize, ...rest } = (filters ?? {}) as Record<string, any>;
      const query = buildQueryString({
        ...rest,
        ...(pageSize ? { limit: Math.min(Number(pageSize), 100) } : {}),
      });
      return client.get<ListEnvelope<Supplier>>(`/wms-suppliers${query}`);
    },
  });
}

function useSupplier(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: supplierKeys.detail(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<Envelope<Supplier>>(`/wms-suppliers/${id}`);
    },
    enabled: !!id && enabled,
  });
}

function useCreateSupplier() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Partial<Supplier>) => {
      const client = await getClient();
      return client.post<Envelope<{ id: string }>>('/wms-suppliers', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: supplierKeys.all });
    },
  });
}

function useUpdateSupplier() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<Supplier> }) => {
      const client = await getClient();
      // app-api patches suppliers; the legacy worker used PUT.
      return client.patch<Envelope<Supplier>>(`/wms-suppliers/${id}`, data);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: supplierKeys.all });
      qc.invalidateQueries({ queryKey: supplierKeys.detail(variables.id) });
    },
  });
}

function useDeleteSupplier() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<Record<string, never>>(`/wms-suppliers/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: supplierKeys.all });
    },
  });
}

// The supplier↔product join (`/wms/suppliers/:id/products`) is intentionally
// absent: the route exists on NO worker, and `/api/wms-suppliers` is supplier
// CRUD only. The three hooks that wrapped it were private, unreferenced, and
// could only ever 404, so they were removed with the legacy client. Rebuilding
// this means landing the sub-resource on app-api first.
