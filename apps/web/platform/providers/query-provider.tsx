import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { useAuth } from '@clerk/clerk-react';
import { queryClient } from '@/lib/query-client';
import { peekPendingOrganization } from '@/lib/pending-organization';
import {
  pruneQueryCaches,
  queryCacheKey,
  QUERY_CACHE_MAX_AGE,
  removeAllQueryCaches,
  setWritableQueryCacheOrg,
  workspaceCacheStorage,
} from '@/lib/persisted-query-cache';

// The dehydrated QueryClient cache is persisted to localStorage, one entry per
// workspace (`weldsuite:query-cache:{orgId}`, lib/persisted-query-cache). Every
// successful query is written there automatically and hydrated on the next
// page load, so primary view hooks (helpdesk, CRM, projects, calendar, …)
// render their last-known data on the first paint while a background refetch
// settles in ~300 ms.
//
// Bump CACHE_BUSTER manually when a deploy changes API response shapes in a
// way that would make rehydrated data wrong (e.g. column rename, removed
// field). On the next load, the persister sees the mismatch and discards
// the cache instead of feeding stale data into the UI.
const CACHE_BUSTER = 'v2';

export function QueryProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const { isLoaded, isSignedIn, orgId, userId } = useAuth();
  const pendingOrgId = typeof window !== 'undefined' ? peekPendingOrganization() : null;
  // A just-created workspace is waiting to become active — don't hydrate the
  // previous org's cache into the singleton client while that switch settles.
  const pendingOrgMismatch = Boolean(pendingOrgId && pendingOrgId !== orgId);
  // The workspace whose entry this tab may read and write right now.
  const activeOrgId = isLoaded && isSignedIn && orgId && !pendingOrgMismatch ? orgId : null;

  // One page load persists one workspace for one user: the first ones Clerk
  // settles on. A workspace switch reloads the page, so a later org in this
  // page only stops the writes (see setWritableQueryCacheOrg) instead of
  // restoring another workspace's entry into a client that still holds this
  // one's data.
  const [page, setPage] = useState<{ orgId: string; userId: string } | null>(null);
  if (page === null && activeOrgId && userId) setPage({ orgId: activeOrgId, userId });
  const pageOrgId = page?.orgId ?? null;

  // Another user signed in without a reload (a shared device, a sign-in in
  // another tab): the memory still holds the previous user's data, so this
  // page never writes it into a workspace's entry again.
  const writableOrgId = page && userId !== page.userId ? null : activeOrgId;

  // Before the persister's first write (it subscribes in a passive effect).
  useLayoutEffect(() => {
    setWritableQueryCacheOrg(writableOrgId);
  }, [writableOrgId]);

  useEffect(() => {
    if (pageOrgId) pruneQueryCaches(pageOrgId);
  }, [pageOrgId]);

  // Signed out (here or in another tab, or on a shared machine): no
  // workspace's data stays behind in the browser.
  const signedOut = isLoaded && !isSignedIn;
  useEffect(() => {
    if (signedOut) removeAllQueryCaches();
  }, [signedOut]);

  const persister = useMemo(
    () =>
      pageOrgId && typeof window !== 'undefined'
        ? createSyncStoragePersister({
            storage: workspaceCacheStorage(pageOrgId),
            key: queryCacheKey(pageOrgId),
          })
        : undefined,
    [pageOrgId],
  );

  // Until Clerk has resolved the active org (a sub-second window), or with no
  // workspace at all, run the same singleton client without persistence.
  if (!persister || !page) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: QUERY_CACHE_MAX_AGE,
        // The org is in the key already; keeping it in the buster too means an
        // entry that somehow holds another workspace's cache is discarded. The
        // user likewise: an entry left by someone whose session ended without
        // a sign-out (expired, browser closed) never restores for the next.
        buster: `${CACHE_BUSTER}:${page.userId}:${page.orgId}`,
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
