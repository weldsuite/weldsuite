import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { useAuth } from '@clerk/clerk-react';
import { queryClient } from '@/lib/query-client';

// Single localStorage entry holding the dehydrated QueryClient cache. Every
// successful query is written here automatically and hydrated synchronously
// on the next page load, so primary view hooks (helpdesk, CRM, projects,
// calendar, …) render their last-known data on the first paint while a
// background refetch settles in ~300 ms.
//
// Bump CACHE_BUSTER manually when a deploy changes API response shapes in a
// way that would make rehydrated data wrong (e.g. column rename, removed
// field). On the next load, the persister sees the mismatch and discards
// the cache instead of feeding stale data into the UI.
const CACHE_BUSTER = 'v2';
const CACHE_KEY = 'weldsuite:query-cache';
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24h

const persister =
  typeof window === 'undefined'
    ? undefined
    : createSyncStoragePersister({
        storage: window.localStorage,
        key: CACHE_KEY,
      });

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const { isLoaded, orgId } = useAuth();

  if (!persister) {
    // SSR / non-browser environments — render the tree without persistence.
    // The platform is a pure SPA so this branch is mostly defensive.
    return <>{children}</>;
  }

  // Wait for Clerk to resolve the active org before restoring the persisted
  // cache. Restoring eagerly (before orgId is known) means we can't scope the
  // buster, so a reload after switching/leaving a workspace would rehydrate
  // the PREVIOUS workspace's data into the new one. Until Clerk loads we run
  // the same singleton client without persistence — a sub-second window.
  if (!isLoaded) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: CACHE_MAX_AGE,
        // Per-org buster: when the active workspace changes, the stored
        // cache's buster no longer matches and the persister discards it
        // instead of bleeding another workspace's data into this one.
        buster: `${CACHE_BUSTER}:${orgId ?? 'none'}`,
        dehydrateOptions: {
          // Persist only fully-resolved queries, and let any hook opt out by
          // setting `meta: { persist: false }`. Use this for ephemeral data
          // (search results, availability slots, draft autocomplete) that
          // would either bloat the cache or be wrong on rehydrate.
          shouldDehydrateQuery: (query) =>
            query.state.status === 'success' && query.meta?.persist !== false,
        },
      }}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
