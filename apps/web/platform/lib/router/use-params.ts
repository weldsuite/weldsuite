import { useParams as useTanStackParams } from '@tanstack/react-router';

/**
 * Compat layer: drop-in replacement for `useParams()` from `next/navigation`.
 * Returns the route params as a plain object (matching Next.js signature).
 */
export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- strict:false widens the router's registered route tree to `any` internally; there is no non-any generic that satisfies RouterCore's constraint here.
  return useTanStackParams<any, undefined, false>({ strict: false }) as T;
}
