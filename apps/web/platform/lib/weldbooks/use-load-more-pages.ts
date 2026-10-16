import { useState } from 'react';

/** What a paged query returned for the key the list is on. */
export interface PageSnapshot<T, K> {
  /** Rows of the page for the current key; undefined until it has arrived. */
  rows: T[] | undefined;
  /** Key of the page after this one, or null on the last page. */
  nextKey: K | null;
  /** The rows are those of the previous key (`keepPreviousData`), not of the current one. */
  isPlaceholder?: boolean;
  isError?: boolean;
}

interface PagingState<T, K> {
  key: K;
  /** Pages already loaded before the current key's page. */
  previous: T[];
  /** The rows last shown, kept on screen while a changed filter loads. */
  seen: T[] | undefined;
}

/**
 * Cursor (or page-number) paging for an infinite-scroll list: the pages loaded
 * so far are kept, so the list grows as `loadMore` moves to the next key.
 *
 *   const paging = useLoadMorePages<Row, string | undefined>(undefined);
 *   const query = useRows({ cursor: paging.key, ...filters });
 *   const list = paging.view({ rows: query.data?.data, nextKey: ..., isPlaceholder: query.isPlaceholderData });
 *
 * Call `reset()` whenever a filter or the search changes. Until the new first
 * page arrives the previous rows stay on screen, so the toolbar (and a search
 * box being typed in) is not replaced by a spinner.
 */
export function useLoadMorePages<T, K>(initialKey: K) {
  const [state, setState] = useState<PagingState<T, K>>({ key: initialKey, previous: [], seen: undefined });

  const reset = () => setState((current) => ({ ...current, key: initialKey, previous: [] }));

  const view = ({ rows, nextKey, isPlaceholder = false, isError = false }: PageSnapshot<T, K>) => {
    const current = isPlaceholder ? undefined : rows;
    // Remember the latest page, derived during render (the documented way to adjust state to a new value).
    if (current && current !== state.seen) setState((s) => ({ ...s, seen: current }));

    let items: T[];
    if (current) items = [...state.previous, ...current];
    else if (state.previous.length > 0 || isError) items = state.previous;
    else items = state.seen ?? [];

    return {
      items,
      /** Nothing to show yet: the very first page is on its way. */
      isLoading: !current && state.previous.length === 0 && state.seen === undefined && !isError,
      /** A further page is on its way. */
      isLoadingMore: !current && state.previous.length > 0 && !isError,
      hasMore: !!current && nextKey !== null,
      loadMore: () => {
        if (!current || nextKey === null) return;
        setState((s) => ({ ...s, key: nextKey, previous: [...s.previous, ...current] }));
      },
    };
  };

  return { key: state.key, reset, view };
}
