import { describe, expect, it } from 'vitest';
import { checkSafeUrl, isBlockedHost, isSafeUrl } from './safe-url';

describe('checkSafeUrl', () => {
  it('accepts a public https URL and keeps path and query', () => {
    const r = checkSafeUrl('https://splunk.example.com:8088/services/collector/event?channel=abc');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.pathname).toBe('/services/collector/event');
  });

  it('accepts a public IPv4 literal', () => {
    expect(isSafeUrl('https://8.8.8.8/ingest')).toBe(true);
  });

  it('refuses anything but https', () => {
    for (const url of ['http://example.com/x', 'ftp://example.com', 'javascript:alert(1)', 'wss://example.com']) {
      expect(isSafeUrl(url), url).toBe(false);
    }
  });

  it('refuses credentials in the URL', () => {
    expect(isSafeUrl('https://user:pw@example.com/x')).toBe(false);
    expect(isSafeUrl('https://user@example.com/x')).toBe(false);
  });

  it('refuses text that is not a URL', () => {
    for (const url of ['', 'not a url', '//example.com', 'example.com/x']) expect(isSafeUrl(url), url).toBe(false);
  });

  it.each([
    'localhost',
    'LOCALHOST',
    'foo.localhost',
    'db.internal',
    'printer.local',
    'metadata',
    'intranet',
    'localhost.',
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '[::1]',
    '[::]',
    '[fc00::1]',
    '[fd12:3456::1]',
    '[fe80::1]',
    '[ff02::1]',
    '[::ffff:10.0.0.1]',
    '[::ffff:127.0.0.1]',
    '[64:ff9b::a00:1]',
  ])('refuses the host %s', (host) => {
    expect(isSafeUrl(`https://${host}/hook`), host).toBe(false);
  });

  it('refuses numeric IPv4 spellings the URL parser normalises to a private address', () => {
    for (const host of ['2130706433', '0x7f.0.0.1', '017700000001', '127.1', '0177.0.0.1']) {
      expect(isSafeUrl(`https://${host}/x`), host).toBe(false);
    }
  });

  it('keeps the neighbours of the private ranges', () => {
    for (const host of ['172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '169.253.0.1', '11.0.0.1', '[2606:4700::1111]', '[::ffff:8.8.8.8]']) {
      expect(isSafeUrl(`https://${host}/x`), host).toBe(true);
    }
  });

  it('says why in words fit for a form', () => {
    expect(checkSafeUrl('https://10.0.0.1/x')).toEqual({ ok: false, reason: 'The URL points at a private or local address' });
  });
});

describe('isBlockedHost', () => {
  it('treats an empty host as blocked', () => {
    expect(isBlockedHost('')).toBe(true);
  });
});
