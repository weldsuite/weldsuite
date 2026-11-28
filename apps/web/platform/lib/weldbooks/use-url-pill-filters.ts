import { useCallback, useMemo, useState } from 'react';
import type { ActiveFilter } from '@/components/entity-list';
import { usePathname, useRouter, useSearchParams } from '@/lib/router';
import { withQuery } from '@/lib/with-query';

/**
 * Filter pills of a list whose chosen values live in the address (`?status=overdue`).
 *
 * A finished `is` pill on one of `urlFields` is the URL's: it is read from the
 * query string and written back to it, so a link opens the list filtered, the
 * filter survives a reload and navigating away and back, and other query
 * parameters (the object panel's `?stack=`) are left alone. Every other pill
 * (negated, unfinished, on another field) stays in component state.
 *
 * A value outside `allowed[field]` is ignored, so a mistyped link shows the
 * whole list instead of an empty one.
 */
export function useUrlPillFilters(
  urlFields: readonly string[],
  allowed: Readonly<Record<string, readonly string[]>> = {},
): { activeFilters: ActiveFilter[]; onFiltersChange: (next: ActiveFilter[]) => void } {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [local, setLocal] = useState<ActiveFilter[]>([]);
  const query = searchParams.toString();

  const fieldsKey = urlFields.join(',');
  const allowedKey = JSON.stringify(allowed);
  const activeFilters = useMemo(() => {
    const params = new URLSearchParams(query);
    const urlPills: ActiveFilter[] = [];
    for (const field of fieldsKey.split(',').filter(Boolean)) {
      const value = params.get(field);
      const choices = allowed[field];
      if (!value || (choices && !choices.includes(value))) continue;
      urlPills.push({ id: `url:${field}`, field, operator: 'is', value });
    }
    return [...urlPills, ...local];
    // `allowed` is read through its serialised key: callers pass a fresh literal each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, fieldsKey, allowedKey, local]);

  const onFiltersChange = useCallback(
    (next: ActiveFilter[]) => {
      const isUrlPill = (f: ActiveFilter) => urlFields.includes(f.field) && f.operator === 'is' && f.value !== '';
      setLocal(next.filter((f) => !isUrlPill(f)));
      const params = new URLSearchParams(query);
      let changed = false;
      for (const field of urlFields) {
        const value = next.find((f) => isUrlPill(f) && f.field === field)?.value;
        if ((params.get(field) ?? undefined) === value) continue;
        changed = true;
        if (value) params.set(field, value);
        else params.delete(field);
      }
      if (changed) router.replace(withQuery(pathname, params.toString()));
    },
    [urlFields, query, pathname, router],
  );

  return { activeFilters, onFiltersChange };
}
