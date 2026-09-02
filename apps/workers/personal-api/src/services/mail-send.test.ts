/**
 * Reply/forward derivation rules for personal (consumer WeldMail) outbound mail.
 *
 * These are the parts of a send that are easy to get subtly wrong and expensive
 * to notice in production: a reply that CCs the sender back to themselves, a
 * subject that grows `Re: Re: Re:`, or a References chain that makes real mail
 * clients split one conversation into several. They're pure functions, so they
 * are pinned here without a database or the Workers send binding.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveForwardSubject,
  deriveReplyRecipients,
  deriveReplyReferences,
  deriveReplySubject,
} from './mail-send';
import type { PersonalMailMessageRow } from './mail-send';

type ReplySource = Pick<PersonalMailMessageRow, 'from' | 'to' | 'cc' | 'replyTo'>;

const SELF = 'me@weldmail.com';

function message(overrides: Partial<ReplySource> = {}): ReplySource {
  return {
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: SELF }],
    cc: null,
    replyTo: null,
    ...overrides,
  } as ReplySource;
}

describe('deriveReplyRecipients', () => {
  it('replies to the original sender only', () => {
    const { to, cc } = deriveReplyRecipients(SELF, message());
    expect(to).toEqual(['sender@example.com']);
    expect(cc).toEqual([]);
  });

  it('prefers Reply-To over From when the sender set one', () => {
    const { to } = deriveReplyRecipients(
      SELF,
      message({ replyTo: { email: 'desk@example.com' } }),
    );
    expect(to).toEqual(['desk@example.com']);
  });

  it('reply-all keeps the other To recipients and the Cc line', () => {
    const { to, cc } = deriveReplyRecipients(
      SELF,
      message({
        to: [{ email: SELF }, { email: 'colleague@example.com' }],
        cc: [{ email: 'watcher@example.com' }],
      }),
      true,
    );

    expect(to).toEqual(['sender@example.com', 'colleague@example.com']);
    expect(cc).toEqual(['watcher@example.com']);
  });

  it('never addresses the reply back to this mailbox', () => {
    const { to, cc } = deriveReplyRecipients(
      SELF,
      message({
        to: [{ email: SELF }],
        cc: [{ email: 'ME@WeldMail.com' }],
      }),
      true,
    );

    const all = [...to, ...cc].map((e) => e.toLowerCase());
    expect(all).not.toContain(SELF);
  });

  it('does not repeat an address that appears on both To and Cc', () => {
    const { to, cc } = deriveReplyRecipients(
      SELF,
      message({
        to: [{ email: 'colleague@example.com' }],
        cc: [{ email: 'colleague@example.com' }, { email: 'sender@example.com' }],
      }),
      true,
    );

    expect(to).toEqual(['sender@example.com', 'colleague@example.com']);
    expect(cc).toEqual([]);
  });

  it('falls back to the original recipients when replying to your own message', () => {
    // Replying from the Sent view: From is this mailbox, so there is no sender
    // to answer — the reply should go to whoever the message was addressed to.
    const { to } = deriveReplyRecipients(
      SELF,
      message({
        from: { email: SELF, name: 'Me' },
        to: [{ email: 'customer@example.com' }],
      }),
    );

    expect(to).toEqual(['customer@example.com']);
  });
});

describe('deriveReplySubject', () => {
  it('prefixes a fresh subject', () => {
    expect(deriveReplySubject('Invoice 42')).toBe('Re: Invoice 42');
  });

  it('does not stack prefixes on an existing reply', () => {
    expect(deriveReplySubject('Re: Invoice 42')).toBe('Re: Invoice 42');
    expect(deriveReplySubject('RE: Invoice 42')).toBe('RE: Invoice 42');
  });

  it('handles a missing subject without emitting a trailing space', () => {
    expect(deriveReplySubject(null)).toBe('Re:');
    expect(deriveReplySubject('')).toBe('Re:');
  });
});

describe('deriveForwardSubject', () => {
  it('prefixes a fresh subject', () => {
    expect(deriveForwardSubject('Invoice 42')).toBe('Fwd: Invoice 42');
  });

  it('accepts either Fwd: or Fw: as already forwarded', () => {
    expect(deriveForwardSubject('Fwd: Invoice 42')).toBe('Fwd: Invoice 42');
    expect(deriveForwardSubject('Fw: Invoice 42')).toBe('Fw: Invoice 42');
  });

  it('does not treat a reply as already forwarded', () => {
    expect(deriveForwardSubject('Re: Invoice 42')).toBe('Fwd: Re: Invoice 42');
  });
});

describe('deriveReplyReferences', () => {
  const source = (
    references: string[] | null,
    messageId: string,
  ): Pick<PersonalMailMessageRow, 'references' | 'messageId'> =>
    ({ references, messageId }) as Pick<PersonalMailMessageRow, 'references' | 'messageId'>;

  it('appends the answered message to the existing chain', () => {
    expect(deriveReplyReferences(source(['<a@x>'], '<b@x>'))).toEqual(['<a@x>', '<b@x>']);
  });

  it('starts a chain when the original had none', () => {
    expect(deriveReplyReferences(source(null, '<b@x>'))).toEqual(['<b@x>']);
  });

  it('normalises ids to angle-bracketed form', () => {
    expect(deriveReplyReferences(source(['a@x'], 'b@x'))).toEqual(['<a@x>', '<b@x>']);
  });

  it('de-duplicates so a long thread does not accumulate repeats', () => {
    expect(deriveReplyReferences(source(['<a@x>', '<b@x>'], '<b@x>'))).toEqual([
      '<a@x>',
      '<b@x>',
    ]);
  });
});
