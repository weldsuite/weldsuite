/**
 * `createMemoryR2()`: the `R2Bucket` subset mail code needs — put (string /
 * ArrayBuffer / Uint8Array / stream), get (with ranges), head, delete (single
 * key and array), and list (prefix / cursor / limit / truncated paging).
 */

import { describe, expect, it } from 'vitest';
import { createMemoryR2 } from './r2';

describe('put()/get()/head()', () => {
  it('round-trips a string value and reports httpMetadata/customMetadata', async () => {
    const bucket = createMemoryR2();
    const put = await bucket.put('mail/ws_1/acc_1/msg_1/body.txt', 'hello world', {
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { messageId: 'msg_1' },
    });
    expect(put.key).toBe('mail/ws_1/acc_1/msg_1/body.txt');
    expect(put.size).toBe(11);
    expect(put.httpMetadata).toEqual({ contentType: 'text/plain' });
    expect(put.customMetadata).toEqual({ messageId: 'msg_1' });

    const got = await bucket.get('mail/ws_1/acc_1/msg_1/body.txt');
    expect(got).not.toBeNull();
    expect(await got?.text()).toBe('hello world');
    expect(got?.httpMetadata).toEqual({ contentType: 'text/plain' });

    const headed = await bucket.head('mail/ws_1/acc_1/msg_1/body.txt');
    expect(headed?.size).toBe(11);
    expect((headed as unknown as { body?: unknown }).body).toBeUndefined();
  });

  it('accepts ArrayBuffer and Uint8Array values', async () => {
    const bucket = createMemoryR2();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    await bucket.put('a', bytes.buffer);
    expect(new Uint8Array(await (await bucket.get('a'))!.arrayBuffer())).toEqual(bytes);

    await bucket.put('b', bytes);
    expect(await (await bucket.get('b'))!.bytes()).toEqual(bytes);
  });

  it('accepts a ReadableStream value', async () => {
    const bucket = createMemoryR2();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([104, 105])); // "hi"
        controller.close();
      },
    });
    await bucket.put('stream-key', stream);
    expect(await (await bucket.get('stream-key'))!.text()).toBe('hi');
  });

  it('returns null from get()/head() for a missing key', async () => {
    const bucket = createMemoryR2();
    expect(await bucket.get('missing')).toBeNull();
    expect(await bucket.head('missing')).toBeNull();
  });

  it('json() parses the stored bytes', async () => {
    const bucket = createMemoryR2();
    await bucket.put('k', JSON.stringify({ a: 1 }));
    expect(await (await bucket.get('k'))!.json()).toEqual({ a: 1 });
  });
});

describe('get(): ranges', () => {
  const content = 'abcdefghijklmnopqrstuvwxyz'; // 26 bytes, ascii

  it('offset + length', async () => {
    const bucket = createMemoryR2();
    await bucket.put('k', content);
    const body = await bucket.get('k', { range: { offset: 3, length: 5 } });
    expect(await body?.text()).toBe('defgh');
    expect(body?.range).toEqual({ offset: 3, length: 5 });
  });

  it('suffix', async () => {
    const bucket = createMemoryR2();
    await bucket.put('k', content);
    const body = await bucket.get('k', { range: { suffix: 4 } });
    expect(await body?.text()).toBe('wxyz');
  });

  it('a Headers Range header', async () => {
    const bucket = createMemoryR2();
    await bucket.put('k', content);
    const headers = new Headers({ range: 'bytes=0-2' });
    const body = await bucket.get('k', { range: headers });
    expect(await body?.text()).toBe('abc');
  });
});

describe('delete()', () => {
  it('deletes a single key and an array of keys', async () => {
    const bucket = createMemoryR2();
    await bucket.put('a', '1');
    await bucket.put('b', '2');
    await bucket.put('c', '3');

    await bucket.delete('a');
    expect(await bucket.get('a')).toBeNull();

    await bucket.delete(['b', 'c']);
    expect(await bucket.get('b')).toBeNull();
    expect(await bucket.get('c')).toBeNull();
  });
});

describe('list()', () => {
  it('filters by prefix and pages with cursor/limit/truncated', async () => {
    const bucket = createMemoryR2();
    for (let i = 0; i < 5; i++) await bucket.put(`mail/ws_1/acc_1/msg_${i}/body.txt`, `body ${i}`);
    await bucket.put('other/key', 'nope');

    const page1 = await bucket.list({ prefix: 'mail/ws_1/acc_1/', limit: 2 });
    expect(page1.objects.map((o) => o.key)).toEqual(['mail/ws_1/acc_1/msg_0/body.txt', 'mail/ws_1/acc_1/msg_1/body.txt']);
    expect(page1.truncated).toBe(true);
    expect(page1.truncated ? page1.cursor : undefined).toBeTruthy();

    const page2 = await bucket.list({ prefix: 'mail/ws_1/acc_1/', limit: 2, cursor: page1.truncated ? page1.cursor : undefined });
    expect(page2.objects.map((o) => o.key)).toEqual(['mail/ws_1/acc_1/msg_2/body.txt', 'mail/ws_1/acc_1/msg_3/body.txt']);
    expect(page2.truncated).toBe(true);

    const page3 = await bucket.list({ prefix: 'mail/ws_1/acc_1/', limit: 2, cursor: page2.truncated ? page2.cursor : undefined });
    expect(page3.objects.map((o) => o.key)).toEqual(['mail/ws_1/acc_1/msg_4/body.txt']);
    expect(page3.truncated).toBe(false);
  });

  it('returns an empty, non-truncated page for a prefix with no matches', async () => {
    const bucket = createMemoryR2();
    await bucket.put('a', '1');
    const result = await bucket.list({ prefix: 'nope/' });
    expect(result.objects).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
