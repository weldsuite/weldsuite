/**
 * Server-side data loading for server-rendered portal pages.
 *
 * Server components call app-api directly (no round trip through this app's
 * own `/api/portal` proxy) with the session token from the httpOnly cookie.
 * Results are dehydrated into the page's TanStack Query cache under the exact
 * keys the client views use, so the views render complete HTML on the server
 * and don't refetch on hydration.
 *
 * Server-only: imports next/headers and reads APP_API_URL.
 */

import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { dehydrate, type DehydratedState } from '@tanstack/react-query';
import { portalUpstream, sessionCookieName } from '@/lib/api';
import { PortalApiError } from '@/lib/client-errors';
import { getQueryClient, portalQueryKey } from '@/lib/query-client';
import type { PortalConfig } from '@/lib/types';

/** Branding is public and identical for everyone on a workspace — cache it briefly across requests. */
const CONFIG_REVALIDATE_SECONDS = 60;

export type ServerResult<T> = { ok: true; data: T } | { ok: false; status: number };

function upstream(slug: string, path: string, query?: Record<string, string | undefined>): string {
  const url = new URL(portalUpstream(slug, path));
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Authenticated GET for the signed-in portal user. Never cached across
 * requests: the response is personal.
 */
export async function serverPortalGet<T>(
  slug: string,
  path: string,
  query?: Record<string, string | undefined>,
): Promise<ServerResult<T>> {
  const token = (await cookies()).get(sessionCookieName())?.value;
  if (!token) return { ok: false, status: 401 };
  try {
    const res = await fetch(upstream(slug, path, query), {
      headers: { 'X-Workspace-Slug': slug, Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = (await res.json()) as { data: T };
    return { ok: true, data: json.data };
  } catch {
    return { ok: false, status: 502 };
  }
}

/**
 * The workspace's public portal config (branding + feature switches), or null
 * when the portal is disabled or the workspace doesn't exist. Deduplicated
 * within a request (metadata + page both ask) and cached across requests for
 * CONFIG_REVALIDATE_SECONDS.
 */
export const getPortalConfig = cache(async (slug: string): Promise<PortalConfig | null> => {
  if (!slug) return null;
  try {
    const res = await fetch(upstream(slug, '/config'), {
      headers: { 'X-Workspace-Slug': slug, Accept: 'application/json' },
      next: { revalidate: CONFIG_REVALIDATE_SECONDS, tags: [`hrportal-config:${slug}`] },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data: PortalConfig };
    return json.data;
  } catch {
    return null;
  }
});

export interface PortalQuery {
  path: string;
  query?: Record<string, string | undefined>;
}

/**
 * Load a page's queries for the signed-in user and return the dehydrated
 * cache to hand to `<HydrationBoundary>`. An expired session redirects to the
 * sign-in page with a real HTTP redirect. Other failures are left out of the
 * cache, so the client view shows its own error state and can retry.
 */
export async function hydratePortalQueries(slug: string, queries: PortalQuery[]): Promise<DehydratedState> {
  const queryClient = getQueryClient();
  const results = await Promise.all(queries.map((q) => serverPortalGet<unknown>(slug, q.path, q.query)));
  if (results.some((r) => !r.ok && r.status === 401)) redirect(`/${slug}/login`);
  results.forEach((result, index) => {
    const q = queries[index]!;
    if (result.ok) queryClient.setQueryData(portalQueryKey(slug, q.path, q.query), result.data);
  });
  return dehydrate(queryClient);
}

/**
 * Start a page's queries WITHOUT waiting for them, and return the cache with
 * the pending promises in it. The server component returns immediately, so a
 * client-side navigation is never held up by app-api:
 *
 * - data already in the browser's cache renders at once (and refreshes in the
 *   background when stale);
 * - otherwise the page's `loading.tsx` shows until the streamed result lands;
 * - on a full page load React streams the finished HTML, so the page is still
 *   server-rendered.
 *
 * The session itself is checked (with a real redirect) by the signed-in
 * layout, which does await `/me`.
 */
export function streamPortalQueries(slug: string, queries: PortalQuery[]): DehydratedState {
  const queryClient = getQueryClient();
  for (const q of queries) {
    void queryClient.prefetchQuery({
      queryKey: portalQueryKey(slug, q.path, q.query),
      queryFn: async () => {
        const result = await serverPortalGet<unknown>(slug, q.path, q.query);
        if (!result.ok) throw new PortalApiError(`Request failed (${result.status})`, result.status);
        return result.data;
      },
    });
  }
  return dehydrate(queryClient);
}

/** Public-config variant for pages outside the signed-in area (sign-in). */
export async function hydratePortalConfig(slug: string, config: PortalConfig): Promise<DehydratedState> {
  const queryClient = getQueryClient();
  queryClient.setQueryData(portalQueryKey(slug, '/config'), config);
  return dehydrate(queryClient);
}
