import { describe, expect, it } from 'vitest';
import { bucketUrlFor, bucketUrls, isBucketLike, kvBucketUrl, type BucketLike } from './bucket-bridge';

/** The smallest stub a test brings: `get` answers only `{ body }`, no `head`. */
function stubBucket() {
  const objects = new Map<string, { bytes: Uint8Array; options?: unknown }>();
  const bucket: BucketLike = {
    async put(key, value, options) {
      objects.set(key, { bytes: new Uint8Array(value), options });
      return {};
    },
    async get(key) {
      const object = objects.get(key);
      return object ? { body: new Blob([object.bytes]).stream() } : null;
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  return { bucket, objects };
}

const KEY = 'workspaces/org_1/weldsign/sgn_1/documents/sgd_1.pdf';

describe('bucket bridge', () => {
  it('round-trips an object through HTTP', async () => {
    const { bucket, objects } = stubBucket();
    const base = await bucketUrlFor(bucket);
    const url = `${base}/object?key=${encodeURIComponent(KEY)}`;

    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf', 'x-meta-sha256': 'abc' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(put.status).toBe(204);
    expect(objects.get(KEY)?.options).toEqual({ httpMetadata: { contentType: 'application/pdf' }, customMetadata: { sha256: 'abc' } });

    const get = await fetch(url);
    expect(get.status).toBe(200);
    expect([...new Uint8Array(await get.arrayBuffer())]).toEqual([1, 2, 3]);

    // No `head` on the stub: the size comes from the bytes.
    const head = await fetch(url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('3');

    expect((await fetch(url, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(url)).status).toBe(404);
    expect((await fetch(url, { method: 'HEAD' })).status).toBe(404);
  });

  it('serves R2 metadata when the binding has it', async () => {
    const bucket: BucketLike = {
      async put() {
        return {};
      },
      async get() {
        return {
          size: 2,
          httpMetadata: { contentType: 'image/png' },
          customMetadata: { a: 'b' },
          arrayBuffer: async () => new Uint8Array([9, 8]).buffer,
        };
      },
      async head() {
        return { size: 2, httpMetadata: { contentType: 'image/png' }, customMetadata: { a: 'b' } };
      },
      async delete() {},
    };
    const base = await bucketUrlFor(bucket);
    const res = await fetch(`${base}/object?key=x`);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-meta-a')).toBe('b');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([9, 8]);
    const head = await fetch(`${base}/object?key=x`, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe('2');
  });

  it('serves a KV namespace one value per object', async () => {
    const store = new Map<string, string>();
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
    };
    const base = await kvBucketUrl(kv);
    expect(await kvBucketUrl(kv)).toBe(base);
    const url = `${base}/object?key=${encodeURIComponent('sign:code:abc')}`;
    expect((await fetch(url, { method: 'PUT', body: 'hash•1' })).status).toBe(204);
    expect(store.get('sign:code:abc')).toBe('hash•1');
    expect(await (await fetch(url)).text()).toBe('hash•1');
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(url)).status).toBe(404);
  });

  it('starts one server per bucket and names only bucket bindings', async () => {
    const { bucket } = stubBucket();
    expect(await bucketUrlFor(bucket)).toBe(await bucketUrlFor(bucket));
    expect(isBucketLike({ get() {}, put() {} })).toBe(false);
    const urls = await bucketUrls({ PRIVATE_STORAGE: bucket, STORAGE: 'nope', SIGN_SESSION_SECRET: 'x' });
    expect(Object.keys(urls ?? {})).toEqual(['PRIVATE_STORAGE']);
    expect(await bucketUrls({})).toBeUndefined();
  });
});
