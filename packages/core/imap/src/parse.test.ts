import { describe, expect, it } from 'vitest';
import { classify, parseCapabilities, parseListEntry, parseSearchNumbers, parseStatusText, tokenize, type Response } from './parse';
import type { RawResponse } from './reader';
import { ImapError } from './types';

function response(line: string, literals: string[] = [], lines?: string[]): Response {
  const raw: RawResponse = { lines: lines ?? [line], literals };
  return classify(raw);
}

describe('classify', () => {
  it('reads an untagged data response', () => {
    expect(response('* LIST (\\HasNoChildren) "/" "INBOX"')).toMatchObject({
      kind: 'untagged',
      word: 'LIST',
      number: null,
      rest: '(\\HasNoChildren) "/" "INBOX"',
    });
  });

  it('reads the message number of `* n EXISTS`', () => {
    expect(response('* 172 EXISTS')).toMatchObject({ kind: 'untagged', word: 'EXISTS', number: 172, rest: '' });
    expect(response('* 3 fetch (FLAGS (\\Seen))')).toMatchObject({ word: 'FETCH', number: 3, rest: '(FLAGS (\\Seen))' });
  });

  it('upper-cases the word and keeps the status text', () => {
    expect(response('* ok [UIDVALIDITY 1] valid')).toMatchObject({ word: 'OK', rest: '[UIDVALIDITY 1] valid' });
  });

  it('reads a tagged completion', () => {
    expect(response('A001 OK [CAPABILITY IMAP4rev1] done')).toMatchObject({
      kind: 'tagged',
      tag: 'A001',
      word: 'OK',
      rest: '[CAPABILITY IMAP4rev1] done',
    });
    expect(response('A002 NO nope')).toMatchObject({ kind: 'tagged', tag: 'A002', word: 'NO', rest: 'nope' });
    expect(response('A003 bad syntax')).toMatchObject({ kind: 'tagged', word: 'BAD' });
  });

  it('reads a continuation request, with or without text', () => {
    expect(response('+ Ready for literal data')).toMatchObject({ kind: 'continuation', rest: 'Ready for literal data' });
    expect(response('+')).toMatchObject({ kind: 'continuation', rest: '' });
  });

  it.each([['garbage'], ['A001'], ['A001 MAYBE fine'], ['']])('rejects %j', (line) => {
    expect(() => response(line)).toThrowError(expect.objectContaining({ kind: 'protocol' }));
  });
});

describe('parseStatusText', () => {
  it('splits the response code from the text', () => {
    expect(parseStatusText('[CAPABILITY IMAP4rev1 MOVE] Logged in')).toEqual({
      code: 'CAPABILITY',
      codeData: 'IMAP4rev1 MOVE',
      text: 'Logged in',
    });
    expect(parseStatusText('[UIDVALIDITY 3857529045] UIDs valid')).toEqual({ code: 'UIDVALIDITY', codeData: '3857529045', text: 'UIDs valid' });
    expect(parseStatusText('[ALERT]')).toEqual({ code: 'ALERT', codeData: '', text: '' });
  });

  it('passes text without a code through', () => {
    expect(parseStatusText('Logged in')).toEqual({ code: null, codeData: '', text: 'Logged in' });
    expect(parseStatusText('')).toEqual({ code: null, codeData: '', text: '' });
    expect(parseStatusText('[unterminated')).toEqual({ code: null, codeData: '', text: '[unterminated' });
  });

  it('upper-cases the code', () => {
    expect(parseStatusText('[trycreate] no such mailbox').code).toBe('TRYCREATE');
  });
});

describe('parseCapabilities', () => {
  it('upper-cases and splits on any whitespace', () => {
    expect(parseCapabilities(' IMAP4rev1  move\tUIDPLUS AUTH=PLAIN ')).toEqual(['IMAP4REV1', 'MOVE', 'UIDPLUS', 'AUTH=PLAIN']);
    expect(parseCapabilities('')).toEqual([]);
  });
});

