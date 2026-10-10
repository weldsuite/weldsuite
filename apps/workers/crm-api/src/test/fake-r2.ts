/**
 * Minimal in-memory R2 bucket for tests: only `head` and `put`, which is all
 * the logo cache uses. Keeps the stored bytes and metadata for assertions.
 */

interface StoredObject {
  body: Uint8Array;
  httpMetadata?: { contentType?: string; cacheControl?: string };
  customMetadata?: Record<string, string>;
}

export class FakeR2 {
  readonly objects = new Map<string, StoredObject>();
  headCalls = 0;
  putCalls = 0;

  async head(key: string) {
    this.headCalls++;
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      size: object.body.byteLength,
      customMetadata: object.customMetadata,
      httpMetadata: object.httpMetadata,
    };
  }

  async put(
    key: string,
    value: Uint8Array | string,
    options?: { httpMetadata?: StoredObject['httpMetadata']; customMetadata?: Record<string, string> },
  ) {
    this.putCalls++;
    const body = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    this.objects.set(key, {
      body,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
    });
    return { key };
  }

  /** The bucket as the worker's `R2Bucket` binding. */
  asBucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}
