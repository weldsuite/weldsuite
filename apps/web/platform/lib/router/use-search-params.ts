import { useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';

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
