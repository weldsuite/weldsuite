import { describe, expect, it } from 'vitest';
import { decodeMailboxName, encodeMailboxName } from './utf7';

describe('modified UTF-7', () => {
  it.each([
    ['INBOX', 'INBOX'],
    ['[Gmail]/Spam', '[Gmail]/Spam'],
    ['Entwürfe', 'Entw&APw-rfe'],
    ['日本語', '&ZeVnLIqe-'],
    ['~peter/mail/台北/日本語', '~peter/mail/&U,BTFw-/&ZeVnLIqe-'],
    ['R&D', 'R&-D'],
    ['&', '&-'],
    ['Sent & Spam', 'Sent &- Spam'],
    ['Envoyés', 'Envoy&AOk-s'],
    ['😀', '&2D3eAA-'],
    ['é&é', '&AOk-&-&AOk-'],
  ])('%s <-> %s', (decoded, encoded) => {
    expect(encodeMailboxName(decoded)).toBe(encoded);
    expect(decodeMailboxName(encoded)).toBe(decoded);
  });

  it('encodes control characters and line breaks instead of letting them reach the wire', () => {
    const encoded = encodeMailboxName('a\r\nb"c');
    expect(encoded).not.toMatch(/[\r\n]/);
    expect(encoded.startsWith('a&')).toBe(true);
    expect(decodeMailboxName(encoded)).toBe('a\r\nb"c');
  });

  it('always produces printable ASCII', () => {
    const encoded = encodeMailboxName('Zażółć gęślą jaźń 日本語 😀 \u0000');
    for (const char of encoded) {
      const code = char.charCodeAt(0);
      expect(code >= 0x20 && code <= 0x7e).toBe(true);
    }
  });

  it('keeps sequences it cannot decode as received', () => {
    expect(decodeMailboxName('a&AAA')).toBe('a&AAA');
    expect(decodeMailboxName('a&!!-b')).toBe('a&!!-b');
    expect(decodeMailboxName('a&A-b')).toBe('a&A-b');
    expect(decodeMailboxName('&AOk')).toBe('&AOk');
  });

  it('decodes names with several sequences and plain text around them', () => {
    expect(decodeMailboxName('A&AOk-B&AOk-C')).toBe('AéBéC');
  });

  it('handles an empty name', () => {
    expect(encodeMailboxName('')).toBe('');
    expect(decodeMailboxName('')).toBe('');
  });

  it('decodes a long run of ampersands without blowing up', () => {
    const hostile = '&'.repeat(50_000);
    const started = Date.now();
    expect(decodeMailboxName(hostile)).toBe(hostile);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
