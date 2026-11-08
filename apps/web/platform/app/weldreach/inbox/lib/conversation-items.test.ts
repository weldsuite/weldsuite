import { describe, expect, it } from 'vitest';
import { messageFixture, threadFixture } from '@/app/weldreach/components/engage/test-utils';
import { threadToConversationItem } from './conversation-items';

const t = (key: string) => key;

function summary(...args: Parameters<typeof threadFixture>) {
  return threadFixture(...args).summary;
}

describe('threadToConversationItem', () => {
  it('names the prospect and carries the latest reply as subject and preview', () => {
    const item = threadToConversationItem(
      summary([messageFixture('msg_in', { snippet: 'Sounds interesting' })], { threadKey: 'thr_1' }),
      t,
    );

    expect(item).toMatchObject({ id: 'thr_1', name: 'Ana Jansen', email: 'ana@acme.com', isRead: false, unreadCount: 1 });
    expect(item).toMatchObject({ subject: 'Re: Quick question', preview: 'Sounds interesting' });
  });

  it('falls back to the address, then to "unknown sender"', () => {
    const noName = summary([messageFixture('msg_in')], {
      prospect: { id: 'prs_1', email: 'ana@acme.com', firstName: null, lastName: null, companyName: null, personId: null },
    });
    expect(threadToConversationItem(noName, t).name).toBe('ana@acme.com');
    expect(threadToConversationItem(summary([messageFixture('msg_in')], { prospect: null }), t).name).toBe(
      'reachEngage.inbox.unknownSender',
    );
  });

  it('shows the reply label and a bounce as coloured chips, but not "unclassified"', () => {
    const labelled = threadToConversationItem(
      summary([messageFixture('msg_in', { label: 'not_interested', readAt: '2026-10-12T10:01:00Z' })]),
      t,
    );
    expect(labelled.labels).toEqual(['reachEngage.labels.not_interested']);
    expect(labelled.labelColors).toEqual({ 'reachEngage.labels.not_interested': '#EF4444' });
    expect(labelled.isRead).toBe(true);

    const bounce = threadToConversationItem(
      summary([messageFixture('msg_in', { kind: 'bounce', label: 'unclassified' })]),
      t,
    );
    expect(bounce.labels).toEqual(['reachEngage.kinds.bounce']);
  });
});
