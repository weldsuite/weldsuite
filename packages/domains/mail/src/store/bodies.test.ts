/**
 * `store/bodies.ts` key layout and R2 read/write/delete behaviour
 * (docs/plans/weldmail-mailbox-store-design.md decision 4).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  bodyHtmlKey,
  bodyTextKey,
  rawMimeKey,
  mailboxObjectPrefix,
  messageObjectPrefix,
  putMessageBodies,
  getMessageBodies,
  putRawMime,
  getRawMime,
  getRawMimeHeader,
  deleteMessageObjects,
  deleteMailboxObjects,
} from './bodies';
import { MemoryR2Bucket } from './testing/memory-r2';

const REF = { workspaceId: 'ws_123', accountId: 'mail_456', messageId: 'msg_789' };

describe('key builders', () => {
  it('builds the deterministic mail/<ws>/<account>/<message>/ layout', () => {
    expect(mailboxObjectPrefix(REF)).toBe('mail/ws_123/mail_456/');
    expect(messageObjectPrefix(REF)).toBe('mail/ws_123/mail_456/msg_789/');
    expect(bodyHtmlKey(REF)).toBe('mail/ws_123/mail_456/msg_789/body.html');
    expect(bodyTextKey(REF)).toBe('mail/ws_123/mail_456/msg_789/body.txt');
    expect(rawMimeKey(REF)).toBe('mail/ws_123/mail_456/msg_789/raw.eml');
  });

  it('rejects a ref segment that could escape its folder', () => {
    expect(() => bodyHtmlKey({ ...REF, messageId: '../other' })).toThrow();
    expect(() => bodyHtmlKey({ ...REF, accountId: 'a/b' })).toThrow();
    expect(() => bodyHtmlKey({ ...REF, workspaceId: '' })).toThrow();
  });
});

describe('message bodies', () => {
  let bucket: MemoryR2Bucket;

  beforeEach(() => {
    bucket = new MemoryR2Bucket();
  });

  it('round-trips html and text bodies with the right content types', async () => {
    await putMessageBodies(bucket.asBucket(), REF, { html: '<p>hi</p>', text: 'hi' });

    expect((await bucket.get(bodyHtmlKey(REF)))?.httpMetadata?.contentType).toBe('text/html; charset=utf-8');
    expect((await bucket.get(bodyTextKey(REF)))?.httpMetadata?.contentType).toBe('text/plain; charset=utf-8');

    const bodies = await getMessageBodies(bucket.asBucket(), REF);
    expect(bodies).toEqual({ html: '<p>hi</p>', text: 'hi' });
  });

  it('writes only the parts given, leaving the other untouched', async () => {
    await putMessageBodies(bucket.asBucket(), REF, { html: '<p>v1</p>', text: 'v1' });
    await putMessageBodies(bucket.asBucket(), REF, { html: '<p>v2</p>' });

    expect(await getMessageBodies(bucket.asBucket(), REF)).toEqual({ html: '<p>v2</p>', text: 'v1' });
  });

  it('never throws on a missing body — both come back null', async () => {
    await expect(getMessageBodies(bucket.asBucket(), REF)).resolves.toEqual({ html: null, text: null });
  });
});

describe('raw MIME', () => {
  let bucket: MemoryR2Bucket;

  beforeEach(() => {
    bucket = new MemoryR2Bucket();
  });

  it('round-trips the raw bytes with message/rfc822', async () => {
    const raw = new TextEncoder().encode('From: a@b.com\r\nSubject: hi\r\n\r\nbody');
    await putRawMime(bucket.asBucket(), REF, raw);

    expect((await bucket.get(rawMimeKey(REF)))?.httpMetadata?.contentType).toBe('message/rfc822');
    const fetched = await getRawMime(bucket.asBucket(), REF);
    expect(fetched && new Uint8Array(fetched)).toEqual(raw);
  });

  it('returns null, not a throw, when no raw object was ever stored', async () => {
    await expect(getRawMime(bucket.asBucket(), REF)).resolves.toBeNull();
  });

  it('reads only the first N bytes for the subscriptions header scan', async () => {
    const raw = `From: a@b.com\r\nList-Unsubscribe: <https://a.com/u>\r\n\r\n${'x'.repeat(5000)}`;
    await putRawMime(bucket.asBucket(), REF, new TextEncoder().encode(raw));

    const header = await getRawMimeHeader(bucket.asBucket(), REF, 40);
    expect(header).toHaveLength(40);
    expect(header).toBe(raw.slice(0, 40));
  });

  it('clamps a header read past the object size to what exists', async () => {
    const raw = 'From: a@b.com\r\nSubject: short';
    await putRawMime(bucket.asBucket(), REF, new TextEncoder().encode(raw));

    expect(await getRawMimeHeader(bucket.asBucket(), REF, 32_000)).toBe(raw);
  });

  it('returns null for a header read of a message with no raw object', async () => {
    await expect(getRawMimeHeader(bucket.asBucket(), REF, 100)).resolves.toBeNull();
  });
});

describe('delete', () => {
  let bucket: MemoryR2Bucket;

  beforeEach(() => {
    bucket = new MemoryR2Bucket();
  });

  it('deletes every object of one message, leaving a sibling message alone', async () => {
    const other = { ...REF, messageId: 'msg_other' };
    await putMessageBodies(bucket.asBucket(), REF, { html: '<p>v1</p>', text: 'v1' });
    await putRawMime(bucket.asBucket(), REF, new TextEncoder().encode('raw'));
    await putMessageBodies(bucket.asBucket(), other, { text: 'keep me' });

    await deleteMessageObjects(bucket.asBucket(), REF);

    expect(await getMessageBodies(bucket.asBucket(), REF)).toEqual({ html: null, text: null });
    expect(await getRawMime(bucket.asBucket(), REF)).toBeNull();
    expect(await getMessageBodies(bucket.asBucket(), other)).toEqual({ html: null, text: 'keep me' });
  });

  it('is idempotent against a message that was never stored', async () => {
    await expect(deleteMessageObjects(bucket.asBucket(), REF)).resolves.toBeUndefined();
  });

  it('deletes a whole mailbox by paging through list(), leaving other mailboxes alone', async () => {
    // 12 messages at a page size of 5 forces the pager to loop three times.
    for (let i = 0; i < 12; i++) {
      await putMessageBodies(bucket.asBucket(), { ...REF, messageId: `msg_${i}` }, { text: `body ${i}` });
    }
    const otherAccount = { workspaceId: REF.workspaceId, accountId: 'mail_other' };
    await putMessageBodies(bucket.asBucket(), { ...otherAccount, messageId: 'msg_kept' }, { text: 'kept' });

    const result = await deleteMailboxObjects(bucket.asBucket(), REF, 5);

    expect(result).toEqual({ deleted: 12 });
    for (let i = 0; i < 12; i++) {
      expect(await getMessageBodies(bucket.asBucket(), { ...REF, messageId: `msg_${i}` })).toEqual({
        html: null,
        text: null,
      });
    }
    expect(await getMessageBodies(bucket.asBucket(), { ...otherAccount, messageId: 'msg_kept' })).toEqual({
      html: null,
      text: 'kept',
    });
  });
});
