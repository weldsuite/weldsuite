import { useEffect, useMemo, useState } from 'react';
import type { MailThreadSearch } from '@/hooks/queries/use-mail-queries';

/** Search results come as one page; a search is for finding a mail, not for paging. */
export const MAIL_SEARCH_PAGE_SIZE = 50;

/** Trim every field and drop the empty ones, so `{ search: '  ' }` is no search at all. */
export function normalizeThreadSearch(filter: MailThreadSearch): MailThreadSearch {
  const out: MailThreadSearch = {};
  const text = (value: string | undefined) => value?.trim() || undefined;
  if (text(filter.search)) out.search = text(filter.search);
  if (text(filter.from)) out.from = text(filter.from);
  if (text(filter.to)) out.to = text(filter.to);
  if (text(filter.subject)) out.subject = text(filter.subject);
  if (filter.hasAttachment) out.hasAttachment = true;
  return out;
}

export function hasThreadSearch(filter: MailThreadSearch): boolean {
  return Object.keys(normalizeThreadSearch(filter)).length > 0;
}

/**
 * The thread list's search box and Filter panel, as query parameters for the
 * server. Typing is debounced; clearing the search applies at once.
 *
 * Both used to filter only the 25 threads already on screen, so mail on
 * another page or in another folder could not be found.
 */
export function useMailThreadSearch(delayMs = 300) {
  const [filter, setFilter] = useState<MailThreadSearch>({});
  const [applied, setApplied] = useState<MailThreadSearch>({});
  const key = JSON.stringify(normalizeThreadSearch(filter));

  useEffect(() => {
    const next = JSON.parse(key) as MailThreadSearch;
    if (!hasThreadSearch(next)) {
      setApplied(next);
      return;
    }
    const timer = setTimeout(() => setApplied(next), delayMs);
    return () => clearTimeout(timer);
  }, [key, delayMs]);

  return useMemo(
    () => ({ search: applied, isSearching: hasThreadSearch(applied), setSearch: setFilter }),
    [applied],
  );
}
