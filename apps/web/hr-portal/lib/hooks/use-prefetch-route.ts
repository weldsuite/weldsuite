'use client';

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { portalGet } from '@/lib/client';
import { portalQueryKey } from '@/lib/query-client';
import { defaultScheduleRange } from '@/lib/schedule-range';

type RouteQuery = { path: string; query?: Record<string, string | undefined> };

/** The queries each portal page reads first — kept in step with the pages' `streamPortalQueries` calls. */
function queriesFor(route: string): RouteQuery[] {
  switch (route) {
    case 'me':
      return [{ path: '/employee/overview' }];
    case 'me/schedule':
      return [{ path: '/employee/attendance', query: defaultScheduleRange() }];
    case 'me/leave':
      return [{ path: '/employee/leave' }];
    case 'me/coaching':
      return [{ path: '/employee/coaching' }];
    case 'me/evaluations':
      return [{ path: '/employee/evaluations' }];
    case 'me/tasks':
      return [{ path: '/employee/tasks' }];
    case 'me/performance':
      return [{ path: '/employee/performance' }];
    case 'client':
    case 'client/milestones':
      return [{ path: '/client/overview' }];
    case 'client/requests':
      return [{ path: '/client/requests' }];
    default:
      return [];
  }
}

/**
 * Warm a page's data when the user shows intent to open it (hover, focus,
 * touch start), so the click usually lands on data that is already cached.
 * `prefetchQuery` is a no-op while the cached entry is still fresh.
 */
export function usePrefetchRoute(slug: string) {
  const queryClient = useQueryClient();
  return useCallback(
    (href: string) => {
      const route = href.replace(new RegExp(`^/${slug}/?`), '');
      for (const q of queriesFor(route)) {
        void queryClient.prefetchQuery({
          queryKey: portalQueryKey(slug, q.path, q.query),
          queryFn: () => portalGet(slug, q.path, q.query),
        });
      }
    },
    [queryClient, slug],
  );
}
