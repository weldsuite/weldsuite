import { describe, it, expect } from 'vitest';
import {
  aggregateSubscriptions,
  isSafeUnsubscribeUrl,
  parseListUnsubscribe,
  parseMailto,
  parseRawHeaders,
} from '@weldsuite/email/list-unsubscribe';

describe('parseListUnsubscribe', () => {
  it('returns null without the header', () => {
    expect(parseListUnsubscribe({ subject: 'hi' })).toBeNull();
  });

  it('extracts https + mailto and detects one-click', () => {
    const info = parseListUnsubscribe({
      'List-Unsubscribe': '<mailto:unsub@news.shop.com?subject=stop>, <https://news.shop.com/u/abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'List-Id': 'Shop News <news.shop.com>',
    });
    expect(info).toEqual({
      url: 'https://news.shop.com/u/abc',
      mailto: 'mailto:unsub@news.shop.com?subject=stop',
      oneClick: true,
      listId: 'news.shop.com',
    });
  });

  it('is not one-click without a https URL', () => {
    const info = parseListUnsubscribe({
      'list-unsubscribe': '<mailto:u@x.com>',
      'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
    });
    expect(info?.oneClick).toBe(false);
    expect(info?.url).toBeNull();
  });

  it('ignores plain http and unsafe hosts', () => {
    expect(parseListUnsubscribe({ 'List-Unsubscribe': '<http://x.com/u>' })).toBeNull();
    expect(parseListUnsubscribe({ 'List-Unsubscribe': '<https://127.0.0.1/u>' })).toBeNull();
  });

  it('accepts a bare URI without angle brackets', () => {
    expect(parseListUnsubscribe({ 'List-Unsubscribe': 'https://x.com/u' })?.url).toBe('https://x.com/u');
  });
});

describe('isSafeUnsubscribeUrl', () => {
  it.each([
    ['https://mail.example.com/unsub?id=1', true],
    ['http://mail.example.com/unsub', false],
    ['https://localhost/unsub', false],
    ['https://10.0.0.1/unsub', false],
    ['https://[::1]/unsub', false],
    ['https://svc.internal/unsub', false],
    ['https://user:pw@example.com/unsub', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(isSafeUnsubscribeUrl(url)).toBe(expected);
  });
});

describe('parseMailto', () => {
  it('defaults subject and body', () => {
    expect(parseMailto('mailto:leave@list.org')).toEqual({
      to: 'leave@list.org',
      subject: 'unsubscribe',
      body: 'unsubscribe',
    });
  });

  it('decodes subject and body', () => {
    expect(parseMailto('mailto:leave@list.org?subject=Remove%20me&body=id%3D42')).toEqual({
      to: 'leave@list.org',
      subject: 'Remove me',
      body: 'id=42',
    });
  });

  it('rejects invalid addresses', () => {
    expect(parseMailto('mailto:not-an-address')).toBeNull();
  });
});

describe('parseRawHeaders', () => {
  it('unfolds continuation lines and stops at the body', () => {
    const raw = [
      'From: Shop <news@shop.com>',
      'List-Unsubscribe: <https://shop.com/u>,',
      '\t<mailto:u@shop.com>',
      '',
      'List-Unsubscribe: <https://evil.com/in-body>',
    ].join('\r\n');
    const headers = parseRawHeaders(raw);
    expect(headers['list-unsubscribe']).toBe('<https://shop.com/u>, <mailto:u@shop.com>');
    expect(headers.from).toBe('Shop <news@shop.com>');
  });
});

describe('aggregateSubscriptions', () => {
  const raw = (sender: string, unsub = `<https://${sender.split('@')[1]}/u>`) =>
    `From: ${sender}\r\nList-Unsubscribe: ${unsub}\r\n\r\nbody`;

  it('groups by lower-cased sender and keeps the newest targets', () => {
    const rows = [
      { from: { email: 'News@Shop.com', name: 'Shop' }, subject: 'Newest', receivedAt: new Date('2026-09-10'), rawHeaders: raw('news@shop.com', '<https://shop.com/new>') },
      { from: { email: 'news@shop.com', name: 'Shop' }, subject: 'Older', receivedAt: new Date('2026-08-01'), rawHeaders: raw('news@shop.com', '<https://shop.com/old>') },
      { from: { email: 'friend@example.com' }, subject: 'Hi', receivedAt: new Date('2026-09-01'), rawHeaders: 'From: friend@example.com\r\n\r\nhello' },
    ];
    const result = aggregateSubscriptions(rows);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      senderEmail: 'news@shop.com',
      senderDomain: 'shop.com',
      unsubscribeUrl: 'https://shop.com/new',
      messageCount: 2,
      lastSubject: 'Newest',
      firstReceivedAt: new Date('2026-08-01'),
      lastReceivedAt: new Date('2026-09-10'),
    });
  });

  it('skips rows without stored headers', () => {
    expect(aggregateSubscriptions([{ from: { email: 'a@b.com' }, subject: null, receivedAt: new Date(), rawHeaders: null }])).toEqual([]);
  });
});
