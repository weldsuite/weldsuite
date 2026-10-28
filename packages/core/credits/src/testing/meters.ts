/**
 * Test helpers for the usage meters: a `USAGE_METER` namespace backed by real
 * `UsageMeter` objects over in-memory storage. The objects read plans and
 * charge the wallet through `getMasterDb` from `@weldsuite/worker-kit/db`, so
 * a test mocks that to return its (pglite) master DB.
 *
 * Every `get` builds a fresh object over the workspace's storage, the way a
 * Durable Object is evicted and rebuilt, so a plan change in a test is read
 * on the next call instead of after the minute-long limits cache.
 */

import { UsageMeter, type UsageMeterHostEnv } from '../meter-object';
import type { UsageMeterEnv } from '../meters';

/** Durable Object storage, the parts UsageMeter uses, in memory. */
export function memoryStorage() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(key: string | string[]) {
      if (Array.isArray(key)) return new Map(key.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
      return structuredClone(data.get(key));
    },
    async put(keyOrEntries: string | Record<string, unknown>, value?: unknown) {
      const entries = typeof keyOrEntries === 'string' ? { [keyOrEntries]: value } : keyOrEntries;
      for (const [k, v] of Object.entries(entries)) data.set(k, structuredClone(v));
    },
    async delete(keys: string | string[]) {
      return (Array.isArray(keys) ? keys : [keys]).filter((k) => data.delete(k)).length;
    },
    async list({ prefix, end, limit }: { prefix: string; end?: string; limit?: number }) {
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix) && (end === undefined || k < end)).sort();
      return new Map(keys.slice(0, limit).map((k) => [k, data.get(k)]));
    },
  };
}

export type MemoryStorage = ReturnType<typeof memoryStorage>;

/** A UsageMeter over `storage`, as its host would build it. */
export function memoryUsageMeter(storage: MemoryStorage = memoryStorage()): UsageMeter {
  return new UsageMeter({ storage } as unknown as DurableObjectState, { DATABASE_URL_MASTER: 'memory' } as UsageMeterHostEnv);
}

/** A `USAGE_METER` binding over in-memory meters, one storage per workspace. */
export function memoryUsageMeterNamespace(): { USAGE_METER: NonNullable<UsageMeterEnv['USAGE_METER']>; storages: Map<string, MemoryStorage> } {
  const storages = new Map<string, MemoryStorage>();
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      if (!storages.has(id)) storages.set(id, memoryStorage());
      return memoryUsageMeter(storages.get(id));
    },
  };
  return { USAGE_METER: namespace as unknown as NonNullable<UsageMeterEnv['USAGE_METER']>, storages };
}
