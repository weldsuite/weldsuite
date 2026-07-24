import { useNavigate, useRouter as useTanStackRouter } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

/**
 * Compat layer: drop-in replacement for `useRouter()` from `next/navigation`.
 * Returns an object with `push`, `replace`, `back`, `forward`, `prefetch`, and `refresh`.
 */
export function useRouter() {
  const navigate = useNavigate();
  const router = useTanStackRouter();

  const push = useCallback(
    // `options` kept for next/navigation signature compat — TanStack Router
    // has no scroll-restoration option to forward it to.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (href: string, options?: { scroll?: boolean }) => {
      navigate({ to: href });
    },
    [navigate],
  );

  const replace = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (href: string, options?: { scroll?: boolean }) => {
      navigate({ to: href, replace: true });
    },
    [navigate],
  );

  const back = useCallback(() => {
    window.history.back();
  }, []);

  const forward = useCallback(() => {
    window.history.forward();
  }, []);

  const refresh = useCallback(() => {
    // No-op in TanStack Router — mutations handle cache invalidation via TanStack Query
    router.invalidate();
  }, [router]);

  const prefetch = useCallback(
    (href: string) => {
      // Warm the destination's code-split chunk (and any route loaders) so a
      // subsequent navigation commits without a cold chunk fetch. TanStack
      // Links already do this on hover via `defaultPreload: 'intent'`; this
      // covers programmatic navigations and non-Link anchors.
      router.preloadRoute({ to: href }).catch(() => {
        // Preload is best-effort — a failure just means the navigation loads cold.
      });
    },
    [router],
  );

  return useMemo(
    () => ({ push, replace, back, forward, refresh, prefetch }),
    [push, replace, back, forward, refresh, prefetch],
  );
}
