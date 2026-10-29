/**
 * Conformance mode's shared KV: a test's `WORKSPACE_CACHE` binding served over
 * HTTP on 127.0.0.1, so the Rust server's cache port reads and writes the same
 * entries the Hono app does (as ./bucket-bridge.ts shares R2 buckets).
 *
 * Opt-in: a test hands its KV to `conformanceKv(kv)`. Only those are shared,
 * so the suites whose KV stubs count calls are left alone.
 *
 *   GET    /kv?key=…          the value as text; 404 when missing
 *   PUT    /kv?key=…&ttl=…    store the body (ttl in seconds, optional)
 *   DELETE /kv?key=…          remove it (a missing key is fine)
 *
 * Unlike the database, a KV namespace can't be cloned, so both runs start
 * from the same entries by undoing writes instead: every write through the
 * bridge (Rust's) and through `recordingKv` (TypeScript's) is journaled with
 * the value it replaced. `conformance.ts` undoes one run's writes before the
 * other runs, and leaves Rust's in place for the test's own assertions.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** The KV binding methods the bridge uses. */
export interface KvLike {
  get(key: string, type?: unknown): Promise<unknown>;
  put(key: string, value: string, options?: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

/** One write: the key, the value before it (null when absent) and after it (null for a delete). */
export interface KvWrite {
  key: string;
  before: string | null;
  after: string | null;
}

const shared = new WeakSet<object>();

/** Share `kv` with the Rust server in conformance mode (a no-op otherwise). */
export function conformanceKv<T extends object>(kv: T): T {
  shared.add(kv);
  return kv;
}

/** Whether a binding is a KV namespace the test shared. */
export function isSharedKv(value: unknown): value is KvLike {
  if (!value || typeof value !== 'object' || !shared.has(value)) return false;
  const kv = value as Record<string, unknown>;
  return typeof kv.get === 'function' && typeof kv.put === 'function' && typeof kv.delete === 'function';
}

/** A stored value as text: stubs may hand back parsed JSON. */
async function textOf(kv: KvLike, key: string): Promise<string | null> {
  const value = await kv.get(key);
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

interface Bridge {
  url: Promise<string>;
  journal: KvWrite[];
}

const bridges = new WeakMap<object, Bridge>();

async function handle(kv: KvLike, journal: KvWrite[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const key = url.searchParams.get('key');
  if (url.pathname !== '/kv' || !key) {
    res.writeHead(404).end();
    return;
  }
  switch (req.method) {
    case 'GET': {
      const value = await textOf(kv, key);
      if (value === null) res.writeHead(404).end();
      else res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(value);
      return;
    }
    case 'PUT': {
      const value = await readBody(req);
      const before = await textOf(kv, key);
      const ttl = Number(url.searchParams.get('ttl'));
      await kv.put(key, value, Number.isFinite(ttl) && ttl > 0 ? { expirationTtl: ttl } : undefined);
      journal.push({ key, before, after: value });
      res.writeHead(204).end();
      return;
    }
    case 'DELETE': {
      const before = await textOf(kv, key);
      await kv.delete(key);
      journal.push({ key, before, after: null });
      res.writeHead(204).end();
      return;
    }
    default:
      res.writeHead(405).end();
  }
}

function bridgeFor(kv: KvLike): Bridge {
  let bridge = bridges.get(kv);
  if (!bridge) {
    const journal: KvWrite[] = [];
    const url = new Promise<string>((resolve, reject) => {
      const server: Server = createServer((req, res) => {
        handle(kv, journal, req, res).catch((error: unknown) => {
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
    bridge = { url, journal };
    bridges.set(kv, bridge);
  }
  return bridge;
}

/** The bridge's URL for the test's shared `WORKSPACE_CACHE`, or undefined when it isn't shared. */
export async function kvUrl(env: Record<string, unknown>): Promise<string | undefined> {
  const kv = env.WORKSPACE_CACHE;
  return isSharedKv(kv) ? bridgeFor(kv).url : undefined;
}

/** Rust's writes through the bridge since the last call, clearing them. */
export function takeKvJournal(kv: KvLike): KvWrite[] {
  return bridges.get(kv)?.journal.splice(0) ?? [];
}

/** `kv` with its writes journaled into `journal`, for the Hono app's run. */
export function recordingKv(kv: KvLike, journal: KvWrite[]): KvLike {
  return new Proxy(kv, {
    get(target, prop, receiver) {
      if (prop === 'put') {
        return async (key: string, value: string, options?: unknown) => {
          const before = await textOf(target, key);
          const result = await target.put(key, value, options);
          journal.push({ key, before, after: typeof value === 'string' ? value : JSON.stringify(value) });
          return result;
        };
      }
      if (prop === 'delete') {
        return async (key: string) => {
          const before = await textOf(target, key);
          const result = await target.delete(key);
          journal.push({ key, before, after: null });
          return result;
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

async function write(kv: KvLike, key: string, value: string | null): Promise<void> {
  if (value === null) await kv.delete(key);
  else await kv.put(key, value);
}

/** Put back what `writes` replaced, newest first. */
export async function undoKv(kv: KvLike, writes: readonly KvWrite[]): Promise<void> {
  for (const entry of [...writes].reverse()) await write(kv, entry.key, entry.before);
}

/** Apply `writes` again, oldest first. */
export async function redoKv(kv: KvLike, writes: readonly KvWrite[]): Promise<void> {
  for (const entry of writes) await write(kv, entry.key, entry.after);
}
