/**
 * Conformance mode's shared buckets: a test's R2 bucket binding served over
 * HTTP on 127.0.0.1, so the Rust server reads and writes the same objects the
 * Hono app does (as pglite-socket shares the database).
 *
 * Protocol, one object per request (keys contain slashes, so they travel in
 * the query string):
 *
 *   GET    /object?key=…   the bytes; 404 when missing
 *   HEAD   /object?key=…   the headers only
 *   PUT    /object?key=…   store the body; with `If-None-Match: *` only while
 *                          the key is free (R2's `onlyIf: { etagDoesNotMatch:
 *                          '*' }`), else 412
 *   DELETE /object?key=…   remove it (a missing key is fine)
 *   GET    /list?prefix=…&cursor=…   `bucket.list({ prefix, cursor, limit: 1000 })`
 *                          as `{ keys, truncated, cursor }` (a stub without
 *                          `list`: 501)
 *
 * `Content-Type` and `Content-Disposition` carry the object's HTTP metadata,
 * `x-meta-<name>` its custom metadata, `Content-Length` its size and `ETag`
 * its entity tag (on a PUT, the new object's).
 *
 * Test buckets are small stubs (`put`, `get` returning only `{ body }`, often
 * no `head`), so every optional part of the R2 API is optional here too.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** The R2 binding methods the bridge uses; everything else is optional. */
export interface BucketLike {
  get(key: string): Promise<unknown>;
  put(key: string, value: Uint8Array, options?: unknown): Promise<unknown>;
  delete(keys: string | string[]): Promise<unknown>;
  head?(key: string): Promise<unknown>;
}

/** Whether a binding looks like an R2 bucket. */
export function isBucketLike(value: unknown): value is BucketLike {
  if (!value || typeof value !== 'object') return false;
  const bucket = value as Record<string, unknown>;
  return typeof bucket.get === 'function' && typeof bucket.put === 'function' && typeof bucket.delete === 'function';
}

export interface ObjectMeta {
  contentType?: string;
  contentDisposition?: string;
  metadata: Record<string, string>;
  size?: number;
  etag?: string;
}

/**
 * What a stub's object says about itself: `httpMetadata`, or what its
 * `writeHttpMetadata` writes (stubs that model only the method).
 */
export function metaOf(object: unknown): ObjectMeta {
  const o = (object ?? {}) as {
    httpMetadata?: { contentType?: string; contentDisposition?: string };
    writeHttpMetadata?: (headers: Headers) => void;
    customMetadata?: Record<string, string>;
    size?: number;
    etag?: string;
    httpEtag?: string;
  };
  let { contentType, contentDisposition } = o.httpMetadata ?? {};
  if (!o.httpMetadata && typeof o.writeHttpMetadata === 'function') {
    const headers = new Headers();
    o.writeHttpMetadata(headers);
    contentType = headers.get('content-type') ?? undefined;
    contentDisposition = headers.get('content-disposition') ?? undefined;
  }
  const etag = o.etag ?? o.httpEtag?.replaceAll('"', '');
  return {
    contentType,
    contentDisposition,
    metadata: o.customMetadata ?? {},
    size: typeof o.size === 'number' ? o.size : undefined,
    etag: etag || undefined,
  };
}

/** An object's bytes, from `arrayBuffer()`, a `body` stream, or raw bytes. */
export async function bytesOf(object: unknown): Promise<Uint8Array> {
  const o = object as { arrayBuffer?: () => Promise<ArrayBuffer>; body?: unknown };
  if (typeof o.arrayBuffer === 'function') return new Uint8Array(await o.arrayBuffer());
  if (o.body instanceof Uint8Array) return o.body;
  if (o.body !== undefined && o.body !== null) return new Uint8Array(await new Response(o.body as BodyInit).arrayBuffer());
  if (object instanceof Uint8Array) return object;
  return new Uint8Array();
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

function writeHeaders(res: ServerResponse, meta: ObjectMeta, size: number | undefined): void {
  if (meta.contentType) res.setHeader('Content-Type', meta.contentType);
  if (meta.contentDisposition) res.setHeader('Content-Disposition', meta.contentDisposition);
  if (meta.etag) res.setHeader('ETag', `"${meta.etag}"`);
  for (const [name, value] of Object.entries(meta.metadata)) res.setHeader(`x-meta-${name}`, value);
  if (size !== undefined) res.setHeader('Content-Length', String(size));
}

function putOptions(req: IncomingMessage, createOnly: boolean): unknown {
  const customMetadata: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.startsWith('x-meta-') && typeof value === 'string') customMetadata[name.slice('x-meta-'.length)] = value;
  }
  const contentType = req.headers['content-type'];
  const contentDisposition = req.headers['content-disposition'];
  const httpMetadata =
    contentType || contentDisposition
      ? { ...(contentType ? { contentType } : {}), ...(contentDisposition ? { contentDisposition } : {}) }
      : undefined;
  return {
    httpMetadata,
    customMetadata,
    ...(createOnly ? { onlyIf: { etagDoesNotMatch: '*' } } : {}),
  };
}

/** Whether the bucket holds `key` (stubs without `head` answer through `get`). */
async function exists(bucket: BucketLike, key: string): Promise<boolean> {
  return Boolean(bucket.head ? await bucket.head(key) : await bucket.get(key));
}

