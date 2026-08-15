import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ThreadSummary } from '../lib/thread-utils';
import { mailThreadListKey } from '../lib/optimistic-thread-list';
import { useOptimisticThreadList } from './use-optimistic-thread-list';

function thread(
  partial: Partial<ThreadSummary> & Pick<ThreadSummary, 'threadId' | 'latestMessageId'>,
): ThreadSummary {
  return {
    subject: 's',
    participants: [],
    latestSender: '',
    latestSenderEmail: '',
    latestDate: new Date(0),
    preview: '',
    messageCount: 1,
    unreadCount: 0,
    hasAttachments: false,
    isStarred: false,
    labels: ['INBOX'],
    messages: [],
    ...partial,
  };
}

const a = thread({ threadId: 't1', latestMessageId: 'm1' });
const b = thread({ threadId: 't2', latestMessageId: 'm2' });
const c = thread({ threadId: 't3', latestMessageId: 'm3' });
const d = thread({ threadId: 't4', latestMessageId: 'm4' });
const e = thread({ threadId: 't5', latestMessageId: 'm5' });
const page1 = mailThreadListKey({ accountId: 'unified', folder: 'inbox', page: 1, pageSize: 25 });
const page2 = mailThreadListKey({ accountId: 'unified', folder: 'inbox', page: 2, pageSize: 25 });

describe('useOptimisticThreadList', () => {
  it('hides a row immediately and restores it on unhide', () => {
    const { result } = renderHook(
      ({ threads, listKey }) => useOptimisticThreadList(threads, listKey),
      { initialProps: { threads: [a, b, c], listKey: page1 } },
    );

    expect(result.current.threads).toEqual([a, b, c]);

    act(() => {
      result.current.hideThread({ messageId: 'm1', threadId: 't1' });
    });
    expect(result.current.threads.map((t) => t.threadId)).toEqual(['t2', 't3']);
    expect(result.current.hiddenCount).toBe(1);

    act(() => {
      result.current.unhideThread({ messageId: 'm1', threadId: 't1' });
    });
    expect(result.current.threads).toEqual([a, b, c]);
    expect(result.current.hiddenCount).toBe(0);
  });

  it('keeps the row hidden across a stale server snapshot, then drops the overlay once the server omits it', () => {
    const { result, rerender } = renderHook(
      ({ threads, listKey }) => useOptimisticThreadList(threads, listKey),
      { initialProps: { threads: [a, b, c], listKey: page1 } },
    );

    act(() => {
      result.current.hideThread({ messageId: 'm1', threadId: 't1' });
    });

    rerender({ threads: [a, b, c], listKey: page1 });
    expect(result.current.threads.map((t) => t.threadId)).toEqual(['t2', 't3']);
    expect(result.current.hiddenCount).toBe(1);

    rerender({ threads: [b, c], listKey: page1 });
    expect(result.current.threads.map((t) => t.threadId)).toEqual(['t2', 't3']);
    expect(result.current.hiddenCount).toBe(0);
  });

  it('keeps the overlay across a page change before archive completion, then still hides on return to the stale originating page', () => {
    const { result, rerender } = renderHook(
      ({ threads, listKey }) => useOptimisticThreadList(threads, listKey),
      { initialProps: { threads: [a, b, c], listKey: page1 } },
    );

    act(() => {
      result.current.hideThread({ messageId: 'm1', threadId: 't1' });
    });

    // Navigate to page 2 while the archive request is still in flight.
    rerender({ threads: [d, e], listKey: page2 });
    expect(result.current.threads.map((t) => t.threadId)).toEqual(['t4', 't5']);
    expect(result.current.hiddenCount).toBe(0);

    // Intermediate empty snapshot (new query key has no data yet).
    rerender({ threads: [], listKey: page2 });
    expect(result.current.hiddenCount).toBe(0);

    // Return to page 1 before the originating query has dropped the row.
    rerender({ threads: [a, b, c], listKey: page1 });
    expect(result.current.threads.map((t) => t.threadId)).toEqual(['t2', 't3']);
    expect(result.current.hiddenCount).toBe(1);

    rerender({ threads: [b, c], listKey: page1 });
    expect(result.current.threads.map((t) => t.threadId)).toEqual(['t2', 't3']);
    expect(result.current.hiddenCount).toBe(0);
  });
});
