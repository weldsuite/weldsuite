import { describe, it, expect } from 'vitest';
import type { ThreadSummary } from './thread-utils';
import { getNextThreadHref, hrefForThread, threadContainsMessage } from './next-thread';

function thread(partial: Partial<ThreadSummary> & Pick<ThreadSummary, 'threadId' | 'latestMessageId'>): ThreadSummary {
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

const unified = { isUnified: true, folder: 'inbox', accountId: 'unified' };
const perAccount = { isUnified: false, folder: 'inbox', accountId: 'acc_1' };

describe('getNextThreadHref', () => {
  const a = thread({ threadId: 't1', latestMessageId: 'm1', accountId: 'acc_a' });
  const b = thread({ threadId: 't2', latestMessageId: 'm2', accountId: 'acc_b' });
  const c = thread({ threadId: 't3', latestMessageId: 'm3', accountId: 'acc_c' });

  it('returns the next conversation in the unified list', () => {
    expect(getNextThreadHref([a, b, c], { messageId: 'm1', threadId: 't1' }, unified)).toBe(
      '/weldmail/unified/inbox/m2?accountId=acc_b',
    );
  });

  it('stays on the per-account mailbox, not another account', () => {
    expect(getNextThreadHref([a, b], { messageId: 'm1', threadId: 't1' }, perAccount)).toBe(
      '/weldmail/acc_1/inbox/m2',
    );
  });

  it('returns null on the last conversation', () => {
    expect(getNextThreadHref([a, b], { messageId: 'm2', threadId: 't2' }, unified)).toBeNull();
  });

  it('returns null when the current message is not in the list', () => {
    expect(getNextThreadHref([a, b], { messageId: 'missing' }, unified)).toBeNull();
  });

  it('matches a non-latest message via threadId so archive still advances', () => {
    expect(getNextThreadHref([a, b], { messageId: 'older-in-t1', threadId: 't1' }, unified)).toBe(
      '/weldmail/unified/inbox/m2?accountId=acc_b',
    );
  });
});

describe('hrefForThread', () => {
  it('keeps unified archive-done navigation inside /weldmail/unified', () => {
    const t = thread({ threadId: 't1', latestMessageId: 'm9', accountId: 'acc_other' });
    expect(hrefForThread(t, unified)).toBe('/weldmail/unified/inbox/m9?accountId=acc_other');
    expect(hrefForThread(t, unified)).not.toContain('/weldmail/acc_other/');
  });
});

describe('threadContainsMessage', () => {
  it('matches a sibling message on the thread', () => {
    const t = thread({
      threadId: 't1',
      latestMessageId: 'm2',
      messages: [{ id: 'm1' }, { id: 'm2' }] as ThreadSummary['messages'],
    });
    expect(threadContainsMessage(t, 'm1')).toBe(true);
    expect(threadContainsMessage(t, 'm9')).toBe(false);
  });
});
