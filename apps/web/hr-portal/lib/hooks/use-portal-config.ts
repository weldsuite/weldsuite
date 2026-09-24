'use client';

import { useQuery } from '@tanstack/react-query';
import { PortalApiError, portalGet } from '@/lib/client';
import { portalQueryKey } from '@/lib/query-client';
import type { PortalConfig } from '@/lib/types';

export type PortalConfigStatus = 'loading' | 'ready' | 'not_found' | 'error';

/**
 * Branding + feature switches from `/config`, cached like every other portal
 * read (the sign-in page and the portal shell share the entry). 404 means the
 * portal is disabled for this workspace.
 */
export function usePortalConfig(slug: string): { config: PortalConfig | null; status: PortalConfigStatus } {
  const query = useQuery({
    queryKey: portalQueryKey(slug, '/config'),
    queryFn: () => portalGet<PortalConfig>(slug, '/config'),
    enabled: Boolean(slug),
    staleTime: 5 * 60_000,
  });

  if (!slug) return { config: null, status: 'not_found' };
  if (query.data) return { config: query.data, status: 'ready' };
  if (query.isPending) return { config: null, status: 'loading' };
  const notFound = query.error instanceof PortalApiError && query.error.status === 404;
  return { config: null, status: notFound ? 'not_found' : 'error' };
}
