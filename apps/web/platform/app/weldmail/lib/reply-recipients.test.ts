import { describe, expect, it } from 'vitest';
import type { Mail } from '@/lib/api/types/apps/mail.types';
import {
  buildReplyRecipients,
  hasExtraReplyAllRecipients,
  OPTIMISTIC_ID_PREFIX,
  recipientsForReplyTo,
  resolveReplyTarget,
} from './reply-recipients';

const SELF = 'gert@weldhost.com';

function mail(overrides: Partial<Mail.Email>): Mail.Email {
  return {
    id: 'msg_1',
    messageId: '<1@example.com>',
    subject: 'Hello',
    from: 'Someone',
    fromEmail: 'someone@example.com',
    to: [SELF],
    cc: [],
    bcc: [],
    bodyText: '',
    bodyHtml: '',
    preview: '',
    date: new Date('2026-11-04T10:00:00Z'),
    isRead: true,
    isStarred: false,
    isImportant: false,
    isDraft: false,
    isSpam: false,
    isDeleted: false,
    hasAttachments: false,
    size: 0,
    labels: [],
    folder: 'Inbox',
    ...overrides,
  };
}

describe('buildReplyRecipients · answering someone else', () => {
  const incoming = mail({
    fromEmail: 'sara@plaid.com',
    to: [SELF, 'teammate@example.com'],
    cc: ['watcher@example.com', 'Gert@WeldHost.com'],
  });

  it('a plain reply goes to the sender only', () => {
    expect(buildReplyRecipients(incoming, { all: false, selfEmail: SELF })).toEqual(['sara@plaid.com']);
  });

  it('reply-all adds the other To and Cc recipients and leaves us off', () => {
    expect(buildReplyRecipients(incoming, { all: true, selfEmail: SELF })).toEqual([
      'sara@plaid.com',
      'teammate@example.com',
      'watcher@example.com',
    ]);
  });
});

describe('buildReplyRecipients · following up on our own sent mail', () => {
  it('goes to the people the mail was sent to, never back to us', () => {
    // The thread from the bug report: our own follow-up, Reply all.
    const sent = mail({ fromEmail: SELF, from: 'Gert van den Berg', to: ['sara@plaid.com'] });
    expect(buildReplyRecipients(sent, { all: false, selfEmail: SELF })).toEqual(['sara@plaid.com']);
    expect(buildReplyRecipients(sent, { all: true, selfEmail: SELF })).toEqual(['sara@plaid.com']);
  });

  it('reply-all keeps the Cc line, plain reply does not', () => {
    const sent = mail({ fromEmail: SELF, to: ['client@example.com', SELF], cc: ['boss@example.com'] });
    expect(buildReplyRecipients(sent, { all: false, selfEmail: SELF })).toEqual(['client@example.com']);
    expect(buildReplyRecipients(sent, { all: true, selfEmail: SELF })).toEqual([
      'client@example.com',
      'boss@example.com',
    ]);
  });

  it('matches our address regardless of casing', () => {
    const sent = mail({ fromEmail: 'Gert@WeldHost.com', to: ['sara@plaid.com'] });
    expect(buildReplyRecipients(sent, { all: true, selfEmail: SELF })).toEqual(['sara@plaid.com']);
  });

  it('a note we only sent to ourselves is answered to ourselves', () => {
    const note = mail({ fromEmail: SELF, to: [SELF] });
    expect(buildReplyRecipients(note, { all: true, selfEmail: SELF })).toEqual([SELF]);
  });
});

describe('hasExtraReplyAllRecipients', () => {
  it('is false when reply-all would reach the same people as a plain reply', () => {
    expect(hasExtraReplyAllRecipients(mail({ fromEmail: 'a@example.com', to: [SELF] }), SELF)).toBe(false);
    expect(hasExtraReplyAllRecipients(mail({ fromEmail: SELF, to: ['a@example.com', 'b@example.com'] }), SELF)).toBe(
      false,
    );
  });

  it('is true when reply-all adds somebody', () => {
    expect(hasExtraReplyAllRecipients(mail({ fromEmail: 'a@example.com', to: [SELF, 'b@example.com'] }), SELF)).toBe(
      true,
    );
    expect(hasExtraReplyAllRecipients(mail({ fromEmail: SELF, to: ['a@example.com'], cc: ['b@example.com'] }), SELF)).toBe(
      true,
    );
  });
});

describe('resolveReplyTarget', () => {
  const opened = mail({ id: 'msg_opened', date: new Date('2026-10-22T10:25:00Z') });
  const older = mail({ id: 'msg_older', date: new Date('2026-10-22T10:33:00Z') });
  const newest = mail({ id: 'msg_newest', date: new Date('2026-11-04T09:51:00Z') });
  const all = [opened, older, newest];

  it('answers the message the user picked, not the one the page opened on', () => {
    expect(resolveReplyTarget(all, 'msg_older', newest).id).toBe('msg_older');
    expect(resolveReplyTarget(all, 'msg_opened', newest).id).toBe('msg_opened');
  });

  it('falls back to the newest message when nothing was picked', () => {
    expect(resolveReplyTarget(all, null, newest).id).toBe('msg_newest');
  });

  it('never answers an optimistic placeholder, which has no server id', () => {
    const justSent = mail({ id: `${OPTIMISTIC_ID_PREFIX}123`, date: new Date('2026-11-04T09:55:00Z') });
    expect(resolveReplyTarget([...all, justSent], justSent.id, justSent).id).toBe('msg_newest');
  });
});

describe('recipientsForReplyTo', () => {
  // Sara's mail to me and a teammate, then my reply-all to it, still an
  // optimistic placeholder (from the mailbox, `to` the joined compose field).
  const sara = mail({
    id: 'msg_sara',
    fromEmail: 'sara@plaid.com',
    to: [SELF, 'teammate@example.com'],
    date: new Date('2026-11-04T09:00:00Z'),
  });
  const placeholder = mail({
    id: `${OPTIMISTIC_ID_PREFIX}1`,
    fromEmail: SELF,
    to: ['sara@plaid.com, teammate@example.com'],
    date: new Date('2026-11-04T09:05:00Z'),
  });
  const thread = [sara, placeholder];

  it('shows what the server will send: the stored message it answers, not the placeholder', () => {
    expect(recipientsForReplyTo(thread, placeholder, placeholder, { all: false, selfEmail: SELF })).toEqual([
      'sara@plaid.com',
    ]);
    expect(recipientsForReplyTo(thread, placeholder, placeholder, { all: true, selfEmail: SELF })).toEqual([
      'sara@plaid.com',
      'teammate@example.com',
    ]);
  });

  it('uses the picked message itself when it is stored', () => {
    expect(recipientsForReplyTo(thread, sara, placeholder, { all: false, selfEmail: SELF })).toEqual([
      'sara@plaid.com',
    ]);
  });
});
