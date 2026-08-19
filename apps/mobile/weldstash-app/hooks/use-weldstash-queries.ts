import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProductRow } from '@weldsuite/app-api-client/domains/products';
import type { DataResponse, ListResponse } from '@weldsuite/app-api-client/types';
import { appApi } from '@/services/app-api';
import { weldstashKeys } from '@/lib/query-client';

const OPEN_PICK_STATUSES = ['pending', 'assigned', 'in_progress', 'completed', 'packed'];

export function useWeldstashProducts(search: string) {
  return useQuery({
    queryKey: weldstashKeys.productList(search),
    queryFn: () =>
      appApi.products.list({
        limit: 50,
        search: search || undefined,
      }),
  });
}

export function useWeldstashProduct(id: string | undefined) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: weldstashKeys.product(id ?? ''),
    queryFn: () => appApi.products.get(id!),
    enabled: Boolean(id),
    placeholderData: () => {
      if (!id) return undefined;
      const cached = queryClient.getQueryData<DataResponse<ProductRow>>(weldstashKeys.product(id));
      if (cached) return cached;
      const lists = queryClient.getQueriesData<ListResponse<ProductRow>>({
        queryKey: [...weldstashKeys.products(), 'list'],
      });
      for (const [, data] of lists) {
        const hit = Array.isArray(data?.data) ? data.data.find((product) => product.id === id) : undefined;
        if (hit) return { data: hit };
      }
      return undefined;
    },
  });
}

export function useWeldstashStock(productId: string | undefined) {
  return useQuery({
    queryKey: weldstashKeys.stock(productId ?? ''),
    queryFn: () => appApi.inventory.list({ productId: productId!, limit: 50 }),
    enabled: Boolean(productId),
  });
}

export function useWeldstashWarehouses() {
  return useQuery({
    queryKey: weldstashKeys.warehouses(),
    queryFn: () => appApi.warehouses.list({ limit: 50 }),
    staleTime: 5 * 60_000,
  });
}

export function useWeldstashPickLists(assignedTo: string | undefined) {
  return useQuery({
    queryKey: weldstashKeys.pickListList(assignedTo),
    queryFn: async () => {
      const response = await appApi.pickLists.list({
        limit: 50,
        assignedTo,
      });
      return {
        ...response,
        data: (response.data ?? []).filter((row) => OPEN_PICK_STATUSES.includes(row.status)),
      };
    },
    enabled: Boolean(assignedTo),
  });
}

export function useWeldstashPickList(id: string | undefined) {
  return useQuery({
    queryKey: weldstashKeys.pickList(id ?? ''),
    queryFn: () => appApi.pickLists.get(id!),
    enabled: Boolean(id),
  });
}

export function prefetchWeldstashProduct(queryClient: ReturnType<typeof useQueryClient>, id: string) {
  void queryClient.prefetchQuery({
    queryKey: weldstashKeys.product(id),
    queryFn: () => appApi.products.get(id),
  });
  void queryClient.prefetchQuery({
    queryKey: weldstashKeys.stock(id),
    queryFn: () => appApi.inventory.list({ productId: id, limit: 50 }),
  });
  void queryClient.prefetchQuery({
    queryKey: weldstashKeys.warehouses(),
    queryFn: () => appApi.warehouses.list({ limit: 50 }),
  });
}
