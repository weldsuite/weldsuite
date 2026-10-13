import { describe, expect, it } from 'vitest';
import { compressUids, flagList, isPrintableAscii, Literal, mailboxPart, quote, stringPart } from './protocol';
import { ImapError } from './types';

describe('quote', () => {
  it('wraps in double quotes and escapes backslashes and quotes', () => {
    expect(quote('plain')).toBe('"plain"');
    expect(quote('pa"ss')).toBe('"pa\\"ss"');
    expect(quote('pa\\ss')).toBe('"pa\\\\ss"');
    expect(quote('\\"')).toBe('"\\\\\\""');
  });
});

describe('stringPart', () => {
  it('quotes printable ASCII', () => {
    expect(stringPart('user@acme.test')).toBe('"user@acme.test"');
    expect(stringPart('p@ss word')).toBe('"p@ss word"');
  });

  it.each([
    ['a line feed', 'a\nb'],
    ['a carriage return', 'a\rb'],
    ['a tab', 'a\tb'],
    ['a non-ASCII letter', 'pässword'],
    ['an emoji', 'x😀'],
    ['a DEL', 'a\x7fb'],
  ])('uses a literal for %s', (_label, value) => {
    const part = stringPart(value);
    expect(part).toBeInstanceOf(Literal);
    expect((part as Literal).value).toBe(value);
  });

  it('classifies printable ASCII', () => {
    expect(isPrintableAscii('')).toBe(true);
    expect(isPrintableAscii(' ~')).toBe(true);
    expect(isPrintableAscii('\x1f')).toBe(false);
    expect(isPrintableAscii('é')).toBe(false);
  });
});

describe('mailboxPart', () => {
  it('encodes to modified UTF-7 and quotes', () => {
    expect(mailboxPart('INBOX')).toBe('"INBOX"');
    expect(mailboxPart('Entwürfe')).toBe('"Entw&APw-rfe"');
    expect(mailboxPart('Say "hi"')).toBe('"Say \\"hi\\""');
  });
});

describe('compressUids', () => {
  it.each([
    [[1], '1'],
    [[1, 2, 3], '1:3'],
    [[1, 2, 3, 7], '1:3,7'],
    [[7, 3, 1, 2], '1:3,7'],
    [[4, 5], '4:5'],
    [[1, 3, 5], '1,3,5'],
    [[3, 3, 3], '3'],
    [[10, 11, 12, 20, 22, 23], '10:12,20,22:23'],
    [[4_294_967_295], '4294967295'],
  ])('%j -> %s', (uids, expected) => {
    expect(compressUids(uids)).toBe(expected);
  });

  it.each([[[0]], [[-1]], [[1.5]], [[Number.NaN]], [[4_294_967_296]], [[1, 2, 0]]])('rejects %j', (uids) => {
    expect(() => compressUids(uids)).toThrowError(ImapError);
  });

  it('does not modify its argument', () => {
    const uids = [3, 1, 2];
    compressUids(uids);
    expect(uids).toEqual([3, 1, 2]);
  });
});

describe('flagList', () => {
  it('builds a parenthesized list', () => {
    expect(flagList(['\\Seen', '\\Flagged'])).toBe('(\\Seen \\Flagged)');
    expect(flagList(['$Forwarded'])).toBe('($Forwarded)');
  });

  it.each([[''], ['\\'], ['Seen Flagged'], ['\\Seen)'], ['(\\Seen'], ['"x"'], ['x\r\ny'], ['\\\\Seen'], ['a*b'], ['a%b']])('rejects %j', (flag) => {
    expect(() => flagList([flag])).toThrowError(ImapError);
  });

  it('is fast on a long invalid flag', () => {
    const started = Date.now();
    expect(() => flagList([`${'a'.repeat(100_000)}!`])).toThrowError(ImapError);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
