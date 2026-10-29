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
 *   PUT    /object?key=…   store the body
 *   DELETE /object?key=…   remove it (a missing key is fine)
 *
 * `Content-Type` carries the object's content type, `x-meta-<name>` its custom
 * metadata, `Content-Length` its size.
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

interface ObjectMeta {
  contentType?: string;
  metadata: Record<string, string>;
  size?: number;
}

function metaOf(object: unknown): ObjectMeta {
  const o = (object ?? {}) as {
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
    size?: number;
  };
  return {
    contentType: o.httpMetadata?.contentType,
    metadata: o.customMetadata ?? {},
    size: typeof o.size === 'number' ? o.size : undefined,
  };
}

/** An object's bytes, from `arrayBuffer()`, a `body` stream, or raw bytes. */
async function bytesOf(object: unknown): Promise<Uint8Array> {
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
  for (const [name, value] of Object.entries(meta.metadata)) res.setHeader(`x-meta-${name}`, value);
  if (size !== undefined) res.setHeader('Content-Length', String(size));
}

function putOptions(req: IncomingMessage): unknown {
  const customMetadata: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.startsWith('x-meta-') && typeof value === 'string') customMetadata[name.slice('x-meta-'.length)] = value;
  }
  const contentType = req.headers['content-type'];
  return { httpMetadata: contentType ? { contentType } : undefined, customMetadata };
}

async function handle(bucket: BucketLike, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
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
    case 'PUT': {
      await bucket.put(key, await readBody(req), putOptions(req));
      res.writeHead(204).end();
      return;
    }
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

/** The bridge's URL for this bucket, starting its server once. */
export function bucketUrlFor(bucket: BucketLike): Promise<string> {
  let url = bridges.get(bucket);
  if (!url) {
    url = new Promise<string>((resolve, reject) => {
      const server: Server = createServer((req, res) => {
        handle(bucket, req, res).catch((error: unknown) => {
          res.writeHead(500).end(String(error));
        });
      });
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        process.once('beforeExit', () => server.close());
        resolve(`http://127.0.0.1:${port}`);
      });
    });
    bridges.set(bucket, url);
  }
  return url;
}

/** The bucket bindings the Rust server can read through the bridge. */
export const BUCKET_BINDINGS = ['PRIVATE_STORAGE', 'STORAGE'] as const;

/** `{ PRIVATE_STORAGE: url, … }` for each bucket binding in `env`, or undefined when there is none. */
export async function bucketUrls(env: Record<string, unknown>): Promise<Record<string, string> | undefined> {
  const entries = await Promise.all(
    BUCKET_BINDINGS.filter((name) => isBucketLike(env[name])).map(
      async (name) => [name, await bucketUrlFor(env[name] as BucketLike)] as const,
    ),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
