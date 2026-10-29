/**
 * Conformance mode (phase P2 of the editions plan): the worker tests drive the
 * Rust backend (`rust/`) over HTTP, unchanged, and every answer is compared
 * with the Hono app's.
 *
 *   CONFORMANCE_TARGET=rust            send `request()` to the Rust server
 *   CONFORMANCE_TARGET=record          run as usual, only record routes and statuses
 *                                      (the per-worker coverage report)
 *   CONFORMANCE_RUST_URL=http://…      where it listens (default 127.0.0.1:18089)
 *   CONFORMANCE_STRICT=0               record differences instead of failing
 *   CONFORMANCE_REPORT_DIR=…           append one JSON line per request there
 *
 * Per request, from `createTestApp().request()`:
 *
 * 1. The test's pglite database is served over the Postgres wire protocol
 *    (`@electric-sql/pglite-socket`), so Rust queries the same seeded state.
 *    Its R2 bucket bindings (`PRIVATE_STORAGE`, `STORAGE`) are served over
 *    HTTP (./bucket-bridge.ts), so Rust reads and writes the same objects.
 * 2. The request goes to Rust with the test's context (user, org, workspace,
 *    pre-resolved permissions, database URL) in `X-Weld-Conformance`. Only a
 *    server built with the `conformance` Cargo feature reads it.
 * 3. The same request runs on the Hono app: for a read on the same database
 *    first; for a write on a clone of it taken before Rust runs, so both start
 *    from the same state and the test's own assertions see Rust's writes.
 * 4. Status and JSON are compared (ids, timestamps and cursors normalised for
 *    writes), the body is validated against the route's Zod schema when one is
 *    registered (./conformance-schemas.ts), and the outcome is recorded.
 * 5. Side effects are compared too: the Hono app gets recording
 *    `ENTITY_EVENTS` and `REALTIME` bindings (unless the test brings its own),
 *    Rust records through its port doubles, and both lists must match. The
 *    runner runs one test file at a time, so Rust's recordings are this
 *    request's.
 *
 * The test gets Rust's response, so its assertions check Rust too.
 */

import { createServer } from 'node:net';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from '../env';
import { pgliteClientOf } from './pglite';
import { schemaFor } from './conformance-schemas';
import { bucketUrls } from './bucket-bridge';
import { createMailCollector, mailRecord, type MailRecord, type RustMail, type SentByTypeScript } from './conformance-mail';
import {
  type OutboundCall,
  outboundBridgeUrl,
  recordOutbound,
  sortOutbound,
  takeRustOutbound,
} from './outbound-bridge';

export interface ConformanceTarget {
  url: string;
  strict: boolean;
  reportDir: string | undefined;
}

/** The Rust server to send requests to, or null outside conformance mode. */
export function conformanceTarget(): ConformanceTarget | null {
  if (process.env.CONFORMANCE_TARGET !== 'rust') return null;
  return {
    url: (process.env.CONFORMANCE_RUST_URL ?? 'http://127.0.0.1:18089').replace(/\/$/, ''),
    strict: process.env.CONFORMANCE_STRICT !== '0',
    reportDir: process.env.CONFORMANCE_REPORT_DIR || undefined,
  };
}

/**
 * Record-only mode: the tests run on the Hono app as usual and the routes they
 * reach are recorded, for the coverage report of a worker that isn't ported
 * yet (playbook step 1). Needs CONFORMANCE_REPORT_DIR.
 */
export function recordOnlyTarget(): ConformanceTarget | null {
  if (process.env.CONFORMANCE_TARGET !== 'record' || !process.env.CONFORMANCE_REPORT_DIR) return null;
  return { url: '', strict: false, reportDir: process.env.CONFORMANCE_REPORT_DIR };
}

/** Request header carrying the test's context to the Rust server. */
export const CONFORMANCE_HEADER = 'X-Weld-Conformance';

