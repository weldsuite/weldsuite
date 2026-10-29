/**
 * k-way merge: ordering, tie-breaking, and `hasMore` across mailbox pages.
 */
import { describe, expect, it } from 'vitest';
import {
  byOrderKey,
  compareMessageOrder,
  compareThreadOrder,
  mergeSortedPages,
  type MergeSource,
  type MessageOrderKey,
  type ThreadOrderKey,
} from './merge';

describe('compareThreadOrder', () => {
  it('sorts by latestAt descending', () => {
    const a: ThreadOrderKey = { latestAt: 2, accountId: 'a', threadKey: 't1' };
    const b: ThreadOrderKey = { latestAt: 1, accountId: 'a', threadKey: 't2' };
    expect(compareThreadOrder(a, b)).toBeLessThan(0);
    expect(compareThreadOrder(b, a)).toBeGreaterThan(0);
  });

  it('breaks a latestAt tie by accountId ascending, then threadKey ascending', () => {
    const base = { latestAt: 5 };
    expect(compareThreadOrder({ ...base, accountId: 'a', threadKey: 'z' }, { ...base, accountId: 'b', threadKey: 'a' })).toBeLessThan(0);
    expect(
      compareThreadOrder({ ...base, accountId: 'a', threadKey: 'z' }, { ...base, accountId: 'a', threadKey: 'y' }),
    ).toBeGreaterThan(0);
    expect(compareThreadOrder({ ...base, accountId: 'a', threadKey: 't' }, { ...base, accountId: 'a', threadKey: 't' })).toBe(
      0,
    );
  });
});

describe('compareMessageOrder', () => {
  it('sorts by sentAt descending, then id descending', () => {
    expect(compareMessageOrder({ sentAt: 2, id: 'a' }, { sentAt: 1, id: 'z' })).toBeLessThan(0);
    expect(compareMessageOrder({ sentAt: 1, id: 'b' }, { sentAt: 1, id: 'a' })).toBeLessThan(0);
    expect(compareMessageOrder({ sentAt: 1, id: 'a' }, { sentAt: 1, id: 'a' })).toBe(0);
  });
});

describe('mergeSortedPages ordering', () => {
  it('interleaves two mailboxes into one globally sorted page', () => {
    const inbox1: MergeSource<ThreadOrderKey> = {
      items: [
        { latestAt: 100, accountId: 'acc_1', threadKey: 't1' },
        { latestAt: 80, accountId: 'acc_1', threadKey: 't2' },
      ],
      hasMore: false,
    };
    const inbox2: MergeSource<ThreadOrderKey> = {
      items: [
        { latestAt: 90, accountId: 'acc_2', threadKey: 't3' },
        { latestAt: 70, accountId: 'acc_2', threadKey: 't4' },
      ],
      hasMore: false,
    };
    const result = mergeSortedPages([inbox1, inbox2], compareThreadOrder, 10);
    expect(result.items.map((t) => t.threadKey)).toEqual(['t1', 't3', 't2', 't4']);
    expect(result.hasMore).toBe(false);
  });

  it('respects the limit and truncates the merged page', () => {
    const a: MergeSource<ThreadOrderKey> = {
      items: [
        { latestAt: 3, accountId: 'a', threadKey: 'x' },
        { latestAt: 2, accountId: 'a', threadKey: 'y' },
      ],
      hasMore: false,
    };
    const b: MergeSource<ThreadOrderKey> = {
      items: [{ latestAt: 1, accountId: 'b', threadKey: 'z' }],
      hasMore: false,
    };
    const result = mergeSortedPages([a, b], compareThreadOrder, 2);
    expect(result.items.map((t) => t.threadKey)).toEqual(['x', 'y']);
    expect(result.hasMore).toBe(true); // 3 candidates for a limit of 2
  });

  it('hasMore is true when any single source had more, even if the merge fit under the limit', () => {
    const a: MergeSource<ThreadOrderKey> = {
      items: [{ latestAt: 1, accountId: 'a', threadKey: 'only' }],
      hasMore: true, // this mailbox has further rows beyond the page it returned
    };
    const result = mergeSortedPages([a], compareThreadOrder, 50);
    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(true);
  });

  it('hasMore is false only when every source is exhausted and nothing was trimmed', () => {
    const a: MergeSource<ThreadOrderKey> = { items: [{ latestAt: 1, accountId: 'a', threadKey: 'x' }], hasMore: false };
    const result = mergeSortedPages([a], compareThreadOrder, 50);
    expect(result.hasMore).toBe(false);
  });

  it('breaks ties stably by source order, then by within-page order', () => {
    const same: ThreadOrderKey = { latestAt: 1, accountId: 'same', threadKey: 'same' };
    const a: MergeSource<{ tag: string } & ThreadOrderKey> = { items: [{ ...same, tag: 'from-a-1' }, { ...same, tag: 'from-a-2' }], hasMore: false };
    const b: MergeSource<{ tag: string } & ThreadOrderKey> = { items: [{ ...same, tag: 'from-b' }], hasMore: false };
    const result = mergeSortedPages([a, b], compareThreadOrder, 10);
    expect(result.items.map((t) => t.tag)).toEqual(['from-a-1', 'from-a-2', 'from-b']);
  });

  it('merges an empty set of sources into an empty, exhausted page', () => {
    const result = mergeSortedPages([], compareThreadOrder, 10);
    expect(result).toEqual({ items: [], hasMore: false });
  });

  it('works for the message order too', () => {
    const a: MergeSource<MessageOrderKey> = { items: [{ sentAt: 10, id: 'm1' }], hasMore: false };
    const b: MergeSource<MessageOrderKey> = { items: [{ sentAt: 20, id: 'm2' }], hasMore: false };
    const result = mergeSortedPages([a, b], compareMessageOrder, 10);
    expect(result.items.map((m) => m.id)).toEqual(['m2', 'm1']);
  });
});

describe('byOrderKey', () => {
  it('projects an arbitrary row to its order key before comparing', () => {
    interface Row {
      id: string;
      meta: { sentAt: number };
    }
    const compare = byOrderKey<Row, MessageOrderKey>(compareMessageOrder, (row) => ({
      sentAt: row.meta.sentAt,
      id: row.id,
    }));
    const rows: Row[] = [{ id: 'a', meta: { sentAt: 1 } }, { id: 'b', meta: { sentAt: 5 } }];
    expect([...rows].sort(compare).map((r) => r.id)).toEqual(['b', 'a']);
  });
});
