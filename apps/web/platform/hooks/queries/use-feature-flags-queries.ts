import { useQuery } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type { FeatureFlagsResponse } from '@weldsuite/app-api-client/schemas/feature-flags';

const featureFlagKeys = {
  all: ['feature-flags'] as const,
};

/**
 * Fetches the client-exposed feature flags for the current user from app-api
 * (resolved server-side via Cloudflare Flagship). Not cached — always fetched
 * fresh so a flag flip in the Flagship dashboard takes effect immediately
 * (on next mount / window focus / reconnect) without a stale window.
 */
function useFeatureFlags() {
  const { featureFlags } = useAppApi();
  return useQuery({
    queryKey: featureFlagKeys.all,
    queryFn: async () => {
      const res = await featureFlags.get();
      return res.data;
    },
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

/**
 * Convenience boolean accessor for a single flag. Defaults to `false` while
 * loading or on error, so a flag-gated UI element stays hidden until the flag
 * is confirmed on.
 */
export function useFeatureFlag(key: keyof FeatureFlagsResponse): boolean {
  const { data } = useFeatureFlags();
  return data?.[key] ?? false;
}

/**
 * A flag with its loading state, for a page that must not flash its "off"
 * state while the flags load: `undefined` until they answer.
 */
export function useFeatureFlagStatus(key: keyof FeatureFlagsResponse): boolean | undefined {
  const { data, isError } = useFeatureFlags();
  if (isError) return false;
  return data ? (data[key] ?? false) : undefined;
}
