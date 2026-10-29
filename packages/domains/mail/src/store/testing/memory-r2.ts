/**
 * Minimal in-memory `R2Bucket` fake for store/bodies.ts and its callers'
 * tests: `get` (with a byte range), `put`, `delete` (single key or array) and
 * `list` (prefix + cursor paging). Not a full R2 emulation — just enough
 * surface for the mail body/raw-MIME read and delete paths.
 *
 * A thin adapter over `@weldsuite/worker-kit/testing/r2`'s `createMemoryR2()`
 * — the actual byte/range/blob handling (`toBytes`, range math, `Blob`
 * construction) lives there exactly once now, instead of being duplicated
 * here. This class only exists to keep its callers' existing shape: a
 * constructor (`new MemoryR2Bucket()`), `.asBucket()`, and a synchronous
 * `.objects` key view for the one caller that inspects stored keys directly
 * without an `await` (`email-storage.store.test.ts`'s
 * `[...bucket.objects.keys()]`) — `R2Bucket.list()` is async, so that one
 * piece of bookkeeping stays local rather than delegated. `asBucket()` still
 * returns `this` (not the delegate): every write must go through this
 * class's own `put`/`delete` so `.objects` stays in sync even when a caller
 * writes through the bucket binding directly (e.g. `ObjectMailboxStore`'s own
 * R2 puts), not just through this class's methods.
 */

import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';

/** `{offset?, length?}` (both optional — this file's own, looser shape) → the ambient `R2Range` union, which requires at least one of them. `undefined` when neither is set (matches a full read, same as passing no range at all). */
function toR2Range(range?: { offset?: number; length?: number }): R2Range | undefined {
  if (!range) return undefined;
  const { offset, length } = range;
  if (offset !== undefined) return { offset, length };
  if (length !== undefined) return { length };
  return undefined;
}

export class MemoryR2Bucket {
  private readonly delegate: R2Bucket = createMemoryR2();
  /** Keys currently stored — mirrors `put`/`delete` for synchronous introspection only (the bytes themselves live in the delegate above, not duplicated here). */
  readonly objects = new Map<string, true>();

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<{ key: string }> {
    const result = await this.delegate.put(key, value, options);
    this.objects.set(key, true);
    return { key: result.key };
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
    return this.delegate.get(key, { range: toR2Range(options?.range) });
  }

  async head(key: string): Promise<{ key: string; size: number } | null> {
    const result = await this.delegate.head(key);
    return result ? { key: result.key, size: result.size } : null;
  }

  async delete(keys: string | string[]): Promise<void> {
    await this.delegate.delete(keys);
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }> {
    const result = await this.delegate.list(options);
    return {
      objects: result.objects.map((o) => ({ key: o.key })),
      truncated: result.truncated,
      cursor: result.truncated ? result.cursor : undefined,
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
