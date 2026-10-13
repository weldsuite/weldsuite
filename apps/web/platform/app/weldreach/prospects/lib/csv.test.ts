import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseCsv } from './csv';

describe('parseCsv', () => {
  it('reads headers and rows', () => {
    expect(parseCsv('email,first name\nana@acme.com,Ana\nbo@acme.com,Bo\n')).toEqual({
      headers: ['email', 'first name'],
      rows: [
        ['ana@acme.com', 'Ana'],
        ['bo@acme.com', 'Bo'],
      ],
    });
  });

  it('handles quotes, doubled quotes and commas and line breaks inside fields', () => {
    const parsed = parseCsv('email,company\r\nana@acme.com,"Acme, Inc. ""Best"""\r\nbo@acme.com,"Line one\nline two"\r\n');
    expect(parsed.rows).toEqual([
      ['ana@acme.com', 'Acme, Inc. "Best"'],
      ['bo@acme.com', 'Line one\nline two'],
    ]);
  });

  it('strips a byte-order mark', () => {
    expect(parseCsv('﻿email\nana@acme.com').headers).toEqual(['email']);
  });

  it('detects a semicolon separator', () => {
    const parsed = parseCsv('email;voornaam\nana@acme.com;Ana');
    expect(parsed.headers).toEqual(['email', 'voornaam']);
    expect(parsed.rows).toEqual([['ana@acme.com', 'Ana']]);
  });

  it('detects a tab separator', () => {
    expect(detectDelimiter('email\tname\tcompany')).toBe('\t');
  });

  it('does not count separators inside quotes when detecting', () => {
    expect(detectDelimiter('"a;b;c",d,e')).toBe(',');
  });

  it('skips blank lines and keeps a last row without a trailing newline', () => {
    const parsed = parseCsv('email\n\nana@acme.com\n\n   \nbo@acme.com');
    expect(parsed.rows).toEqual([['ana@acme.com'], ['bo@acme.com']]);
  });

  it('keeps empty cells so columns stay aligned', () => {
    expect(parseCsv('a,b,c\n1,,3').rows).toEqual([['1', '', '3']]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });
});
