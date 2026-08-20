import { QueryClient } from '@tanstack/react-query';

/**
 * Module-level client so product / stock caches survive screen remounts
 * (device rotation, tab blur, navigating back).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 30 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
      placeholderData: (previousData) => previousData,
    },
  },
});

export const weldstashKeys = {
  all: ['weldstash'] as const,
  products: () => [...weldstashKeys.all, 'products'] as const,
  productList: (search: string) => [...weldstashKeys.products(), 'list', search] as const,
  product: (id: string) => [...weldstashKeys.products(), 'detail', id] as const,
  warehouses: () => [...weldstashKeys.all, 'warehouses'] as const,
  stock: (productId: string) => [...weldstashKeys.all, 'stock', productId] as const,
  pickLists: () => [...weldstashKeys.all, 'pickLists'] as const,
  pickListList: (assignedTo?: string) => [...weldstashKeys.pickLists(), 'list', assignedTo ?? ''] as const,
  pickList: (id: string) => [...weldstashKeys.pickLists(), 'detail', id] as const,
};