describe('tokenize', () => {
  const tokens = (line: string, literals: string[] = [], lines?: string[]) => tokenize(response(line, literals, lines));

  it('reads atoms, quoted strings and nested lists', () => {
    expect(tokens('* X a "b c" (d (e "f")) g')).toEqual([
      { kind: 'atom', value: 'a' },
      { kind: 'string', value: 'b c' },
      {
        kind: 'list',
        items: [
          { kind: 'atom', value: 'd' },
          {
            kind: 'list',
            items: [
              { kind: 'atom', value: 'e' },
              { kind: 'string', value: 'f' },
            ],
          },
        ],
      },
      { kind: 'atom', value: 'g' },
    ]);
  });

  it('resolves backslash escapes in quoted strings', () => {
    expect(tokens('* X "a\\"b\\\\c"')).toEqual([{ kind: 'string', value: 'a"b\\c' }]);
  });

  it('keeps brackets inside atoms', () => {
    expect(tokens('* X [Gmail]/Spam')).toEqual([{ kind: 'atom', value: '[Gmail]/Spam' }]);
  });

  it('places literals where their marker stood', () => {
    expect(tokens('* X (a) ', ['lit'], ['* X (a) ', ' b'])).toEqual([
      { kind: 'list', items: [{ kind: 'atom', value: 'a' }] },
      { kind: 'string', value: 'lit' },
      { kind: 'atom', value: 'b' },
    ]);
  });

  it('lets a list continue across a literal', () => {
    expect(tokens('* X (a ', ['lit'], ['* X (a ', ' b)'])).toEqual([
      {
        kind: 'list',
        items: [
          { kind: 'atom', value: 'a' },
          { kind: 'string', value: 'lit' },
          { kind: 'atom', value: 'b' },
        ],
      },
    ]);
  });

  it.each([['* X (a'], ['* X a)'], ['* X "abc']])('rejects %j', (line) => {
    expect(() => tokens(line)).toThrowError(ImapError);
  });
});

describe('parseListEntry', () => {
  it('reads attributes, delimiter and name', () => {
    expect(parseListEntry(response('* LIST (\\HasNoChildren \\Junk) "/" "[Gmail]/Spam"'))).toEqual({
      attributes: ['\\HasNoChildren', '\\Junk'],
      delimiter: '/',
      name: '[Gmail]/Spam',
    });
  });

  it('reads NIL and escaped delimiters and unquoted names', () => {
    expect(parseListEntry(response('* LIST (\\Noselect) NIL Shared'))).toEqual({ attributes: ['\\Noselect'], delimiter: null, name: 'Shared' });
    expect(parseListEntry(response('* LIST () "\\\\" "a\\\\b"'))).toEqual({ attributes: [], delimiter: '\\', name: 'a\\b' });
  });

  it('reads literal delimiters and names', () => {
    const entry = parseListEntry(response('* LIST () ', ['/', 'My "Mail"'], ['* LIST () ', ' ', '']));
    expect(entry).toEqual({ attributes: [], delimiter: '/', name: 'My "Mail"' });
  });

  it.each([['* LIST'], ['* LIST "/" "INBOX"'], ['* LIST () "/"'], ['* LIST () (a) "INBOX"'], ['* LIST () "/" (INBOX)']])('rejects %j', (line) => {
    expect(() => parseListEntry(response(line))).toThrowError(expect.objectContaining({ kind: 'protocol' }));
  });
});

describe('parseSearchNumbers', () => {
  it('reads the numbers', () => {
    expect(parseSearchNumbers(response('* SEARCH 4 8 15'))).toEqual([4, 8, 15]);
    expect(parseSearchNumbers(response('* SEARCH'))).toEqual([]);
    expect(parseSearchNumbers(response('* SEARCH  1   2 '))).toEqual([1, 2]);
  });

  it('rejects anything else', () => {
    expect(() => parseSearchNumbers(response('* SEARCH 1 x'))).toThrowError(expect.objectContaining({ kind: 'protocol' }));
    expect(() => parseSearchNumbers(response('* SEARCH 1 -2'))).toThrowError(ImapError);
  });
});
