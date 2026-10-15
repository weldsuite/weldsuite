import { describe, expect, it } from 'vitest';
import {
  classifyKind,
  domainOf,
  isFirstContact,
  messageRecipients,
  parseAddressList,
  scrubText,
  truncate,
  utcDay,
  utcHour,
} from './recipients';
import type { CorrespondentContext } from './types';

describe('parseAddressList', () => {
  it('reads the {email, name} array the schema stores, lower-cased and de-duplicated', () => {
    expect(
      parseAddressList([
        { email: ' Anna@Example.COM ', name: ' Anna ' },
        { email: 'anna@example.com', name: 'Duplicate' },
        { email: 'bram@example.org' },
      ]),
    ).toEqual([
      { email: 'anna@example.com', name: 'Anna' },
      { email: 'bram@example.org', name: null },
    ]);
  });

  it('tolerates bare strings, "Name <address>" and comma lists from older rows', () => {
    expect(parseAddressList(['Anna <anna@example.com>', 'bram@example.org']).map((e) => e.email)).toEqual([
      'anna@example.com',
      'bram@example.org',
    ]);
    expect(parseAddressList('a@x.io, b@y.io; c@z.io').map((e) => e.email)).toEqual(['a@x.io', 'b@y.io', 'c@z.io']);
    expect(parseAddressList({ email: 'solo@x.io' }).map((e) => e.email)).toEqual(['solo@x.io']);
  });

  it('drops invalid entries and non-address values', () => {
    expect(parseAddressList([{ email: 'not-an-address' }, { email: 42 }, null, 7, 'undisclosed-recipients:;'])).toEqual([]);
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList(undefined)).toEqual([]);
  });
});

describe('messageRecipients', () => {
  it('de-duplicates across to, cc and bcc and counts only new bcc recipients', () => {
    const { all, bcc } = messageRecipients(
      [{ email: 'a@x.io' }],
      [{ email: 'b@x.io' }, { email: 'a@x.io' }],
      [{ email: 'b@x.io' }, { email: 'c@x.io' }, { email: 'd@x.io' }],
    );
    expect(all.map((r) => r.email)).toEqual(['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io']);
    expect(bcc).toBe(2);
  });
});

describe('isFirstContact', () => {
  const ctx: CorrespondentContext = {
    firstInbound: new Map([
      ['wrote-before@x.io', new Date('2026-10-01T00:00:00Z')],
      ['wrote-after@x.io', new Date('2026-10-20T00:00:00Z')],
    ]),
    ownAddresses: new Set(['me@acme.test', 'sales@acme-ws.weldmail.com']),
    ownDomains: new Set(['acme.test']),
  };
  const sentAt = new Date('2026-10-10T00:00:00Z');

  it('is false for people who wrote in before the send', () => {
    expect(isFirstContact('wrote-before@x.io', sentAt, ctx)).toBe(false);
  });

  it('is true for people who never wrote, or only wrote back after the send', () => {
    expect(isFirstContact('stranger@x.io', sentAt, ctx)).toBe(true);
    expect(isFirstContact('wrote-after@x.io', sentAt, ctx)).toBe(true);
  });

  it("is false for the workspace's own mailboxes and custom domains", () => {
    expect(isFirstContact('sales@acme-ws.weldmail.com', sentAt, ctx)).toBe(false);
    expect(isFirstContact('colleague@acme.test', sentAt, ctx)).toBe(false);
  });
});

describe('classifyKind', () => {
  it('reads in_reply_to / is_reply as a reply, is_forwarded as a forward, else a new thread', () => {
    expect(classifyKind({ inReplyTo: '<a@b>', isReply: false, isForwarded: false })).toBe('reply');
    expect(classifyKind({ inReplyTo: null, isReply: true, isForwarded: false })).toBe('reply');
    expect(classifyKind({ inReplyTo: '  ', isReply: null, isForwarded: true })).toBe('forward');
    expect(classifyKind({ inReplyTo: null, isReply: null, isForwarded: null })).toBe('new_thread');
  });
});

describe('text helpers', () => {
  it('scrubs addresses, links, phone numbers and personal tokens, then truncates', () => {
    const out = scrubText('Hi Anna, mail anna@acme.com or call +31 6 1234 5678, see https://acme.com/x for Acme', ['anna', 'acme'], 200);
    expect(out).toBe('Hi [name], mail [email] or call [number], see [url] for [name]');
    expect(scrubText('a'.repeat(50), [], 10)).toBe(`${'a'.repeat(9)}…`);
  });

  it('truncate keeps short text and marks cut text', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('exactly ten', 5)).toBe('exac…');
  });

  it('formats UTC days and hours and extracts domains', () => {
    const date = new Date('2026-10-10T23:30:00Z');
    expect(utcDay(date)).toBe('2026-10-10');
    expect(utcHour(date)).toBe('2026-10-10T23');
    expect(domainOf('a@Sub.Example.com')).toBe('sub.example.com');
    expect(domainOf('nope')).toBe('');
  });
});