/** Response header naming the route that answered (both runtimes set it in this mode). */
export const ROUTE_HEADER = 'X-Weld-Route';

/** Env bindings the Rust server honours per request in conformance mode. */
const FORWARDED_ENV = ['PERMISSIONS_APP_ENFORCE', 'SIGN_SESSION_SECRET', 'R2_PUBLIC_URL'] as const;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface ConformanceContext {
  userId: string;
  orgId: string | null;
  workspaceId: string;
  clerkOrgId: string | null;
  sessionId: string;
  factorVerificationAge?: readonly [number, number] | null;
  tenantDb: Database;
  /** The master database, when the routes use one (shared, never cloned). */
  masterDb?: Database;
  permissions?: unknown;
  /** The test's flag evaluator (`context.flags`), if any. */
  flags?: unknown;
}

// ── side effects ────────────────────────────────────────────────────────────

export interface SideEffects {
  /** Messages sent to the `ENTITY_EVENTS` queue. */
  events: unknown[];
  /** POSTs to the realtime-worker, as `{ path, body }`. */
  realtime: Array<{ path: string; body: unknown }>;
  /** System mail, compared as records (./conformance-mail.ts). */
  mail: MailRecord[];
  /** Calls to third-party APIs (Clerk, Expo, …), sorted (./outbound-bridge.ts). */
  outbound?: OutboundCall[];
}

/** The URL a `fetch` was called with, whatever form it came in. */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Recording `ENTITY_EVENTS` and `REALTIME` bindings for the Hono app, and a
 * `drain()` that waits for the request's `waitUntil` work and returns what
 * it sent.
 */
export function createSideEffectRecorder() {
  const effects: Omit<SideEffects, 'mail'> = { events: [], realtime: [] };
  const mail = createMailCollector();
  let lastMail: SentByTypeScript[] = [];
  const pending: Promise<unknown>[] = [];
  const copy = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
  return {
    bindings: {
      ENTITY_EVENTS: {
        send: async (message: unknown) => {
          effects.events.push(copy(message));
        },
        sendBatch: async (messages: Array<{ body: unknown }>) => {
          for (const message of messages) effects.events.push(copy(message.body));
        },
      },
      REALTIME: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(requestUrl(input));
          const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
          effects.realtime.push({ path: url.pathname, body });
          return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
        },
      },
    },
    track(promise: Promise<unknown>) {
      pending.push(promise);
    },
    async drain(): Promise<SideEffects> {
      while (pending.length > 0) await Promise.allSettled(pending.splice(0));
      lastMail = mail.take();
      return {
        events: effects.events.splice(0),
        realtime: effects.realtime.splice(0),
        mail: lastMail.map((m) => mailRecord(m.email)),
      };
    },
    /** The emails the last `drain()` reported, with their transports. */
    lastMail(): SentByTypeScript[] {
      return lastMail;
    },
    /** Give the test Rust's mail in place of TypeScript's. */
    adoptMail(typescript: SentByTypeScript[], rust: RustMail[]): void {
      mail.adopt(typescript, rust);
    },
  };
}

export type SideEffectRecorder = ReturnType<typeof createSideEffectRecorder>;

interface RustSideEffects {
  effects: SideEffects;
  mail: RustMail[];
}

async function rustSideEffects(target: ConformanceTarget): Promise<RustSideEffects> {
  const response = await fetch(`${target.url}/__conformance/side-effects`);
  const body = (await response.json()) as Omit<SideEffects, 'mail'> & { mail?: RustMail[] };
  const mail = body.mail ?? [];
  return {
    effects: {
      events: body.events,
      realtime: body.realtime,
      mail: mail.map((m) =>
        mailRecord({
          ...m,
          replyTo: m.replyTo ?? undefined,
          attachments: m.attachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            content: new Uint8Array(Buffer.from(a.contentBase64, 'base64')),
          })),
        }),
      ),
    },
    mail,
  };
}

