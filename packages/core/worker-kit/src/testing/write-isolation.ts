/**
 * Conformance mode runs every write twice, on Rust and on the Hono app, from
 * the same starting state. The database is cloned for that; the shared
 * buckets and KV (./bucket-bridge.ts, ./kv-bridge.ts) are not, so the
 * TypeScript run of a write gets these copy-on-write views instead: it reads
 * the test's binding as it is, its own writes go to a scratch layer that is
 * dropped afterwards. It runs before Rust, so it sees the state Rust starts
 * from, and only Rust's writes reach the test's stubs (which the test's own
 * assertions then check), as with the database.
 *
 * Without this, a single-use upload token or a create-only object put would
 * be spent by whichever backend ran first, and the second would answer 409.
 */

import { BUCKET_BINDINGS, isBucketLike, type BucketLike } from './bucket-bridge';
import { KV_BINDINGS, isKvLike, kvText, type KvLike } from './kv-bridge';
import { LEDGER_BINDINGS } from './ledger-bridge';

interface ScratchObject {
  key: string;
  bytes: Uint8Array;
  httpMetadata: Record<string, string>;
  customMetadata: Record<string, string>;
  etag: string;
}

let etagCounter = 0;

/** An R2-shaped object over a scratch entry. */
function r2Object(entry: ScratchObject) {
  return {
    key: entry.key,
    size: entry.bytes.byteLength,
    etag: entry.etag,
    httpEtag: `"${entry.etag}"`,
    uploaded: new Date(),
    httpMetadata: entry.httpMetadata,
    customMetadata: entry.customMetadata,
    get body() {
      return new Response(entry.bytes).body;
    },
    arrayBuffer: async () => entry.bytes.slice().buffer,
    text: async () => new TextDecoder().decode(entry.bytes),
    json: async () => JSON.parse(new TextDecoder().decode(entry.bytes)) as unknown,
    writeHttpMetadata(headers: Headers) {
      if (entry.httpMetadata.contentType) headers.set('content-type', entry.httpMetadata.contentType);
      if (entry.httpMetadata.contentDisposition) headers.set('content-disposition', entry.httpMetadata.contentDisposition);
    },
  };
}

async function bytesOfValue(value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value === null || value === undefined) return new Uint8Array();
  return new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
}

/** A copy-on-write view of an R2 bucket stub. */
function isolatedBucket(bucket: BucketLike): BucketLike {
  const scratch = new Map<string, ScratchObject | null>();
  const read = async (key: string, viaHead: boolean): Promise<unknown> => {
    if (scratch.has(key)) {
      const entry = scratch.get(key);
      return entry ? r2Object(entry) : null;
    }
    return viaHead && bucket.head ? bucket.head(key) : bucket.get(key);
  };
  const overlay = {
    get: (key: string, options?: unknown) =>
      scratch.has(key) ? read(key, false) : (bucket.get as (k: string, o?: unknown) => Promise<unknown>)(key, options),
    head: (key: string) => read(key, true),
    put: async (key: string, value: unknown, options?: unknown) => {
      const opts = (options ?? {}) as {
        httpMetadata?: Record<string, string>;
        customMetadata?: Record<string, string>;
        onlyIf?: { etagDoesNotMatch?: string };
      };
      if (opts.onlyIf?.etagDoesNotMatch === '*' && (await read(key, true))) return null;
      const bytes = await bytesOfValue(value);
      etagCounter += 1;
      const entry: ScratchObject = {
        key,
        bytes,
        httpMetadata: { ...(opts.httpMetadata ?? {}) },
        customMetadata: { ...(opts.customMetadata ?? {}) },
        etag: `scratch-${etagCounter}`,
      };
      scratch.set(key, entry);
      return r2Object(entry);
    },
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) scratch.set(key, null);
    },
  };
  // Anything else the routes call (list, multipart) goes to the stub as is.
  return new Proxy(bucket, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overlay) return overlay[prop as keyof typeof overlay];
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** A copy-on-write view of a KV namespace stub. */
function isolatedKv(kv: KvLike): KvLike {
  const scratch = new Map<string, string | null>();
  const overlay = {
    get: async (key: string, type?: unknown) => {
      const kind = typeof type === 'string' ? type : (type as { type?: string } | undefined)?.type;
      if (!scratch.has(key)) return kv.get(key, type as string);
      const text = scratch.get(key) ?? null;
      if (text === null) return null;
      return kind === 'json' ? (JSON.parse(text) as unknown) : text;
    },
    put: async (key: string, value: unknown) => {
      scratch.set(key, kvText(value) ?? '');
    },
    delete: async (key: string) => {
      scratch.set(key, null);
    },
  };
  return new Proxy(kv, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overlay) return overlay[prop as keyof typeof overlay];
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** `env` with each shared bucket and KV binding behind a copy-on-write view. */
export function isolatedEnv(env: Record<string, unknown>): Record<string, unknown> {
  const isolated: Record<string, unknown> = { ...env };
  for (const name of BUCKET_BINDINGS) {
    if (isBucketLike(env[name])) isolated[name] = isolatedBucket(env[name] as BucketLike);
  }
  for (const name of KV_BINDINGS) {
    if (isKvLike(env[name])) isolated[name] = isolatedKv(env[name] as KvLike);
  }
  // A Durable Object namespace stub that can copy its state (the portal's
  // rate-limit counters) counts the TypeScript run on the copy.
  for (const name of LEDGER_BINDINGS) {
    const ns = env[name] as { fork?: () => unknown } | undefined;
    if (ns && typeof ns.fork === 'function') isolated[name] = ns.fork();
  }
  return isolated;
}
