/**
 * Singleton TanStack Query client.
 *
 * Created at module scope so it can be passed to TanStack Router's
 * `createRouter` context AND used by QueryProvider — guaranteeing route
 * loaders share the same cache as the page hooks.
 */

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Stale-while-revalidate: rehydrated cache renders instantly on first
      // paint (via PersistQueryClientProvider), and because every entry is
      // immediately considered stale, a background refetch fires on mount and
      // updates the UI once it settles. This keeps the view fast (no spinner,
      // no flash) while guaranteeing the data is never served stale without a
      // refresh. Realtime events still invalidate on top of this.
      staleTime: 0,
      // Keep cached query data around long enough for the persister to write
      // it to localStorage AND for it to still be present after a reload.
      // Without this, the default 5-minute gcTime drops entries before they
      // can be persisted/rehydrated, defeating the persist-client.
      gcTime: 24 * 60 * 60 * 1000, // 24 hours
      refetchOnWindowFocus: false,
    },
  },
});
