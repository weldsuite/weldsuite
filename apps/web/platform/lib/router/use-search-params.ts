import { useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';

/**
 * The read-only half of `URLSearchParams`. Next.js ships a class by this name;
 * we only need the type, and the mutators are deliberately omitted — the object
 * below is derived from router state, so calling `.set()` on it would silently
 * no-op instead of navigating.
 */
export type ReadonlyURLSearchParams = Omit<
  URLSearchParams,
  'set' | 'append' | 'delete' | 'sort'
>;

/**
 * Compat layer: drop-in replacement for `useSearchParams()` from `next/navigation`.
 * Returns a `ReadonlyURLSearchParams` object so `.get()`, `.getAll()`,
 * `.has()`, `.toString()`, `.entries()`, `.keys()`, `.values()`, and `.forEach()` work.
 */
export function useSearchParams(): ReadonlyURLSearchParams {
  const search = useSearch({ strict: false }) as Record<string, unknown>;

  return useMemo(() => {
    const usp = new URLSearchParams();
    for (const [key, value] of Object.entries(search)) {
      if (Array.isArray(value)) {
        for (const v of value) {
          usp.append(key, String(v));
        }
      } else if (value !== undefined && value !== null) {
        usp.set(key, String(value));
      }
    }
    return usp as ReadonlyURLSearchParams;
  }, [search]);
}
