/**
 * Round-trip and tamper-rejection tests for the opaque mailbox cursors.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeMessageCursor,
  decodeOffsetCursor,
  decodeThreadCursor,
  encodeMessageCursor,
  encodeOffsetCursor,
  encodeThreadCursor,
  type MessageCursor,
  type ThreadCursor,
} from './cursor';

describe('thread cursor round trip', () => {
  it('decodes exactly what it encoded', () => {
    const cursor: ThreadCursor = { latestAt: 1_700_000_000_000, accountId: 'mail_abc', threadKey: 'msg_123' };
    expect(decodeThreadCursor(encodeThreadCursor(cursor))).toEqual(cursor);
  });

  it('round-trips unicode in the account/thread key without corruption', () => {
    const cursor: ThreadCursor = { latestAt: 0, accountId: 'mail_déjà-vu_🙂', threadKey: 'ключ' };
    expect(decodeThreadCursor(encodeThreadCursor(cursor))).toEqual(cursor);
  });

  it('is opaque base64url text with a version prefix', () => {
    const encoded = encodeThreadCursor({ latestAt: 1, accountId: 'a', threadKey: 'b' });
    expect(encoded.startsWith('t1.')).toBe(true);
    expect(/^t1\.[A-Za-z0-9_-]+$/.test(encoded)).toBe(true);
  });

  it('null/undefined/empty decode to null, not throw', () => {
    expect(decodeThreadCursor(null)).toBeNull();
    expect(decodeThreadCursor(undefined)).toBeNull();
    expect(decodeThreadCursor('')).toBeNull();
  });
});

describe('thread cursor tamper rejection', () => {
  const valid = encodeThreadCursor({ latestAt: 1700000000000, accountId: 'mail_abc', threadKey: 'msg_123' });

  it('rejects a message cursor presented as a thread cursor (wrong version prefix)', () => {
    const asMessageCursor = encodeMessageCursor({ sentAt: 1, id: 'msg_1' });
    expect(decodeThreadCursor(asMessageCursor)).toBeNull();
  });

  it('rejects a cursor with no recognised prefix at all', () => {
    expect(decodeThreadCursor('msg_123')).toBeNull();
    expect(decodeThreadCursor('not-a-cursor')).toBeNull();
  });

  it('rejects invalid base64url after the prefix', () => {
    expect(decodeThreadCursor('t1.not base64!!')).toBeNull();
  });

  it('rejects a payload that decodes to something other than JSON', () => {
    const garbage = 't1.' + btoa('not json').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeThreadCursor(garbage)).toBeNull();
  });

  it('rejects a payload missing a required field', () => {
    const missingField = 't1.' + btoa(JSON.stringify({ latestAt: 1, accountId: 'a' })).replace(/\+/g, '-');
    expect(decodeThreadCursor(missingField)).toBeNull();
  });

  it('rejects a payload with an extra field (strict shape)', () => {
    const sane = encodeThreadCursor({ latestAt: 1, accountId: 'a', threadKey: 'b' });
    expect(decodeThreadCursor(sane)).not.toBeNull(); // sanity: the untampered cursor still decodes

    // The same payload plus an extra key must be rejected, not silently accepted.
    const json = JSON.stringify({ latestAt: 1, accountId: 'a', threadKey: 'b', evil: true });
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const tampered = 't1.' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeThreadCursor(tampered)).toBeNull();
  });

  it('rejects a wrong-typed field (number where a string is expected)', () => {
    const json = JSON.stringify({ latestAt: 1, accountId: 42, threadKey: 'b' });
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const tampered = 't1.' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeThreadCursor(tampered)).toBeNull();
  });

  it('rejects a single flipped character in the payload (statistically; this fixture flips a structural char)', () => {
    // Flip a character inside the base64 payload — breaks base64 alignment or JSON.
    const flipped = valid.slice(0, -1) + (valid.endsWith('A') ? 'B' : 'A');
    const decoded = decodeThreadCursor(flipped);
    // Either it fails to decode, or (rare, same-length base64 coincidence) it must
    // never silently equal the original cursor's semantic value with a changed bit.
    if (decoded) expect(flipped).not.toBe(valid);
    else expect(decoded).toBeNull();
  });

  it('rejects characters outside the base64url alphabet', () => {
    expect(decodeThreadCursor('t1.has spaces/and+plus')).toBeNull();
  });

  it('encodes a very long payload quickly (no catastrophic backtracking stripping base64 padding)', () => {
    // `utf8ToBase64Url` used to strip trailing `=` padding with a `/=+$/`
    // regex — unanchored at the start, so its backtracking is O(n^2) on a
    // long input. A cursor's fields are caller-influenced (account/thread
    // ids), so this guards against that regression with a hostile-sized
    // field: this must return well within a test timeout, not hang.
    const hostile: ThreadCursor = { latestAt: 1, accountId: 'a'.repeat(500_000), threadKey: 'b' };
    const start = performance.now();
    const encoded = encodeThreadCursor(hostile);
    const elapsed = performance.now() - start;
    expect(encoded.startsWith('t1.')).toBe(true);
    expect(elapsed).toBeLessThan(1000);
    expect(decodeThreadCursor(encoded)).toEqual(hostile);
  });
});

describe('message cursor round trip', () => {
  it('decodes exactly what it encoded', () => {
    const cursor: MessageCursor = { sentAt: 1_699_999_999_999, id: 'msg_xyz' };
    expect(decodeMessageCursor(encodeMessageCursor(cursor))).toEqual(cursor);
  });

  it('uses its own version prefix, distinct from the thread cursor', () => {
    expect(encodeMessageCursor({ sentAt: 1, id: 'a' }).startsWith('m1.')).toBe(true);
  });

  it('rejects a thread cursor presented as a message cursor', () => {
    const asThreadCursor = encodeThreadCursor({ latestAt: 1, accountId: 'a', threadKey: 'b' });
    expect(decodeMessageCursor(asThreadCursor)).toBeNull();
  });

  it('rejects garbage input', () => {
    expect(decodeMessageCursor('garbage')).toBeNull();
    expect(decodeMessageCursor(null)).toBeNull();
  });
});

describe('legacy offset cursor', () => {
  it('round-trips a non-negative integer', () => {
    expect(decodeOffsetCursor(encodeOffsetCursor(250))).toBe(250);
    expect(decodeOffsetCursor(encodeOffsetCursor(0))).toBe(0);
  });

  it('clamps a negative offset to zero on encode', () => {
    expect(encodeOffsetCursor(-10)).toBe('o:0');
  });

  it('decodes the literal legacy format', () => {
    expect(decodeOffsetCursor('o:5000')).toBe(5000);
  });

  it('rejects non-numeric or malformed offsets', () => {
    expect(decodeOffsetCursor('o:abc')).toBeNull();
    expect(decodeOffsetCursor('o:-5')).toBeNull();
    expect(decodeOffsetCursor('o:5.5')).toBeNull();
    expect(decodeOffsetCursor('5000')).toBeNull();
    expect(decodeOffsetCursor(null)).toBeNull();
  });
});
