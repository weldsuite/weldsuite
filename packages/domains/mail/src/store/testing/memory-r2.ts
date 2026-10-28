/**
 * Minimal in-memory `R2Bucket` fake for store/bodies.ts and its callers'
 * tests: `get` (with a byte range), `put`, `delete` (single key or array) and
 * `list` (prefix + cursor paging). Not a full R2 emulation — just enough
 * surface for the mail body/raw-MIME read and delete paths.
 */

interface StoredObject {
  body: Uint8Array;
  httpMetadata?: { contentType?: string };
}

function toBytes(value: ArrayBuffer | ArrayBufferView | string): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value as ArrayBuffer);
}

function sliceForRange(bytes: Uint8Array, range?: { offset?: number; length?: number }): Uint8Array {
  if (!range) return bytes;
  const offset = range.offset ?? 0;
  const end = range.length !== undefined ? offset + range.length : bytes.byteLength;
  return bytes.slice(offset, Math.min(end, bytes.byteLength));
}

export class MemoryR2Bucket {
  readonly objects = new Map<string, StoredObject>();

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<{ key: string }> {
    this.objects.set(key, { body: toBytes(value), httpMetadata: options?.httpMetadata });
    return { key };
  }

  async get(
    key: string,
    options?: { range?: { offset?: number; length?: number } },
  ): Promise<
    | {
        httpMetadata?: { contentType?: string };
        arrayBuffer: () => Promise<ArrayBuffer>;
        text: () => Promise<string>;
      }
    | null
  > {
    const object = this.objects.get(key);
    if (!object) return null;
    const bytes = sliceForRange(object.body, options?.range);
    return {
      httpMetadata: object.httpMetadata,
      arrayBuffer: async () => bytes.slice().buffer,
      text: async () => new TextDecoder().decode(bytes),
    };
  }

  async head(key: string): Promise<{ key: string; size: number } | null> {
    const object = this.objects.get(key);
    return object ? { key, size: object.body.byteLength } : null;
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }> {
    const prefix = options?.prefix ?? '';
    const limit = options?.limit ?? 1000;
    // Sorted key order, resumed from the last key of the previous page (not a
    // positional offset), so deleting earlier pages between calls — the
    // mailbox-teardown pager's whole point — can never skip or repeat a key.
    const matching = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const from = options?.cursor ? matching.findIndex((k) => k > options.cursor!) : 0;
    const start = from === -1 ? matching.length : from;
    const page = matching.slice(start, start + limit);
    const truncated = start + limit < matching.length;
    return {
      objects: page.map((key) => ({ key })),
      truncated,
      cursor: truncated ? page[page.length - 1] : undefined,
    };
  }

  /** The bucket as the worker's `R2Bucket` binding. */
  asBucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

export function createMemoryR2Bucket(): R2Bucket {
  return new MemoryR2Bucket().asBucket();
}
