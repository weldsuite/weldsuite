import { describe, expect, it } from 'vitest';
import type { ThreadSummary } from './thread-utils';
import {
  addHiddenId,
  filterHiddenThreads,
  findThreadIdToHide,
  folderHidesOnArchive,
  removeHiddenId,
  retainHiddenIdsStillOnServer,
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
    expect(filterHiddenThreads(list, new Set())).toBe(list);
  });

  it('drops hidden rows without mutating the source', () => {
    const list = [a, b, c];
    expect(filterHiddenThreads(list, new Set(['t1']))).toEqual([b, c]);
    expect(list).toHaveLength(3);
  });
});

describe('retainHiddenIdsStillOnServer', () => {
  it('keeps the same Set when the server still has the row (stale refetch)', () => {
    const hidden = new Set(['t1']);
    expect(retainHiddenIdsStillOnServer([a, b], hidden)).toBe(hidden);
  });

  it('drops ids the server no longer returns', () => {
    const hidden = new Set(['t1', 't2']);
    expect([...retainHiddenIdsStillOnServer([b, c], hidden)]).toEqual(['t2']);
  });

  it('returns the original empty set without allocating', () => {
    const hidden = new Set<string>();
    expect(retainHiddenIdsStillOnServer([a], hidden)).toBe(hidden);
  });
});

describe('addHiddenId / removeHiddenId', () => {
  it('is a no-op when the id is already present or absent', () => {
    const hidden = new Set(['t1']);
    expect(addHiddenId(hidden, 't1')).toBe(hidden);
    expect(removeHiddenId(hidden, 't2')).toBe(hidden);
  });

  it('adds and removes without mutating the source', () => {
    const hidden = new Set(['t1']);
    expect([...addHiddenId(hidden, 't2')]).toEqual(['t1', 't2']);
    expect([...hidden]).toEqual(['t1']);
    expect([...removeHiddenId(hidden, 't1')]).toEqual([]);
    expect([...hidden]).toEqual(['t1']);
  });
});
