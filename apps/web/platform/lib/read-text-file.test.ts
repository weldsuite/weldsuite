import { describe, it, expect } from 'vitest';
import { decodeText } from './read-text-file';

const utf16 = (text: string, littleEndian: boolean) => {
  const bytes = [littleEndian ? 0xff : 0xfe, littleEndian ? 0xfe : 0xff];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    bytes.push(...(littleEndian ? [code & 0xff, code >> 8] : [code >> 8, code & 0xff]));
  }
  return new Uint8Array(bytes);
};

describe('decodeText', () => {
  it('decodes UTF-8 and drops its byte-order mark', () => {
    const body = new TextEncoder().encode('naam,datum\nJosé,2025-01-06');
    expect(decodeText(body)).toBe('naam,datum\nJosé,2025-01-06');
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...body]))).toBe('naam,datum\nJosé,2025-01-06');
  });

  it.each([
    ['little-endian', true],
    ['big-endian', false],
  ])('decodes UTF-16 %s by its byte-order mark', (_label, littleEndian) => {
    expect(decodeText(utf16('employee,date\nJosé', littleEndian))).toBe('employee,date\nJosé');
  });
});
