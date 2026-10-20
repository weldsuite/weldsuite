import { describe, expect, it } from 'vitest';
import type { MailMessageRow } from '@weldsuite/app-api-client/domains/mail-messages';
import type { ThreadSummary } from './thread-utils';
import {
  earliestSnoozedUntil,
  isOutgoingFolder,
  outgoingRecipients,
  snoozedMessageIds,
  summarizeRecipients,
} from './row-display';

function message(overrides: Partial<MailMessageRow>): MailMessageRow {
  return {
    id: 'm1',
    createdAt: '2026-01-01T10:00:00.000Z',
    sentDate: null,
    receivedDate: null,
    scheduledFor: null,
    to: null,
    labels: [],
    ...overrides,
  } as MailMessageRow;
}

function thread(messages: MailMessageRow[], participants: string[] = []): ThreadSummary {
  return { messages, participants } as unknown as ThreadSummary;
}

describe('isOutgoingFolder', () => {
  it('is true for the folders that list mail the user wrote', () => {
    expect(isOutgoingFolder('sent')).toBe(true);
    expect(isOutgoingFolder('Drafts')).toBe(true);
    expect(isOutgoingFolder('scheduled')).toBe(true);
    expect(isOutgoingFolder('inbox')).toBe(false);
  });
});

describe('outgoingRecipients', () => {
  it('uses the recipients of the newest sent message, not a received reply', () => {
    const sent = message({ id: 'sent', labels: ['SENT'], sentDate: '2026-01-02T10:00:00.000Z', to: [{ email: 'jane@example.com', name: 'Jane' }] });
    const reply = message({ id: 'reply', labels: ['INBOX'], receivedDate: '2026-01-03T10:00:00.000Z', to: [{ email: 'me@example.com' }] });
    expect(outgoingRecipients(thread([reply, sent]), 'sent')).toEqual([{ email: 'jane@example.com', name: 'Jane' }]);
  });

  it('falls back to the draft addresses when the row has no messages', () => {
    expect(outgoingRecipients(thread([], ['a@example.com', 'b@example.com']), 'drafts')).toEqual([
      { email: 'a@example.com' },
      { email: 'b@example.com' },
    ]);
  });
});

describe('summarizeRecipients', () => {
  it('prefers names and keeps the first avatar', () => {
    expect(
      summarizeRecipients([
        { email: 'jane@example.com', name: 'Jane Doe', avatarUrl: 'https://img/jane.png' },
        { email: 'bob@example.com', name: null },
      ]),
    ).toEqual({ names: 'Jane Doe, bob@example.com', avatarUrl: 'https://img/jane.png' });
  });

  it('is null without recipients', () => {
    expect(summarizeRecipients([])).toBeNull();
  });
});

describe('snooze helpers', () => {
  const soon = message({ id: 'a', snoozedUntil: '2026-02-01T08:00:00.000Z', labels: ['SNOOZED'] });
  const later = message({ id: 'b', snoozedUntil: '2026-03-01T08:00:00.000Z', labels: ['SNOOZED'] });
  const awake = message({ id: 'c', labels: ['INBOX'] });

  it('finds the soonest wake time', () => {
    expect(earliestSnoozedUntil([later, awake, soon])?.toISOString()).toBe('2026-02-01T08:00:00.000Z');
    expect(earliestSnoozedUntil([awake])).toBeNull();
  });

  it('lists the snoozed messages only', () => {
    expect(snoozedMessageIds([soon, later, awake])).toEqual(['a', 'b']);
  });
});