/** What the test's flag evaluator answers for every catalog flag, for Rust. */
async function flagValues(flags: unknown): Promise<Record<string, unknown> | undefined> {
  if (!flags || typeof flags !== 'object') return undefined;
  const evaluator = flags as {
    getValue?: (key: string) => Promise<unknown>;
    isOn?: (key: string) => Promise<boolean>;
  };
  const { FLAGS } = await import('@weldsuite/feature-flags/flags');
  const values: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(FLAGS)) {
    try {
      if (typeof evaluator.getValue === 'function') values[key] = await evaluator.getValue(key);
      else if (definition.type === 'boolean' && typeof evaluator.isOn === 'function') {
        values[key] = await evaluator.isOn(key);
      }
    } catch {
      // A stub that only knows some flags: the rest stay at their defaults.
    }
  }
  return values;
}

export interface ConformanceRequest {
  target: ConformanceTarget;
  ctx: ConformanceContext;
  env: Record<string, unknown>;
  input: string;
  init: RequestInit | undefined;
  /** Run the request on the Hono app, against `tenantDb`. */
  runTypeScript: (tenantDb: Database, input: string, init?: RequestInit) => Promise<Response>;
  /** The Hono app's recording bindings. */
  sideEffects: SideEffectRecorder;
}

// ── the shared database ─────────────────────────────────────────────────────

type PGliteClient = NonNullable<ReturnType<typeof pgliteClientOf>>;

const servers = new Map<PGliteClient, Promise<string>>();

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** A Postgres URL for the test's pglite, starting its socket server once. */
function databaseUrlFor(client: PGliteClient): Promise<string> {
  let url = servers.get(client);
  if (!url) {
    url = (async () => {
      const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
      const port = await freePort();
      const server = new PGLiteSocketServer({ db: client as never, port, host: '127.0.0.1', maxConnections: 8 });
      await server.start();
      process.once('beforeExit', () => void server.stop());
      // A unique name per database: the Rust server keys its pools by URL, and a
      // later test process may get the same port for a different database.
      const name = `conformance-${process.pid}-${port}-${Date.now().toString(36)}`;
      return `postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable&application_name=${name}`;
    })();
    servers.set(client, url);
  }
  return url;
}

/** A drizzle handle on a copy of the test's database, for the TypeScript side of a write. */
async function cloneDatabase(client: PGliteClient): Promise<{ db: Database; close: () => Promise<void> }> {
  const [drizzlePg, schema] = await Promise.all([import('drizzle-orm/pglite'), import('@weldsuite/db/schema')]);
  const clone = await client.clone();
  const db = drizzlePg.drizzle(clone as never, { schema }) as unknown as Database;
  return { db, close: () => (clone as { close: () => Promise<void> }).close() };
}

// ── comparison ──────────────────────────────────────────────────────────────

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** `generateId()` output: a prefix, `_`, base36 time and randomness. */
const GENERATED_ID = /^[a-z][a-z0-9]*_[0-9a-z]{12,}$/;
/**
 * `Date.now()` inside a string (a storage key, a URL): 13 digits from 2001 to
 * 2286, not part of a longer number. Differs between two runs of a write.
 */
const EPOCH_MS = /(?<!\d)1\d{12}(?!\d)/g;

/**
 * Sorted keys, and for writes the values that differ by construction between
 * two runs (new ids, timestamps, cursors) replaced by placeholders. Reads run
 * on the same rows, so they are compared exactly.
 */
export function normalizeForDiff(value: unknown, isWrite: boolean, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForDiff(item, isWrite));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, normalizeForDiff((value as Record<string, unknown>)[k], isWrite, k)]),
    );
  }
  if (isWrite && typeof value === 'string') {
    if (key === 'cursor') return '<cursor>';
    if (ISO_TIMESTAMP.test(value)) return '<timestamp>';
    if (GENERATED_ID.test(value)) return '<id>';
    return value.replace(EPOCH_MS, '<epoch-ms>');
  }
  return value;
}

