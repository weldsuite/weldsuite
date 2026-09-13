import { describe, expect, it } from 'vitest';
import type { ThreadSummary } from './thread-utils';
import {
  addHiddenId,
  countHiddenForList,
  countHiddenOnServer,
  filterHiddenThreads,
  findThreadIdToHide,
  folderHidesOnArchive,
  mailThreadListKey,
  removeHiddenId,
  retainHiddenIdsStillOnServer,
  topUpThreadList,
} from './optimistic-thread-list';

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
const page1 = mailThreadListKey({ accountId: 'unified', folder: 'inbox', page: 1, pageSize: 25 });
const page2 = mailThreadListKey({ accountId: 'unified', folder: 'inbox', page: 2, pageSize: 25 });

describe('folderHidesOnArchive', () => {
  it('hides from inbox only', () => {
    expect(folderHidesOnArchive('inbox')).toBe(true);
    expect(folderHidesOnArchive('INBOX')).toBe(true);
    expect(folderHidesOnArchive('starred')).toBe(false);
    expect(folderHidesOnArchive('all')).toBe(false);
    expect(folderHidesOnArchive('archive')).toBe(false);
  });
});

describe('findThreadIdToHide', () => {
  it('uses an explicit threadId even when the row is already gone', () => {
    expect(findThreadIdToHide([a, b], { messageId: 'm1', threadId: 't1' })).toBe('t1');
    expect(findThreadIdToHide([b], { messageId: 'm1', threadId: 't1' })).toBe('t1');
  });

  it('matches a non-latest message via thread messages', () => {
    const grouped = thread({
      threadId: 't1',
      latestMessageId: 'm2',
      messages: [{ id: 'm1' }, { id: 'm2' }] as ThreadSummary['messages'],
    });
    expect(findThreadIdToHide([grouped, b], { messageId: 'm1' })).toBe('t1');
  });
});

describe('filterHiddenThreads', () => {
  it('returns the same array when nothing is hidden', () => {
    const list = [a, b, c];
    expect(filterHiddenThreads(list, new Map())).toBe(list);
  });

  it('drops hidden rows without mutating the source', () => {
    const list = [a, b, c];
    expect(filterHiddenThreads(list, new Map([['t1', page1]]))).toEqual([b, c]);
    expect(list).toHaveLength(3);
  });
});

describe('topUpThreadList', () => {
  const d = thread({ threadId: 't4', latestMessageId: 'm4' });
  const e = thread({ threadId: 't5', latestMessageId: 'm5' });

  it('returns the visible list unchanged when it already fills the page', () => {
    const visible = [a, b, c];
    expect(topUpThreadList(visible, [d, e], 3)).toBe(visible);
  });

  it('appends next-page rows until the page is full', () => {
    expect(topUpThreadList([b, c], [d, e], 3).map((t) => t.threadId)).toEqual([
      't2',
      't3',
      't4',
    ]);
  });

  it('skips duplicates already on the current page', () => {
    expect(topUpThreadList([b, c], [c, d], 3).map((t) => t.threadId)).toEqual([
      't2',
      't3',
      't4',
    ]);
  });

  it('skips threads already hidden from a prior top-up', () => {
    const hidden = new Map([['t4', page1]]);
    expect(topUpThreadList([b, c], [d, e], 3, hidden).map((t) => t.threadId)).toEqual([
      't2',
      't3',
      't5',
    ]);
  });

  it('leaves the list short when the next page cannot fill it', () => {
    expect(topUpThreadList([c], [d], 3).map((t) => t.threadId)).toEqual(['t3', 't4']);
    expect(topUpThreadList([c], [], 3).map((t) => t.threadId)).toEqual(['t3']);
  });
});

describe('countHiddenOnServer', () => {
  it('counts only rows present in the current snapshot', () => {
    const hidden = new Map([['t1', page1], ['t9', page1]]);
    expect(countHiddenOnServer([a, b, c], hidden)).toBe(1);
    expect(countHiddenOnServer([b, c], hidden)).toBe(0);
  });
});

describe('countHiddenForList', () => {
  it('counts every overlay entry scoped to the list key', () => {
    const hidden = new Map([
      ['t1', page1],
      ['t4', page1],
      ['t9', page2],
    ]);
    expect(countHiddenForList(hidden, page1)).toBe(2);
    expect(countHiddenForList(hidden, page2)).toBe(1);
  });
});

describe('retainHiddenIdsStillOnServer', () => {
  it('keeps the same Map when the originating page still has the row (stale refetch)', () => {
    const hidden = new Map([['t1', page1]]);
    expect(retainHiddenIdsStillOnServer([a, b], hidden, page1)).toBe(hidden);
  });

  it('drops ids once the originating page refreshes without them', () => {
    const hidden = new Map([['t1', page1], ['t2', page1]]);
    expect([...retainHiddenIdsStillOnServer([b, c], hidden, page1).keys()]).toEqual(['t2']);
  });

  it('keeps ids from another page when the current snapshot omits them', () => {
    const hidden = new Map([['t1', page1]]);
    const retained = retainHiddenIdsStillOnServer([b, c], hidden, page2);
    expect(retained).toBe(hidden);
    expect(retained.get('t1')).toBe(page1);
  });

  it('keeps ids when the originating query has no rows yet (loading placeholder)', () => {
    const hidden = new Map([['t1', page1]]);
    expect(retainHiddenIdsStillOnServer([], hidden, page1)).toBe(hidden);
    expect(retainHiddenIdsStillOnServer([], hidden, page2)).toBe(hidden);
  });

  it('keeps topped-up ids that are only present on the next page', () => {
    const hidden = new Map([['t4', page1]]);
    const retained = retainHiddenIdsStillOnServer(
      [a, b],
      hidden,
      page1,
      new Set(['t4']),
    );
    expect(retained).toBe(hidden);
  });

  it('drops topped-up ids once neither page still has them', () => {
    const hidden = new Map([['t4', page1]]);
    expect([
      ...retainHiddenIdsStillOnServer([a, b], hidden, page1, new Set(['t5'])).keys(),
    ]).toEqual([]);
  });

  it('returns the original empty map without allocating', () => {
    const hidden = new Map<string, string>();
    expect(retainHiddenIdsStillOnServer([a], hidden, page1)).toBe(hidden);
  });
});

describe('addHiddenId / removeHiddenId', () => {
  it('is a no-op when the id is already present or absent', () => {
    const hidden = new Map([['t1', page1]]);
    expect(addHiddenId(hidden, 't1', page1)).toBe(hidden);
    expect(removeHiddenId(hidden, 't2')).toBe(hidden);
  });

  it('adds and removes without mutating the source', () => {
    const hidden = new Map([['t1', page1]]);
    const added = addHiddenId(hidden, 't2', page1);
    expect([...added.keys()]).toEqual(['t1', 't2']);
    expect(added.get('t2')).toBe(page1);
    expect([...hidden.keys()]).toEqual(['t1']);
    expect([...removeHiddenId(hidden, 't1').keys()]).toEqual([]);
    expect([...hidden.keys()]).toEqual(['t1']);
  });
});
