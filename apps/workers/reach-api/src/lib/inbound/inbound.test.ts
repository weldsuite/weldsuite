/**
 * Parsing rules for inbound mail, against realistic `.eml` fixtures: kind
 * detection (reply, auto-reply, bounce), DSN and plain-text bounce parsing,
 * reply text extraction and the opt-out rule.
 */

import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../email/__fixtures__/load';
import { parseInbound } from './mime';
import { classifyInbound } from './kind';
import { isUnsubscribeRequest } from './intent';
import { makeSnippet, normalizeSubject, replySubject, stripQuotedHistory, htmlToText } from './text';
import { normalizeMessageId, parseMessageIdList, syntheticMessageId } from './message-id';
import { parseInboundToken } from './token';
import { findEmails } from './strings';

async function parse(name: string) {
  return parseInbound(loadFixture(name));
}

describe('threading headers', () => {
  it('reads Message-ID, In-Reply-To and References without angle brackets', async () => {
    const parsed = await parse('gmail-reply.eml');
    expect(parsed.messageId).toBe('CAKx9Qm7vJ1-gmail-reply-1@mail.gmail.com');
    expect(parsed.inReplyTo).toBe('out-1001@getacme.com');
    expect(parsed.references).toEqual(['out-1001@getacme.com']);
    expect(parsed.from).toEqual({ email: 'jane@acme.nl', name: 'Jane Doe' });
    expect(parsed.to).toEqual(['sam@getacme.com']);
  });

  it('has no threading headers on a reply from a client that strips them', async () => {
    const parsed = await parse('reply-no-threading.eml');
    expect(parsed.inReplyTo).toBeNull();
    expect(parsed.references).toEqual([]);
    expect(parsed.from?.email).toBe('lisa@bluesky.io');
  });

  it('normalises ids', () => {
    expect(normalizeMessageId('<a@b>')).toBe('a@b');
    expect(normalizeMessageId('  a@b ')).toBe('a@b');
    expect(normalizeMessageId('')).toBeNull();
    expect(parseMessageIdList('<a@b> <c@d>\r\n <a@b>')).toEqual(['a@b', 'c@d']);
  });

  it('gives a message without Message-ID a stable synthetic one', async () => {
    const raw = new TextEncoder().encode('From: a@b.c\r\n\r\nhi');
    const first = await syntheticMessageId(raw);
    expect(first).toBe(await syntheticMessageId(raw));
    expect(first).not.toBe(await syntheticMessageId(new TextEncoder().encode('From: a@b.c\r\n\r\nhello')));
    expect(first.endsWith('@reach.invalid')).toBe(true);
  });
});