/** The first place two normalised JSON values differ, as a path and both values; null when equal. */
export function firstDifference(a: unknown, b: unknown, at = '$'): string | null {
  if (Object.is(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) return firstArrayDifference(a, b, at);
  if (isPlainObject(a) && isPlainObject(b)) return firstObjectDifference(a, b, at);
  return `${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstArrayDifference(a: unknown[], b: unknown[], at: string): string | null {
  if (a.length !== b.length) return `${at}: ${a.length} items vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const diff = firstDifference(a[i], b[i], `${at}[${i}]`);
    if (diff) return diff;
  }
  return null;
}

function firstObjectDifference(a: Record<string, unknown>, b: Record<string, unknown>, at: string): string | null {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) {
    const diff = firstDifference(a[key], b[key], `${at}.${key}`);
    if (diff) return diff;
  }
  return null;
}

interface Captured {
  status: number;
  headers: Headers;
  /** The body as it came: a PDF is not text. */
  bytes: Uint8Array;
  text: string;
  json: unknown;
}

async function capture(response: Response): Promise<Captured> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let json: unknown;
  if ((response.headers.get('content-type') ?? '').includes('json') && text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { status: response.status, headers: response.headers, bytes, text, json };
}

// ── recording ───────────────────────────────────────────────────────────────

export interface ConformanceRecord {
  file: string | undefined;
  test: string | undefined;
  method: string;
  path: string;
  /** The Hono route pattern that answered (`/api/companies/:id`). */
  route: string | null;
  tsStatus: number;
  /** null in record-only mode. */
  rustStatus: number | null;
  match: boolean;
  difference: string | null;
  schema: 'ok' | 'fail' | 'none';
  schemaError: string | null;
}

async function currentTest(): Promise<{ file?: string; test?: string }> {
  try {
    const { expect } = await import('vitest');
    const state = expect.getState();
    return { file: state.testPath, test: state.currentTestName };
  } catch {
    return {};
  }
}

async function appendLines(dir: string, lines: readonly unknown[]): Promise<void> {
  if (lines.length === 0) return;
  await mkdir(dir, { recursive: true });
  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join('');
  await appendFile(path.join(dir, `conformance-${process.pid}.jsonl`), text);
}

async function record(dir: string, entry: ConformanceRecord): Promise<void> {
  await appendLines(dir, [{ kind: 'request', ...entry }]);
}

/**
 * Record the routes of an app under test, so the coverage report can list the
 * ones no test reaches. Called once per `createTestApp()` in conformance mode.
 */
export async function recordInventory(
  target: ConformanceTarget,
  routes: ReadonlyArray<{ method: string; path: string }>,
): Promise<void> {
  if (!target.reportDir) return;
  const { file } = await currentTest();
  await appendLines(
    target.reportDir,
    routes.filter((r) => r.method !== 'ALL').map((r) => ({ kind: 'inventory', file, method: r.method, route: r.path })),
  );
}

/** Record-only mode: run on the Hono app and note the route and status. */
export async function recordOnlyRequest(
  target: ConformanceTarget,
  method: string,
  input: string,
  run: () => Promise<Response>,
): Promise<Response> {
  const response = await run();
  if (target.reportDir) {
    const { file, test } = await currentTest();
    await record(target.reportDir, {
      file,
      test,
      method: method.toUpperCase(),
      path: pathOf(input),
      route: response.headers.get(ROUTE_HEADER),
      tsStatus: response.status,
      rustStatus: null,
      match: true,
      difference: null,
      schema: 'none',
      schemaError: null,
    });
  }
  return response;
}

// ── the request ─────────────────────────────────────────────────────────────

function pathOf(input: string): string {
  if (/^https?:\/\//.test(input)) {
    const url = new URL(input);
    return `${url.pathname}${url.search}`;
  }
  return input;
}

