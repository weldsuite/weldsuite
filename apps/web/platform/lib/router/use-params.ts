import { useParams as useTanStackParams } from '@tanstack/react-router';

/**
 * Compat layer: drop-in replacement for `useParams()` from `next/navigation`.
 * Returns the route params as a plain object (matching Next.js signature).
 */
export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  return useTanStackParams({ strict: false }) as T;
}
