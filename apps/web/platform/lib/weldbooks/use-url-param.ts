import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from '@/lib/router';
import { withQuery } from '@/lib/with-query';

/**
 * One query parameter as state (`?role=supplier`): read from the address, written back with a
 * replace so the Back button is not filled with filter changes. Other parameters (the object
 * panel's `?stack=`) are kept. A value outside `allowed` reads as unset, so a mistyped link
 * shows the whole list.
 */
export function useUrlParam<T extends string>(
  name: string,
  allowed: readonly T[],
  basePath?: string,
): [T | undefined, (next: T | undefined) => void] {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const raw = searchParams.get(name);
  const value = allowed.find((choice) => choice === raw);
  const query = searchParams.toString();

  const set = useCallback(
    (next: T | undefined) => {
      const params = new URLSearchParams(query);
      if (next) params.set(name, next);
      else params.delete(name);
      router.replace(withQuery(basePath ?? pathname, params.toString()));
    },
    [query, name, router, basePath, pathname],
  );

  return [value, set];
}