/** The URL the master pglite is served at, when the test has one. */
async function masterDatabaseUrl(masterDb: Database | undefined): Promise<string | null> {
  const client = masterDb ? pgliteClientOf(masterDb) : undefined;
  return client ? databaseUrlFor(client) : null;
}

/** The test's context as the Rust server's conformance mode reads it. */
async function testContext(ctx: ConformanceContext, env: Record<string, unknown>, databaseUrl: string) {
  const forwardedEnv = Object.fromEntries(
    FORWARDED_ENV.filter((name) => typeof env[name] === 'string').map((name) => [name, env[name] as string]),
  );
  return {
    userId: ctx.userId,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    clerkOrgId: ctx.clerkOrgId,
    sessionId: ctx.sessionId,
    factorVerificationAge: ctx.factorVerificationAge ?? null,
    databaseUrl,
    masterDatabaseUrl: await masterDatabaseUrl(ctx.masterDb),
    permissions: ctx.permissions,
    flags: await flagValues(ctx.flags),
    env: forwardedEnv,
    // The test's buckets, served over HTTP so Rust shares their objects.
    files: await bucketUrls(env),
    // Third-party calls (Clerk, …) go through the test's own `fetch` stub.
    outbound: await outboundBridgeUrl(),
  };
}

interface Runs {
  ts: Captured;
  rust: Captured;
  tsEffects: SideEffects;
  rustEffects: SideEffects;
  /** The mail each side sent, to hand Rust's to the test afterwards. */
  tsMail: SentByTypeScript[];
  rustMail: RustMail[];
}

/**
 * Both runs from the same starting state: a read runs TypeScript and then
 * Rust on the test's database; a write runs Rust on it (the test's own
 * assertions then see Rust's writes) and TypeScript on a copy taken first.
 */
async function runBoth(
  request: ConformanceRequest,
  client: PGliteClient,
  isWrite: boolean,
  runRust: () => Promise<Captured>,
  runTypeScript: (db: Database) => Promise<Captured>,
): Promise<Runs> {
  // Start both recordings empty.
  await request.sideEffects.drain();
  await rustSideEffects(request.target);
  takeRustOutbound();

  // The Hono app's run, its `waitUntil` work included, with its outbound calls.
  const typeScript = async (db: Database) => {
    const { result, calls } = await recordOutbound(async () => {
      const ts = await runTypeScript(db);
      return { ts, effects: await request.sideEffects.drain() };
    });
    return {
      ts: result.ts,
      tsEffects: { ...result.effects, outbound: sortOutbound(calls) },
      tsMail: request.sideEffects.lastMail(),
    };
  };
  // Rust's run; its outbound calls are what reached the bridge.
  const rustRun = async () => {
    const rust = await runRust();
    const side = await rustSideEffects(request.target);
    return {
      rust,
      rustEffects: { ...side.effects, outbound: sortOutbound(takeRustOutbound()) },
      rustMail: side.mail,
    };
  };

  if (!isWrite) {
    const ts = await typeScript(request.ctx.tenantDb);
    return { ...ts, ...(await rustRun()) };
  }
  const clone = await cloneDatabase(client);
  try {
    const rust = await rustRun();
    return { ...rust, ...(await typeScript(clone.db)) };
  } finally {
    await clone.close();
  }
}

/** Where the two runs differ: status, body, then side effects; null when they match. */
function compareRuns({ ts, rust, tsEffects, rustEffects }: Runs, isWrite: boolean): string | null {
  if (ts.status !== rust.status) return `status ${ts.status} (TypeScript) vs ${rust.status} (Rust)`;
  if (ts.json !== undefined || rust.json !== undefined) {
    const body = firstDifference(normalizeForDiff(ts.json, isWrite), normalizeForDiff(rust.json, isWrite));
    if (body) return body;
  } else if (Buffer.compare(ts.bytes, rust.bytes) !== 0) {
    return 'response bodies differ';
  }
  // New event ids and timestamps differ by construction, even on a read.
  const effects = firstDifference(normalizeForDiff(tsEffects, true), normalizeForDiff(rustEffects, true));
  return effects ? `side effects: ${effects}` : null;
}