describe('kind detection', () => {
  it('Gmail reply is a reply', async () => {
    expect(classifyInbound(await parse('gmail-reply.eml')).kind).toBe('reply');
  });

  it('Outlook reply is a reply', async () => {
    expect(classifyInbound(await parse('outlook-reply.eml')).kind).toBe('reply');
  });

  it('English out-of-office (Auto-Submitted) is an auto-reply', async () => {
    const result = classifyInbound(await parse('ooo-en.eml'));
    expect(result.kind).toBe('auto_reply');
    expect(result.autoReplyReason).toContain('auto-submitted');
  });

  it('Dutch out-of-office without any header is caught by the subject', async () => {
    const result = classifyInbound(await parse('ooo-nl.eml'));
    expect(result.kind).toBe('auto_reply');
    expect(result.autoReplyReason).toBe('subject');
  });

  it('detects the header-based signals', () => {
    const base = { subject: 'Re: hi' } as const;
    const kind = (headers: Record<string, string>) =>
      classifyInbound({
        messageId: 'x@y',
        inReplyTo: null,
        references: [],
        from: { email: 'a@b.com', name: null },
        to: [],
        text: 'hello',
        headers,
        contentType: 'text/plain',
        reportParts: [],
        ...base,
      }).kind;
    expect(kind({ 'auto-submitted': 'auto-generated' })).toBe('auto_reply');
    expect(kind({ 'auto-submitted': 'no' })).toBe('reply');
    expect(kind({ 'x-autoreply': 'yes' })).toBe('auto_reply');
    expect(kind({ 'x-autorespond': 'yes' })).toBe('auto_reply');
    expect(kind({ precedence: 'bulk' })).toBe('auto_reply');
    expect(kind({ precedence: 'junk' })).toBe('auto_reply');
    expect(kind({ precedence: 'auto_reply' })).toBe('auto_reply');
    expect(kind({ 'x-auto-response-suppress': 'DR, RN, NRN, OOF, AutoReply' })).toBe('auto_reply');
    expect(kind({ 'x-auto-response-suppress': 'DR' })).toBe('reply');
  });

  it.each([
    ['Out of Office: back Monday'],
    ['Automatic reply: Quick question'],
    ['Autoreply: re your email'],
    ['Afwezig: Quick question'],
    ['Automatisch antwoord: Quick question'],
    ['Abwesenheitsnotiz: Frage'],
    ['Réponse automatique : Question'],
    ['RE: Out of office'],
  ])('flags the subject "%s" as an auto-reply', (subject) => {
    const kind = classifyInbound({
      messageId: 'x@y',
      inReplyTo: null,
      references: [],
      from: { email: 'a@b.com', name: null },
      to: [],
      subject,
      text: 'hello',
      headers: {},
      contentType: 'text/plain',
      reportParts: [],
    }).kind;
    expect(kind).toBe('auto_reply');
  });

  it('classifies every bounce fixture as a bounce', async () => {
    for (const name of ['bounce-gmail-dsn.eml', 'bounce-outlook-ndr.eml', 'bounce-postfix-dsn.eml', 'bounce-nondsn.eml', 'bounce-delayed.eml']) {
      expect(classifyInbound(await parse(name)).kind, name).toBe('bounce');
    }
  });
});

describe('bounce parsing', () => {
  it('Gmail DSN: failed recipient, status, original Message-ID', async () => {
    const { bounce } = classifyInbound(await parse('bounce-gmail-dsn.eml'));
    expect(bounce).toMatchObject({
      recipients: ['nobody@acme.nl'],
      originalMessageId: 'out-3001@getacme.com',
      status: '5.1.1',
      action: 'failed',
      permanent: true,
      addressRejected: true,
      source: 'dsn',
    });
  });

  it('Outlook / Exchange NDR', async () => {
    const { bounce } = classifyInbound(await parse('bounce-outlook-ndr.eml'));
    expect(bounce).toMatchObject({
      recipients: ['former.employee@bluesky.io'],
      originalMessageId: 'out-3002@getacme.com',
      status: '5.1.10',
      permanent: true,
      addressRejected: true,
    });
  });

  it('Postfix DSN with a headers-only original', async () => {
    const { bounce } = classifyInbound(await parse('bounce-postfix-dsn.eml'));
    expect(bounce).toMatchObject({
      recipients: ['gone@oldco.example'],
      originalMessageId: 'out-3003@getacme.com',
      status: '5.1.1',
      permanent: true,
      addressRejected: true,
    });
    expect(bounce?.diagnostic).toContain('User unknown');
  });

  it('plain-text Mail Delivery Subsystem notice: original id and recipient from the body', async () => {
    const { bounce } = classifyInbound(await parse('bounce-nondsn.eml'));
    expect(bounce).toMatchObject({
      recipients: ['missing.person@example.org'],
      originalMessageId: 'out-3004@getacme.com',
      status: '5.1.1',
      permanent: true,
      addressRejected: true,
      source: 'text',
    });
  });

  it('a delay notice is not permanent', async () => {
    const { bounce } = classifyInbound(await parse('bounce-delayed.eml'));
    expect(bounce).toMatchObject({
      recipients: ['slow@example.org'],
      originalMessageId: 'out-3005@getacme.com',
      status: '4.4.1',
      action: 'delayed',
      permanent: false,
      addressRejected: false,
    });
  });

  it('a policy rejection (5.7.x) is permanent but does not blame the address', () => {
    const { bounce } = classifyInbound({
      messageId: 'x@y',
      inReplyTo: null,
      references: [],
      from: { email: 'mailer-daemon@example.net', name: 'Mail Delivery System' },
      to: [],
      subject: 'Undelivered Mail Returned to Sender',
      text: '',
      headers: { 'content-type': 'multipart/report; report-type=delivery-status' },
      contentType: 'multipart/report; report-type=delivery-status',
      reportParts: [
        {
          mimeType: 'message/delivery-status',
          text: 'Reporting-MTA: dns; example.net\n\nFinal-Recipient: rfc822; boss@corp.example\nAction: failed\nStatus: 5.7.1\nDiagnostic-Code: smtp; 550 5.7.1 Message rejected as spam\n',
        },
      ],
    });
    expect(bounce).toMatchObject({ permanent: true, addressRejected: false, status: '5.7.1', recipients: ['boss@corp.example'] });
  });
});

