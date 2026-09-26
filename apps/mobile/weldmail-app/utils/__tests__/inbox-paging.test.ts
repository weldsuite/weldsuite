import {
  appendPage,
  isOlderThan,
  mergeRefreshedFirstPage,
  withThreadCounts,
} from '../inbox-paging';

const row = (id: string, sentDate: string, threadId: string | null = null) => ({
  id,
  sentDate,
  receivedDate: null,
  createdAt: sentDate,
  threadId,
  threadCount: undefined as number | undefined,
});

describe('inbox-paging', () => {
  const cursorA = { workspace: 'm4' };
  const cursorB = { workspace: 'm6' };

  it('orders by date, then id, newest first', () => {
    expect(isOlderThan(row('a', '2026-09-01'), row('b', '2026-09-02'))).toBe(true);
    expect(isOlderThan(row('a', '2026-09-02'), row('b', '2026-09-02'))).toBe(true);
    expect(isOlderThan(row('b', '2026-09-02'), row('a', '2026-09-02'))).toBe(false);
  });

  it('replaces the list when its paging position is unknown (cache paint)', () => {
    const prev = [row('m1', '2026-09-05'), row('m9', '2026-01-01')];
    const first = [row('m1', '2026-09-05')];
    const out = mergeRefreshedFirstPage(prev, first, cursorA, undefined);
    expect(out.list.map((m) => m.id)).toEqual(['m1']);
    expect(out.cursor).toBe(cursorA);
  });

  it('keeps pages the user already scrolled into, with their cursor', () => {
    const prev = [
      row('m2', '2026-09-04'),
      row('m3', '2026-09-03'),
      row('m4', '2026-09-02'),
      row('m5', '2026-09-01'),
      row('m6', '2026-08-31'),
    ];
    // New mail arrived; the refreshed first page now ends at m3.
    const first = [row('m1', '2026-09-05'), row('m2', '2026-09-04'), row('m3', '2026-09-03')];
    const out = mergeRefreshedFirstPage(prev, first, cursorA, cursorB);
    expect(out.list.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    expect(out.cursor).toBe(cursorB);
  });

  it('uses the first page cursor when nothing older was loaded', () => {
    const prev = [row('m2', '2026-09-04')];
    const first = [row('m1', '2026-09-05'), row('m2', '2026-09-04')];
    const out = mergeRefreshedFirstPage(prev, first, cursorA, cursorB);
    expect(out.list.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(out.cursor).toBe(cursorA);
  });

  it('takes the first page as-is when it already holds everything', () => {
    const prev = [row('m2', '2026-09-04'), row('m3', '2026-09-03')];
    const first = [row('m2', '2026-09-04')];
    const out = mergeRefreshedFirstPage(prev, first, null, cursorB);
    expect(out.list.map((m) => m.id)).toEqual(['m2']);
    expect(out.cursor).toBeNull();
  });

  it('appends a page without duplicating rows', () => {
    const prev = [row('m1', '2026-09-05'), row('m2', '2026-09-04')];
    const out = appendPage(prev, [row('m2', '2026-09-04'), row('m3', '2026-09-03')]);
    expect(out.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('counts loaded messages per thread', () => {
    const out = withThreadCounts([
      row('m1', '2026-09-05', 't1'),
      row('m2', '2026-09-04', 't1'),
      row('m3', '2026-09-03'),
    ]);
    expect(out.map((m) => m.threadCount)).toEqual([2, 2, 1]);
  });
});
