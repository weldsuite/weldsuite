import { useRouterState } from '@tanstack/react-router';

/**
 * Compat layer: drop-in replacement for `usePathname()` from `next/navigation`.
 * Returns the current pathname string.
 */
export function usePathname(): string {
  return useRouterState({ select: (s) => s.location.pathname });
}