describe('reply text', () => {
  it('cuts the "On ... wrote:" history and > lines', async () => {
    const parsed = await parse('gmail-reply.eml');
    const text = stripQuotedHistory(parsed.text);
    expect(text).toBe('Hi Sam,\n\nThis looks interesting. Can you send me a few more details and pricing?\n\nThanks,\nJane');
  });

  it('cuts the Outlook separator and From/Sent block', async () => {
    const parsed = await parse('outlook-reply.eml');
    const text = stripQuotedHistory(parsed.text);
    expect(text.startsWith('Not interested at the moment, please don')).toBe(true);
    expect(text).not.toContain('Sent: Monday');
    expect(text).not.toContain('warehouse network');
    expect(text.endsWith('Acme BV')).toBe(true);
  });

  it('decodes quoted-printable and windows-1252 bodies', async () => {
    const parsed = await parse('outlook-reply.eml');
    expect(parsed.text).toContain('don’t');
  });

  it('cuts wrapped attributions in several languages', () => {
    expect(stripQuotedHistory('Yes please.\n\nOn Mon, Oct 12, 2026 at 9:14 AM Sam Jansen <sam@getacme.com>\nwrote:\n> hi')).toBe('Yes please.');
    expect(stripQuotedHistory('Graag.\n\nOp ma 12 okt. 2026 om 09:14 schreef Sam Jansen <sam@getacme.com>:\n> hoi')).toBe('Graag.');
    expect(stripQuotedHistory('Gerne.\n\nAm 12.10.2026 um 09:14 schrieb Sam Jansen <sam@getacme.com>:\n> hallo')).toBe('Gerne.');
    expect(stripQuotedHistory("Oui.\n\nLe lun. 12 oct. 2026 à 09:14, Sam <sam@getacme.com> a écrit :\n> salut")).toBe('Oui.');
    expect(stripQuotedHistory('Sure\n\n-----Original Message-----\nFrom: Sam\nSent: Monday\nTo: Jane\nSubject: Hi\n\nquoted')).toBe('Sure');
  });

  it('keeps ordinary sentences that start with "On"', () => {
    const text = 'On Monday we can meet.\nOr on Tuesday.\nJane';
    expect(stripQuotedHistory(text)).toBe(text);
  });

  it('drops mobile signatures', () => {
    expect(stripQuotedHistory('Sounds good\n\nSent from my iPhone')).toBe('Sounds good');
  });

  it('turns HTML into text without the quote', () => {
    const html = '<div dir="ltr">Hi Sam,<br><br>Fine &amp; dandy</div><div class="gmail_quote"><blockquote>old</blockquote></div>';
    expect(htmlToText(html)).toBe('Hi Sam,\n\nFine & dandy');
  });

  it('builds a one-line snippet of at most 500 chars', () => {
    expect(makeSnippet('a\n\nb   c')).toBe('a b c');
    expect(makeSnippet('x'.repeat(900))).toHaveLength(500);
  });

  it('normalises subjects', () => {
    expect(normalizeSubject('Re: RE: Aw: Fwd: Hello')).toBe('Hello');
    expect(replySubject('RE: Hello')).toBe('Re: Hello');
    expect(replySubject(null)).toBe('Re:');
  });
});

