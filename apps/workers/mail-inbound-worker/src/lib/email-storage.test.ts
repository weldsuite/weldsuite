/**
 * `storeRawMimeToR2`: the raw-MIME-to-R2 write `storeEmail` makes for every
 * stored workspace message (docs/plans/weldmail-mailbox-store-design.md
 * decision 4). Unit-tested in isolation from the rest of `storeEmail` (full
 * tenant-DB inserts, thread resolution, spam scoring, …), which this change
 * does not touch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `./email-storage` transitively imports `@weldsuite/notifications`, which
// imports the Workers-only `cloudflare:email` module (send bindings) — stub
// it so the module graph resolves under vitest's node environment, the same
// way packages/domains/mail/src/forward.test.ts does for `@weldsuite/mail-domain/send`.
vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public readonly from: string, public readonly to: string, public readonly raw: string) {}
  },
}));

import { storeRawMimeToR2 } from './email-storage';
import { getRawMime } from '@weldsuite/mail-domain/store/bodies';
import { MemoryR2Bucket } from '@weldsuite/mail-domain/store/testing/memory-r2';

const REF = { workspaceId: 'ws_1', accountId: 'mail_1', messageId: 'msg_1' };
const BYTES = new TextEncoder().encode('From: a@b.com\r\nSubject: hi\r\n\r\nbody').buffer as ArrayBuffer;

describe('storeRawMimeToR2', () => {
  let bucket: MemoryR2Bucket;

  beforeEach(() => {
    bucket = new MemoryR2Bucket();
  });

  it('writes the raw bytes to R2 at the message key', async () => {
    await storeRawMimeToR2({ MAIL_STORAGE: bucket.asBucket() }, REF, BYTES);

    const stored = await getRawMime(bucket.asBucket(), REF);
    expect(stored && new Uint8Array(stored)).toEqual(new Uint8Array(BYTES));
  });

  it('is a no-op when there are no raw bytes (e.g. a transport that never set rawMessageBytes)', async () => {
    await storeRawMimeToR2({ MAIL_STORAGE: bucket.asBucket() }, REF, undefined);

    expect(await getRawMime(bucket.asBucket(), REF)).toBeNull();
  });

  it('is a no-op when the worker has no MAIL_STORAGE binding', async () => {
    await expect(storeRawMimeToR2({ MAIL_STORAGE: undefined }, REF, BYTES)).resolves.toBeUndefined();
  });

  it('survives an R2 failure: warns, does not throw, delivery is unaffected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failingBucket = {
      put: vi.fn().mockRejectedValue(new Error('R2 unavailable')),
    } as unknown as R2Bucket;

    await expect(storeRawMimeToR2({ MAIL_STORAGE: failingBucket }, REF, BYTES)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write raw MIME to R2 for msg_1'),
      'R2 unavailable',
    );

    warn.mockRestore();
  });
});
