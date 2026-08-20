import type { QueryClient } from '@tanstack/react-query';
import type { InventoryRow } from '@weldsuite/app-api-client/domains/inventory';
import type { ProductRow } from '@weldsuite/app-api-client/domains/products';
import type { DataResponse, ListResponse } from '@weldsuite/app-api-client/types';
import { weldstashKeys } from '@/lib/query-client';
import { bumpInventoryRows, bumpProductQty } from '@/utils/stock';

export function applyLocalStockDelta(
  queryClient: QueryClient,
  input: { productId: string; warehouseId: string; delta: number },
) {
  const { productId, warehouseId, delta } = input;
  if (delta === 0) return;

  queryClient.setQueryData<DataResponse<ProductRow>>(weldstashKeys.product(productId), (old) => {
    if (!old?.data) return old;
    return { ...old, data: bumpProductQty(old.data, delta) };
  });

  queryClient.setQueriesData<ListResponse<ProductRow>>(
    { queryKey: [...weldstashKeys.products(), 'list'] },
    (old) => {
      if (!old?.data || !Array.isArray(old.data)) return old;
      return {
        ...old,
        data: old.data.map((product) => (product.id === productId ? bumpProductQty(product, delta) : product)),
      };
    },
  );

  queryClient.setQueryData<ListResponse<InventoryRow>>(weldstashKeys.stock(productId), (old) => {
    const rows = old?.data ?? [];
    return {
      data: bumpInventoryRows(rows, productId, warehouseId, delta),
      pagination: old?.pagination ?? { totalCount: rows.length, hasMore: false, cursor: null },
    };
  });
}
