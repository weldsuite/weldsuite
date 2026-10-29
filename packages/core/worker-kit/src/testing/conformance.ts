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
 * 2. The request goes to Rust with the test's context (user, org, workspace,
 *    pre-resolved permissions, database URL) in `X-Weld-Conformance`. Only a
 *    server built with the `conformance` Cargo feature reads it.
 * 3. The same request runs on the Hono app: for a read on the same database
 *    first; for a write on a clone of it taken before Rust runs, so both start
 *    from the same state and the test's own assertions see Rust's writes.
 * 4. Status and JSON are compared (ids, timestamps and cursors normalised for
 *    writes), the body is validated against the route's Zod schema when one is
 *    registered (./conformance-schemas.ts), and the outcome is recorded.
 *
 * The test gets Rust's response, so its assertions check Rust too.
 */

import { createServer } from 'node:net';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from '../env';
import { pgliteClientOf } from './pglite';
import { schemaFor } from './conformance-schemas';

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
const FORWARDED_ENV = ['PERMISSIONS_APP_ENFORCE'] as const;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface ConformanceContext {
  userId: string;
  orgId: string | null;
  workspaceId: string;
  clerkOrgId: string | null;
  sessionId: string;
  factorVerificationAge?: readonly [number, number] | null;
  tenantDb: Database;
  permissions?: unknown;
}

export interface ConformanceRequest {
  target: ConformanceTarget;
  ctx: ConformanceContext;
  env: Record<string, unknown>;
  input: string;
  init: RequestInit | undefined;
  /** Run the request on the Hono app, against `tenantDb`. */
  runTypeScript: (tenantDb: Database, input: string, init?: RequestInit) => Promise<Response>;
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
      return `postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
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
  }
  return value;
}

/** The first place two normalised JSON values differ, as a path and both values; null when equal. */
export function firstDifference(a: unknown, b: unknown, at = '$'): string | null {
  if (Object.is(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${at}: ${a.length} items vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const diff = firstDifference(a[i], b[i], `${at}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      const diff = firstDifference(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${at}.${k}`,
      );
      if (diff) return diff;
    }
    return null;
  }
  return `${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

interface Captured {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

async function capture(response: Response): Promise<Captured> {
  const text = await response.text();
  let json: unknown;
  if ((response.headers.get('content-type') ?? '').includes('json') && text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { status: response.status, headers: response.headers, text, json };
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
  const databaseUrl = await databaseUrlFor(client);

  const forwardedEnv = Object.fromEntries(
    FORWARDED_ENV.filter((name) => typeof env[name] === 'string').map((name) => [name, env[name] as string]),
  );
  const context = {
    userId: ctx.userId,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    clerkOrgId: ctx.clerkOrgId,
    sessionId: ctx.sessionId,
    factorVerificationAge: ctx.factorVerificationAge ?? null,
    databaseUrl,
    permissions: ctx.permissions,
    env: forwardedEnv,
  };

  // A request body can be read once: keep it as text for both runs.
  const body = init?.body === undefined || init.body === null ? undefined : init.body;
  if (body !== undefined && typeof body !== 'string') {
    throw new Error('Conformance mode supports string request bodies only (JSON.stringify the body).');
  }
  const headers = new Headers(init?.headers);
  const rustHeaders = new Headers(headers);
  rustHeaders.set(CONFORMANCE_HEADER, Buffer.from(JSON.stringify(context)).toString('base64'));

  const runRust = () =>
    fetch(`${target.url}${input}`, { ...init, method, headers: rustHeaders, body }).then(capture);
  const runTypeScript = (db: Database) =>
    request.runTypeScript(db, input, { ...init, method, headers, body }).then(capture);

  let ts: Captured;
  let rust: Captured;
  if (isWrite) {
    const clone = await cloneDatabase(client);
    try {
      rust = await runRust();
      ts = await runTypeScript(clone.db);
    } finally {
      await clone.close();
    }
  } else {
    ts = await runTypeScript(ctx.tenantDb);
    rust = await runRust();
  }

  const route = ts.headers.get(ROUTE_HEADER);
  let difference: string | null = null;
  if (ts.status !== rust.status) {
    difference = `status ${ts.status} (TypeScript) vs ${rust.status} (Rust)`;
  } else if (ts.json !== undefined || rust.json !== undefined) {
    difference = firstDifference(normalizeForDiff(ts.json, isWrite), normalizeForDiff(rust.json, isWrite));
  } else if (ts.text !== rust.text) {
    difference = 'response bodies differ';
  }

  let schema: ConformanceRecord['schema'] = 'none';
  let schemaError: string | null = null;
  const validator = route ? schemaFor(method, route) : undefined;
  if (validator && rust.status < 300 && rust.json !== undefined) {
    const result = validator(rust.json);
    schema = result === null ? 'ok' : 'fail';
    schemaError = result;
  }

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
  return new Response(nullBody ? null : rust.text, { status: rust.status, headers: rust.headers });
}
