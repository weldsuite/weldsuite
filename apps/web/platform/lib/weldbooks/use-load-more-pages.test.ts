import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLoadMorePages, type PageSnapshot } from './use-load-more-pages';

interface Row {
  id: string;
}

const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));

/** Renders the hook with a snapshot the test can swap, like a query result changing. */
function setup(first: PageSnapshot<Row, string | undefined>) {
  let snapshot = first;
  const hook = renderHook(() => {
    const paging = useLoadMorePages<Row, string | undefined>(undefined);
    return { paging, view: paging.view(snapshot) };
  });
  return {
    hook,
    show: (next: PageSnapshot<Row, string | undefined>) => {
      snapshot = next;
      hook.rerender();
    },
  };
}

describe('useLoadMorePages', () => {
  it('is loading until the first page arrives, then shows it', () => {
    const { hook, show } = setup({ rows: undefined, nextKey: null });
    expect(hook.result.current.view.isLoading).toBe(true);
    expect(hook.result.current.view.items).toEqual([]);

    show({ rows: rows('a', 'b'), nextKey: 'c1' });
    expect(hook.result.current.view.isLoading).toBe(false);
    expect(hook.result.current.view.items).toEqual(rows('a', 'b'));
    expect(hook.result.current.view.hasMore).toBe(true);
  });

  it('keeps the loaded pages when it moves on to the next one', () => {
    const { hook, show } = setup({ rows: rows('a', 'b'), nextKey: 'c1' });

    act(() => hook.result.current.view.loadMore());
    expect(hook.result.current.paging.key).toBe('c1');
    // The next page is on its way: the rows so far stay, and no further page is asked for.
    show({ rows: undefined, nextKey: null });
    expect(hook.result.current.view.items).toEqual(rows('a', 'b'));
    expect(hook.result.current.view.isLoadingMore).toBe(true);
    expect(hook.result.current.view.hasMore).toBe(false);

    show({ rows: rows('c'), nextKey: null });
    expect(hook.result.current.view.items).toEqual(rows('a', 'b', 'c'));
    expect(hook.result.current.view.isLoadingMore).toBe(false);
    expect(hook.result.current.view.hasMore).toBe(false);
  });

  it('treats the rows of a previous key (keepPreviousData) as not arrived yet', () => {
    const { hook, show } = setup({ rows: rows('a'), nextKey: 'c1' });
    act(() => hook.result.current.view.loadMore());

    show({ rows: rows('a'), nextKey: 'c1', isPlaceholder: true });
    expect(hook.result.current.view.items).toEqual(rows('a'));
    expect(hook.result.current.view.hasMore).toBe(false);
  });

  it('shows the previous rows while a changed filter loads, then only the new ones', () => {
    const { hook, show } = setup({ rows: rows('a', 'b'), nextKey: 'c1' });
    act(() => hook.result.current.view.loadMore());
    show({ rows: rows('c'), nextKey: null });
    expect(hook.result.current.view.items).toEqual(rows('a', 'b', 'c'));

    act(() => hook.result.current.paging.reset());
    expect(hook.result.current.paging.key).toBeUndefined();
    show({ rows: undefined, nextKey: null });
    expect(hook.result.current.view.isLoading).toBe(false);
    expect(hook.result.current.view.items).toEqual(rows('c'));

    show({ rows: rows('z'), nextKey: null });
    expect(hook.result.current.view.items).toEqual(rows('z'));
  });

  it('does not fall back to stale rows when the new first page fails', () => {
    const { hook, show } = setup({ rows: rows('a'), nextKey: null });
    act(() => hook.result.current.paging.reset());
    show({ rows: undefined, nextKey: null, isError: true });
    expect(hook.result.current.view.items).toEqual([]);
    expect(hook.result.current.view.isLoading).toBe(false);
  });
});
