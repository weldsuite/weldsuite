import { useMemo } from 'react';
import { useLocation, useRouter as useTanStackRouter } from '@tanstack/react-router';

/**
 * The parts of next/navigation's `useRouter` the console used, on TanStack
 * Router. `refresh()` re-runs the current route's loaders (Next re-rendered the
 * server components), so the page shows what an action just wrote.
 */
export function useRouter() {
  const router = useTanStackRouter();
  return useMemo(
    () => ({
      refresh: () => router.invalidate(),
      push: (href: string) => router.navigate({ href }),
      replace: (href: string) => router.navigate({ href, replace: true }),
      back: () => router.history.back(),
    }),
    [router],
  );
}

/** next/navigation's `usePathname`. */
export function usePathname(): string {
  return useLocation({ select: (location) => location.pathname });
}