/** Rust's successful body against the route's registered Zod schema. */
function checkSchema(
  method: string,
  route: string | null,
  rust: Captured,
): Pick<ConformanceRecord, 'schema' | 'schemaError'> {
  const validator = route ? schemaFor(method, route) : undefined;
  if (!validator || rust.status >= 300 || rust.json === undefined) return { schema: 'none', schemaError: null };
  const error = validator(rust.json);
  return { schema: error === null ? 'ok' : 'fail', schemaError: error };
}

/**
 * A body both runs can send: text as it is, anything else (a multipart
 * `FormData`, a `Blob`, bytes) serialised once, so both get the same bytes
 * and the same multipart boundary, which goes into `headers`.
 */
async function replayableBody(body: BodyInit | null | undefined, headers: Headers): Promise<string | Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  const serialised = new Request('https://conformance.local/', { method: 'POST', body });
  const type = serialised.headers.get('content-type');
  if (type && !headers.has('content-type')) headers.set('content-type', type);
  return new Uint8Array(await serialised.arrayBuffer());
}

/** Run one test request against Rust and TypeScript, compare, and return Rust's response. */
export async function conformanceRequest(request: ConformanceRequest): Promise<Response> {
  const { target, ctx, env, init } = request;
  const input = pathOf(request.input);
  const method = (init?.method ?? 'GET').toUpperCase();
  const isWrite = !SAFE_METHODS.has(method);

  const client = pgliteClientOf(ctx.tenantDb);
  if (!client) {
    throw new Error(
      'Conformance mode needs a pglite tenantDb (createPgliteDb()): this test uses a mock database, which the Rust server cannot reach.',
    );
  }
  const context = await testContext(ctx, env, await databaseUrlFor(client));

  // A request body can be read once: keep it as text or bytes for both runs.
  const headers = new Headers(init?.headers);
  const body = await replayableBody(init?.body, headers);
  const rustHeaders = new Headers(headers);
  rustHeaders.set(CONFORMANCE_HEADER, Buffer.from(JSON.stringify(context)).toString('base64'));
  // The Hono app sees `http://localhost/...`; tell Rust the same origin, as
  // an ingress would, so URLs built from it (private object URLs) match.
  rustHeaders.set('X-Forwarded-Host', 'localhost');
  rustHeaders.set('X-Forwarded-Proto', 'http');

  const runs = await runBoth(
    request,
    client,
    isWrite,
    () => fetch(`${target.url}${input}`, { ...init, method, headers: rustHeaders, body }).then(capture),
    (db) => request.runTypeScript(db, input, { ...init, method, headers, body }).then(capture),
  );
  const { ts, rust } = runs;
  // The test reads Rust's mail, as it reads Rust's response.
  request.sideEffects.adoptMail(runs.tsMail, runs.rustMail);
  const route = ts.headers.get(ROUTE_HEADER);
  const difference = compareRuns(runs, isWrite);
  const { schema, schemaError } = checkSchema(method, route, rust);

  if (target.reportDir) {
    const { file, test } = await currentTest();
    await record(target.reportDir, {
      file,
      test,
      method,
      path: input,
      route,
      tsStatus: ts.status,
      rustStatus: rust.status,
      match: difference === null,
      difference,
      schema,
      schemaError,
    });
  }

  if (target.strict && (difference || schemaError)) {
    throw new Error(
      `Conformance: ${method} ${input} differs between TypeScript and Rust: ${difference ?? schemaError}\n` +
        `TypeScript: ${ts.status} ${ts.text.slice(0, 500)}\nRust: ${rust.status} ${rust.text.slice(0, 500)}`,
    );
  }

  const nullBody = [101, 204, 205, 304].includes(rust.status);
  return new Response(nullBody ? null : rust.bytes, { status: rust.status, headers: rust.headers });
}