async function handlePut(bucket: BucketLike, key: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const createOnly = req.headers['if-none-match'] === '*';
  const body = await readBody(req);
  // R2 decides a create-only put itself; many stubs ignore `onlyIf`, so the
  // bridge checks first as well.
  if (createOnly && (await exists(bucket, key))) {
    res.writeHead(412).end();
    return;
  }
  const stored = await bucket.put(key, body, putOptions(req, createOnly));
  if (createOnly && stored === null) {
    res.writeHead(412).end();
    return;
  }
  const etag = metaOf(stored).etag;
  if (etag) res.setHeader('ETag', `"${etag}"`);
  res.writeHead(204).end();
}

/** `GET /list`: one page of the bucket's keys under a prefix. */
async function handleList(bucket: BucketLike, url: URL, res: ServerResponse): Promise<void> {
  const list = (bucket as { list?: (options: unknown) => Promise<unknown> }).list;
  if (typeof list !== 'function') {
    res.writeHead(501).end();
    return;
  }
  const listed = (await list.call(bucket, {
    prefix: url.searchParams.get('prefix') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
    limit: 1000,
  })) as { objects?: Array<{ key: string }>; truncated?: boolean; cursor?: string };
  const body = JSON.stringify({
    keys: (listed.objects ?? []).map((o) => o.key),
    truncated: Boolean(listed.truncated),
    cursor: listed.truncated ? (listed.cursor ?? null) : null,
  });
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
}

async function handle(bucket: BucketLike, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/list' && req.method === 'GET') {
    await handleList(bucket, url, res);
    return;
  }
  const key = url.searchParams.get('key');
  if (url.pathname !== '/object' || !key) {
    res.writeHead(404).end();
    return;
  }
  switch (req.method) {
    case 'GET': {
      const object = await bucket.get(key);
      if (!object) {
        res.writeHead(404).end();
        return;
      }
      const bytes = await bytesOf(object);
      writeHeaders(res, metaOf(object), bytes.byteLength);
      res.writeHead(200).end(bytes);
      return;
    }
    case 'HEAD': {
      const object = bucket.head ? await bucket.head(key) : await bucket.get(key);
      if (!object) {
        res.writeHead(404).end();
        return;
      }
      const meta = metaOf(object);
      // Without a size on the stub's answer, read the bytes to count them.
      const size = meta.size ?? (bucket.head ? undefined : (await bytesOf(object)).byteLength);
      writeHeaders(res, meta, size);
      res.writeHead(200).end();
      return;
    }
    case 'PUT':
      await handlePut(bucket, key, req, res);
      return;
    case 'DELETE': {
      await bucket.delete(key);
      res.writeHead(204).end();
      return;
    }
    default:
      res.writeHead(405).end();
  }
}

const bridges = new WeakMap<object, Promise<string>>();

/** Serve `handler` on 127.0.0.1 (a free port), for the life of the process. */
export function serveOnLoopback(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      handler(req, res).catch((error: unknown) => {
        res.writeHead(500).end(String(error));
      });
    });
    // The Rust server's client (reqwest) keeps an idle connection 90s; Node
    // closes one after 5s by default, and a request sent on it as it closes
    // fails ("connection closed before message completed"). Outlive the
    // client's pool instead, and let an idle connection never hold the
    // process open.
    server.keepAliveTimeout = 120_000;
    server.on('connection', (socket) => socket.unref());
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      process.once('beforeExit', () => server.close());
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/** The bridge's URL for this bucket, starting its server once. */
export function bucketUrlFor(bucket: BucketLike): Promise<string> {
  let url = bridges.get(bucket);
  if (!url) {
    url = serveOnLoopback((req, res) => handle(bucket, req, res));
    bridges.set(bucket, url);
  }
  return url;
}

/** The part of a KV namespace (`createMemoryKv()`) the bridge serves. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const kvBuckets = new WeakMap<object, BucketLike>();

/**
 * A KV namespace served like a bucket, one value per object (its UTF-8
 * bytes): Rust's cache port reads and writes the test's namespace through
 * it (`conformance_portal.rs`).
 */
export function kvBucketUrl(kv: KvLike): Promise<string> {
  let bucket = kvBuckets.get(kv);
  if (!bucket) {
    bucket = {
      get: async (key: string) => {
        const value = await kv.get(key);
        return value === null ? null : { arrayBuffer: async () => new TextEncoder().encode(value).buffer };
      },
      put: (key: string, value: Uint8Array) => kv.put(key, new TextDecoder().decode(value)),
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) await kv.delete(key);
      },
    };
    kvBuckets.set(kv, bucket);
  }
  return bucketUrlFor(bucket);
}

/** The bucket bindings the Rust server can read through the bridge. */
export const BUCKET_BINDINGS = ['PRIVATE_STORAGE', 'STORAGE', 'MEETING_RECORDINGS'] as const;

/** `{ PRIVATE_STORAGE: url, … }` for each bucket binding in `env`, or undefined when there is none. */
export async function bucketUrls(env: Record<string, unknown>): Promise<Record<string, string> | undefined> {
  const entries = await Promise.all(
    BUCKET_BINDINGS.filter((name) => isBucketLike(env[name])).map(
      async (name) => [name, await bucketUrlFor(env[name] as BucketLike)] as const,
    ),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
