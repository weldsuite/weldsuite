/**
 * Conformance mode's shared KV: a test's KV namespace binding (the stub it
 * passes as `WORKSPACE_CACHE`) served over HTTP on 127.0.0.1, so the Rust
 * server reads and writes the same keys the Hono app does, as the bucket
 * bridge (./bucket-bridge.ts) shares buckets. The Rust side is
 * `rust/bins/weldsuite/src/conformance_kv.rs`, a cache-port adapter.
 *
 * Protocol (keys travel in the query string):
 *
 *   GET    /value?key=…            the value as text; 404 when missing
 *   PUT    /value?key=…&ttl=<s>    store the body; `ttl` is `expirationTtl`
 *                                  (left out: no expiry)
 *   DELETE /value?key=…            remove it (a missing key is fine)
 *
 * Test KV stubs are small (`get`, `put`, `delete`, sometimes `get(key, 'json')`
 * only answering objects), so the bridge reads text and stringifies anything
 * else.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveOnLoopback } from './bucket-bridge';

/** The KV binding methods the bridge uses. */
export interface KvLike {
  get(key: string, type?: string): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

/** Whether a binding looks like a KV namespace. */
export function isKvLike(value: unknown): value is KvLike {
  if (!value || typeof value !== 'object') return false;
  const kv = value as Record<string, unknown>;
  return typeof kv.get === 'function' && typeof kv.put === 'function' && typeof kv.delete === 'function';
}

/** A stored value as text, whatever the stub hands back. */
export function kvText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(kv: KvLike, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const key = url.searchParams.get('key');
  if (url.pathname !== '/value' || !key) {
    res.writeHead(404).end();
    return;
  }
  switch (req.method) {
    case 'GET': {
      const text = kvText(await kv.get(key));
      if (text === null) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
      return;
    }
    case 'PUT': {
      const ttl = Number(url.searchParams.get('ttl'));
      const value = await readBody(req);
      await kv.put(key, value, Number.isInteger(ttl) && ttl > 0 ? { expirationTtl: ttl } : undefined);
      res.writeHead(204).end();
      return;
    }
    case 'DELETE': {
      await kv.delete(key);
      res.writeHead(204).end();
      return;
    }
    default:
      res.writeHead(405).end();
  }
}

const bridges = new WeakMap<object, Promise<string>>();

/** The bridge's URL for this KV namespace, starting its server once. */
export function kvUrlFor(kv: KvLike): Promise<string> {
  let url = bridges.get(kv);
  if (!url) {
    url = serveOnLoopback((req, res) => handle(kv, req, res));
    bridges.set(kv, url);
  }
  return url;
}

/** The KV bindings the Rust server can read through the bridge. */
export const KV_BINDINGS = ['WORKSPACE_CACHE'] as const;

/** `{ WORKSPACE_CACHE: url }` when `env` has a KV-shaped binding, or undefined. */
export async function kvUrls(env: Record<string, unknown>): Promise<Record<string, string> | undefined> {
  const entries = await Promise.all(
    KV_BINDINGS.filter((name) => isKvLike(env[name])).map(async (name) => [name, await kvUrlFor(env[name] as KvLike)] as const),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
