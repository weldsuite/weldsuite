import { flattenPages, nextCursorParam, nextPageParam } from '@/lib/pagination';

const page = <T extends { id: string }>(data: T[], hasMore: boolean, cursor: string | null = null) => ({
  data,
  pagination: { totalCount: 0, hasMore, cursor },
});

describe('nextCursorParam (keyset lists)', () => {
  it('returns the cursor while the server reports more rows', () => {
    expect(nextCursorParam(page([{ id: 'a' }], true, 'a'))).toBe('a');
  });

  it('stops when there is nothing more, even if a cursor is present', () => {
    expect(nextCursorParam(page([{ id: 'a' }], false, 'a'))).toBeUndefined();
  });

  it('stops when the server says more but sends no cursor', () => {
    expect(nextCursorParam(page([{ id: 'a' }], true, null))).toBeUndefined();
  });
});

describe('nextPageParam (offset lists)', () => {
  it('asks for the page after the ones already loaded', () => {
    const first = page([{ id: 'a' }], true);
    expect(nextPageParam(first, [first])).toBe(2);
    expect(nextPageParam(first, [first, first, first])).toBe(4);
  });

  it('stops when hasMore is false', () => {
    const last = page([{ id: 'a' }], false);
    expect(nextPageParam(last, [last, last])).toBeUndefined();
  });

  it('ignores the always-null cursor', () => {
    const first = page([{ id: 'a' }], true, null);
    expect(nextPageParam(first, [first])).toBe(2);
  });
});

describe('flattenPages', () => {
  it('returns an empty list before the first page arrives', () => {
    expect(flattenPages(undefined)).toEqual([]);
  });

  it('concatenates pages preserving order', () => {
    const rows = flattenPages([
      page([{ id: 'a' }, { id: 'b' }], true, 'b'),
      page([{ id: 'c' }], false),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops repeated ids, keeping the first occurrence (page 1 served again after a deleted cursor row)', () => {
    const rows = flattenPages([
      page([{ id: 'a', n: 1 }, { id: 'b', n: 2 }], true, 'b'),
      page([{ id: 'a', n: 3 }, { id: 'b', n: 4 }], false),
    ]);
    expect(rows).toEqual([
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
    ]);
  });
});
