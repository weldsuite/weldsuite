/**
 * The portal's data cache (TanStack Query).
 *
 * Every read is cached under `['portal', slug, path, query?]`:
 *
 * - Pages are server-rendered: the server component loads a page's queries
 *   (lib/server/portal.ts), dehydrates them, and the client view reads them
 *   from this cache — so the first HTML already contains the data and the
 *   browser does not refetch on hydration.
 * - Client-side navigation between pages reuses cached entries and
 *   revalidates in the background once they are older than STALE_TIME.
 * - Live updates (lib/hooks/use-portal-realtime.ts) and successful writes
 *   (`portalPost` in lib/client.ts) invalidate the affected entries.
 *
 * The cache lives in memory only. This is personal HR data on possibly shared
 * devices, and server rendering already gives a fast first paint, so nothing
 * is written to browser storage.
 */

import { QueryClient, defaultShouldDehydrateQuery, isServer } from '@tanstack/react-query';
import { PortalApiError } from '@/lib/client-errors';

const STALE_TIME = 30_000;
const GC_TIME = 30 * 60_000;

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      dehydrate: {
        // Pages start their queries without awaiting them and hand the still
        // pending promise to the browser, which streams the result in. That
        // keeps navigation from blocking on app-api (see lib/server/portal.ts).
        shouldDehydrateQuery: (query) => defaultShouldDehydrateQuery(query) || query.state.status === 'pending',
        // Error messages from app-api are already user-facing; keep them.
        shouldRedactErrors: () => false,
      },
      hydrate: {
        queries: {
          // A streamed server query that fails must surface at once. With the
          // default retry behaviour a failed streamed query left the page on its
          // skeleton indefinitely (observed: >12s, no error shown); with this
          // the error boundary appears after one round trip, and its "Try again"
          // refetches normally.
          retry: false,
        },
      },
      queries: {
        // Also stops the browser refetching what the server just rendered.
        staleTime: STALE_TIME,
        gcTime: GC_TIME,
        refetchOnWindowFocus: true,
        // Auth and "not found" answers won't change on retry.
        retry: (failureCount, error) =>
          !(error instanceof PortalApiError && [401, 403, 404].includes(error.status)) && failureCount < 2,
      },
    },
  });
}

let browserClient: QueryClient | undefined;

/**
 * A new client per call on the server — a module-level one would be shared by
 * every request the Node process serves and leak one user's data into another
 * user's render. One per tab in the browser.
 */
export function getQueryClient(): QueryClient {
  if (isServer) return makeQueryClient();
  browserClient ??= makeQueryClient();
  return browserClient;
}

export function portalQueryKey(slug: string, path: string, query?: Record<string, string | undefined>) {
  return query && Object.keys(query).length ? (['portal', slug, path, query] as const) : (['portal', slug, path] as const);
}

/** Invalidate every cached read for a workspace whose path starts with one of `prefixes` (all when omitted). */
export function invalidatePortal(slug: string, prefixes?: string[]): Promise<void> {
  if (isServer) return Promise.resolve();
  return getQueryClient().invalidateQueries({
    predicate: (query) => {
      const [scope, querySlug, path] = query.queryKey as [string, string, string];
      if (scope !== 'portal' || querySlug !== slug) return false;
      if (!prefixes) return true;
      return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    },
  });
}

/** Forget everything cached for a workspace — sign-in, sign-out, expired session. */
export function clearPortalCache(slug: string): void {
  if (isServer) return;
  getQueryClient().removeQueries({ queryKey: ['portal', slug] });
}
