import { describe, expect, it } from 'vitest';
import { MAX_LINE_BYTES, MAX_LITERAL_BYTES, ResponseBuffer, type RawResponse } from './reader';
import { ImapError } from './types';

const encoder = new TextEncoder();

function feed(buffer: ResponseBuffer, text: string): void {
  buffer.push(encoder.encode(text));
}

function drain(buffer: ResponseBuffer): RawResponse[] {
  const out: RawResponse[] = [];
  for (let next = buffer.take(); next !== null; next = buffer.take()) out.push(next);
  return out;
}

describe('ResponseBuffer', () => {
  it('returns nothing until a line is complete', () => {
    const buffer = new ResponseBuffer();
    feed(buffer, '* OK ready');
    expect(buffer.take()).toBeNull();
    feed(buffer, '\r');
    expect(buffer.take()).toBeNull();
    feed(buffer, '\n');
    expect(buffer.take()).toEqual({ lines: ['* OK ready'], literals: [] });
    expect(buffer.pendingLength).toBe(0);
  });

  it('splits several responses delivered in one chunk', () => {
    const buffer = new ResponseBuffer();
    feed(buffer, '* 3 EXISTS\r\n* 0 RECENT\r\nA001 OK done\r\n');
    expect(drain(buffer)).toEqual([
      { lines: ['* 3 EXISTS'], literals: [] },
      { lines: ['* 0 RECENT'], literals: [] },
      { lines: ['A001 OK done'], literals: [] },
    ]);
  });

  it('keeps a partial response after the complete ones', () => {
    const buffer = new ResponseBuffer();
    feed(buffer, '* 1 EXISTS\r\n* 2 EXI');
    expect(drain(buffer)).toEqual([{ lines: ['* 1 EXISTS'], literals: [] }]);
    feed(buffer, 'STS\r\n');
    expect(drain(buffer)).toEqual([{ lines: ['* 2 EXISTS'], literals: [] }]);
  });

  it('reads a literal and the text that follows it', () => {
    const buffer = new ResponseBuffer();
    feed(buffer, '* LIST (\\HasNoChildren) "/" {5}\r\nINBOX\r\n');
    expect(drain(buffer)).toEqual([{ lines: ['* LIST (\\HasNoChildren) "/" ', ''], literals: ['INBOX'] }]);
  });

  it('reads several literals in one response', () => {
    const buffer = new ResponseBuffer();
    feed(buffer, '* LIST () {1}\r\n/ {4}\r\nSent extra\r\n');
    expect(drain(buffer)).toEqual([{ lines: ['* LIST () ', ' ', ' extra'], literals: ['/', 'Sent'] }]);
  });

  it('counts literal bytes, not characters, and lets the literal contain CRLF', () => {
    const buffer = new ResponseBuffer();
    feed(buffer, '* 1 FETCH (BODY[TEXT] {5}\r\nä\r\nb)\r\n');
    const [response] = drain(buffer);
    expect(response?.literals).toEqual(['ä\r\nb']);
    expect(response?.lines).toEqual(['* 1 FETCH (BODY[TEXT] ', ')']);
  });

  it('waits for the rest of a literal that arrives in pieces', () => {
    const buffer = new ResponseBuffer();
    feed(buffer, '* LIST () "/" {10}\r\nIN');
    expect(buffer.take()).toBeNull();
    feed(buffer, 'BOX/Spam');
    expect(buffer.take()).toBeNull();
    feed(buffer, '\r\n* 5 EXISTS\r\n');
    expect(drain(buffer)).toEqual([
      { lines: ['* LIST () "/" ', ''], literals: ['INBOX/Spam'] },
      { lines: ['* 5 EXISTS'], literals: [] },
    ]);
  });

  it('survives a literal split in the middle of a multi-byte character', () => {
    const buffer = new ResponseBuffer();
    const bytes = encoder.encode('* LIST () "/" {3}\r\nä!\r\n');
    const cut = bytes.indexOf(0xc3) + 1;
    buffer.push(bytes.slice(0, cut));
    expect(buffer.take()).toBeNull();
    buffer.push(bytes.slice(cut));
    expect(drain(buffer)).toEqual([{ lines: ['* LIST () "/" ', ''], literals: ['ä!'] }]);
  });

  it('does not treat {n} at the end of a status line as a literal', () => {
    const buffer = new ResponseBuffer();
    feed(buffer, '* OK [ALERT] see {12}\r\nA001 NO nothing here {3}\r\n+ send it {4}\r\n* BYE bye {7}\r\n');
    expect(drain(buffer).map((response) => response.lines)).toEqual([
      ['* OK [ALERT] see {12}'],
      ['A001 NO nothing here {3}'],
      ['+ send it {4}'],
      ['* BYE bye {7}'],
    ]);
  });

  it.each([['* LIST () "/" {abc}'], ['* LIST () "/" {}'], ['* LIST () "/" {5'], ['* LIST () "/" 5}'], ['* LIST () "/" {-5}']])(
    'does not mistake %s for a literal',
    (line) => {
      const buffer = new ResponseBuffer();
      feed(buffer, `${line}\r\n`);
      expect(drain(buffer)).toEqual([{ lines: [line], literals: [] }]);
    },
  );

  it('accepts an empty literal', () => {
    const buffer = new ResponseBuffer();
    feed(buffer, '* LIST () "/" {0}\r\n\r\n');
    expect(drain(buffer)).toEqual([{ lines: ['* LIST () "/" ', ''], literals: [''] }]);
  });

  it('refuses a literal over the limit before buffering it', () => {
    const buffer = new ResponseBuffer();
    feed(buffer, `* LIST () "/" {${MAX_LITERAL_BYTES + 1}}\r\n`);
    expect(() => buffer.take()).toThrowError(ImapError);
  });

  it('refuses a line that never ends', () => {
    const buffer = new ResponseBuffer();
    buffer.push(new Uint8Array(MAX_LINE_BYTES + 1).fill(0x61));
    expect(() => buffer.take()).toThrowError(expect.objectContaining({ kind: 'protocol' }));
  });
});
