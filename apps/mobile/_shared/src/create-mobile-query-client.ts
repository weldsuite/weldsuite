import { QueryClient } from '@tanstack/react-query';

export interface CreateMobileQueryClientOptions {
  /** Default staleTime in ms. Default: 60_000. */
  staleTime?: number;
  /** Default gcTime in ms. Default: 30 * 60_000. */
  gcTime?: number;
}

/**
 * Shared TanStack Query defaults for Expo shells that mount useRealtimeSync.
 */
export function createMobileQueryClient(
  options: CreateMobileQueryClientOptions = {},
): QueryClient {
  const { staleTime = 60_000, gcTime = 30 * 60_000 } = options;
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime,
        gcTime,
        retry: 1,
        refetchOnWindowFocus: false,
        placeholderData: (previousData) => previousData,
      },
    },
  });
}