describe('opt-out rule', () => {
  it.each([
    ['unsubscribe'],
    ['Unsubscribe'],
    ['STOP'],
    ['stop.'],
    ['Please unsubscribe me'],
    ['remove me'],
    ['Remove me from your list'],
    ['afmelden'],
    ['Uitschrijven'],
    ['abmelden'],
  ])('"%s" in the first line is an opt-out', (line) => {
    expect(isUnsubscribeRequest('Re: Hello', `${line}\n\nOn Mon wrote:\n> x`)).toBe(true);
  });

  it('subject "unsubscribe" with no body is an opt-out (mailto List-Unsubscribe)', () => {
    expect(isUnsubscribeRequest('unsubscribe', '')).toBe(true);
    expect(isUnsubscribeRequest('Re: Unsubscribe', '')).toBe(true);
  });

  it('does not fire on ordinary replies', () => {
    expect(isUnsubscribeRequest('Re: Hello', 'Please stop by our office tomorrow.')).toBe(false);
    expect(isUnsubscribeRequest('Re: Hello', 'Unsubscribe is not what I want, I am interested!')).toBe(false);
    expect(isUnsubscribeRequest('unsubscribe', 'x'.repeat(400))).toBe(false);
    expect(isUnsubscribeRequest('Re: Hello', '')).toBe(false);
  });

  it('the opt-out fixture reads as one', async () => {
    const parsed = await parse('unsubscribe-reply.eml');
    expect(isUnsubscribeRequest(parsed.subject, stripQuotedHistory(parsed.text))).toBe(true);
  });
});

describe('inbound token', () => {
  const domain = 'reply.weldsuite.org';
  it('takes the local part of an address on the inbound domain', () => {
    expect(parseInboundToken('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6@reply.weldsuite.org', domain)).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
    expect(parseInboundToken('Reach <ABCDEF123456@Reply.Weldsuite.org>', domain)).toBe('abcdef123456');
    expect(parseInboundToken('abcdef123456+x@reply.weldsuite.org', domain)).toBe('abcdef123456');
  });

  it('refuses other domains and malformed tokens', () => {
    expect(parseInboundToken('abcdef123456@example.com', domain)).toBeNull();
    expect(parseInboundToken('short@reply.weldsuite.org', domain)).toBeNull();
    expect(parseInboundToken('has space@reply.weldsuite.org', domain)).toBeNull();
    expect(parseInboundToken('not-an-address', domain)).toBeNull();
    expect(parseInboundToken('x'.repeat(80) + '@reply.weldsuite.org', domain)).toBeNull();
  });

  it('accepts any domain when none is configured', () => {
    expect(parseInboundToken('abcdef123456@anything.test', undefined)).toBe('abcdef123456');
  });
});

describe('hostile input', () => {
  // Strangers write the mail we parse; none of these may take more than a moment of CPU.
  const cases: Array<[string, string]> = [
    ['unclosed tags', '<a '.repeat(150_000)],
    ['one long run of dashes', '-'.repeat(600_000)],
    ['at signs', 'a@'.repeat(150_000)],
    ['one long local part', 'a'.repeat(400_000)],
    ['header-looking text', 'From:'.repeat(80_000)],
    ['quoted lines', '> x\n'.repeat(80_000)],
    ['attribution starts', 'On x\n'.repeat(80_000)],
    ['trailing punctuation', `${'x'.repeat(100_000)}${'.'.repeat(100_000)}`],
  ];

  it.each(cases)('%s', (_name, text) => {
    const started = performance.now();
    stripQuotedHistory(text);
    htmlToText(text);
    findEmails(text);
    isUnsubscribeRequest(text, text);
    normalizeSubject(text);
    classifyInbound({
      messageId: null,
      inReplyTo: null,
      references: [],
      from: { email: 'mailer-daemon@example.net', name: 'Mail Delivery System' },
      to: [],
      subject: 'Undelivered Mail Returned to Sender',
      text,
      headers: {},
      contentType: 'text/plain',
      reportParts: [],
    });
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('finds addresses without confusing neighbours', () => {
    expect(findEmails('Mail a.b@c-d.example, <x_y+z@sub.example.org>. And bad@x or @nothing.com.').map((f) => f.email)).toEqual([
      'a.b@c-d.example',
      'x_y+z@sub.example.org',
    ]);
  });
});
