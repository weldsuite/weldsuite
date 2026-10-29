/**
 * Shared doubles for the WeldApps route tests: a KV namespace and R2 buckets
 * small enough to read, and shareable with the Rust backend in conformance
 * mode (the KV and bucket bridges share any such binding).
 */

/** A KV namespace over a map (TTLs are not modelled). */
export class FakeKv {
  readonly store = new Map<string, string>();

  async get(key: string, type?: string): Promise<unknown> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    return type === 'json' ? (JSON.parse(raw) as unknown) : raw;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** A fresh KV namespace (conformance mode shares it with the Rust server). */
export function sharedKv(): FakeKv {
  return new FakeKv();
}

interface StoredFile {
  body: Uint8Array;
  contentType: string | undefined;
}

/** An R2 bucket over a map: `get`, `put`, `delete`, and its keys for assertions. */
export class FakeBucket {
  readonly objects = new Map<string, StoredFile>();

  constructor(seed: Record<string, string> = {}) {
    for (const [key, text] of Object.entries(seed)) {
      this.objects.set(key, { body: new TextEncoder().encode(text), contentType: undefined });
    }
  }

  async get(key: string): Promise<unknown> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      body: object.body,
      httpEtag: '"etag"',
      httpMetadata: object.contentType ? { contentType: object.contentType } : undefined,
      size: object.body.byteLength,
      arrayBuffer: async () => object.body.slice().buffer,
    };
  }

  async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }): Promise<void> {
    const body =
      value instanceof Uint8Array
        ? value
        : typeof value === 'string'
          ? new TextEncoder().encode(value)
          : new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
    this.objects.set(key, { body, contentType: options?.httpMetadata?.contentType });
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  /** The text of an object, for assertions. */
  text(key: string): string | undefined {
    const object = this.objects.get(key);
    return object ? new TextDecoder().decode(object.body) : undefined;
  }
}

export const JSON_HEADERS = { 'content-type': 'application/json' };
