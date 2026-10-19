import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { bundleSrcFromPath } from './frame-src';

/**
 * Where a WeldApp bundle loads from, as minted by
 * `POST /api/user-apps/code/:code/bundle-url`: a plain path for a public,
 * approved app, or a signed, workspace-bound path (valid ~12h) for everything
 * else. An iframe src cannot carry a bearer token, so the capability travels in
 * the URL path and every relative asset / lazy chunk request keeps it.
 */
export interface BundleLink {
  path: string;
  signed: boolean;
  /** ISO timestamp; null for a plain (unsigned) link. */
  expiresAt: string | null;
}

/** A hidden frame is reloaded onto a fresh link this long before the old one expires. */
export const BUNDLE_LINK_REFRESH_MARGIN_MS = 30 * 60 * 1000;

export function bundleLinkExpiresAtMs(link: BundleLink | null | undefined): number | null {
  if (!link?.expiresAt) return null;
  const ms = Date.parse(link.expiresAt);
  return Number.isFinite(ms) ? ms : null;
}

/** True when a signed link is within the refresh margin of expiring. */
export function bundleLinkNearExpiry(link: BundleLink | null | undefined, now = Date.now()): boolean {
  const expires = bundleLinkExpiresAtMs(link);
  return expires !== null && expires - now < BUNDLE_LINK_REFRESH_MARGIN_MS;
}

/**
 * The bundle link of `appCode` for the active workspace. Fetched once and kept
 * (the iframe URL must stay stable for the frame's life); re-minted on remount
 * when it is near expiry, and on demand via `refresh()`.
 */
export function useUserAppBundleLink(appCode: string | undefined, options: { enabled: boolean }) {
  const { getClient } = useAppApiClient();
  const { orgId } = useAuth();

  const query = useQuery({
    queryKey: ['user-apps', 'bundle-link', orgId ?? 'none', appCode ?? ''],
    enabled: Boolean(appCode) && options.enabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: (q) => (bundleLinkNearExpiry(q.state.data as BundleLink | undefined) ? 'always' : false),
    retry: 1,
    queryFn: async (): Promise<BundleLink> => {
      const client = await getClient();
      const result = await client.post<{ data: BundleLink }>(`/user-apps/code/${appCode}/bundle-url`);
      return result.data;
    },
  });

  const { refetch } = query;
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  const link = query.data ?? null;
  const src = appCode && link ? bundleSrcFromPath(appCode, link.path) : null;
  return {
    link,
    src,
    expiresAtMs: bundleLinkExpiresAtMs(link),
    isLoading: query.isLoading,
    isError: query.isError || (Boolean(link) && src === null),
    refresh,
  };
}
