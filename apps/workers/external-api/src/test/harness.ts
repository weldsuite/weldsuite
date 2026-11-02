/**
 * Test harness for external-api route tests.
 *
 * `createExternalTestApp(options)` builds a fresh Hono app, injects a stub
 * that sets the same context variables the real auth + tenant-db middleware
 * would (`apiSession`, `tenantDb`, `workspaceId`, `userId`), then mounts the
 * real `licenceMiddleware` and `v1` router under `/v1`. The real `authMiddleware` /
 * `tenantDbMiddleware` / `rateLimitMiddleware` (which need KV / Hyperdrive /
 * Neon / Durable Objects) are bypassed — exactly the seam app-api's harness
 * uses for Clerk.
 *
 * - Pass `scopes` to control what `requireScope` allows (default `['*']`).
 * - Pass `session: null` to omit `apiSession` entirely (exercises the 401 path).
 * - Pass `tenantDb` (a pglite-backed `Database`) for tests that hit the DB.
 *
 * The env handed to `app.request()` has NO queue/realtime bindings, so the
 * route's `publishEntityEvent(...)` calls cleanly no-op (they only touch
 * `executionCtx.waitUntil` inside `if (env.<QUEUE>)` guards).
 *
 * Mirrors packages/core/worker-kit/src/testing/harness.ts.
 */

import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { matchedRoutes } from 'hono/route';
import {
  ROUTE_HEADER,
  conformanceRequest,
  conformanceTarget,
  createSideEffectRecorder,
  recordInventory,
  recordOnlyRequest,
  recordOnlyTarget,
} from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from './pglite';
import { v1 } from '../routes/v1';
import oauth from '../routes/oauth';
import { licenceMiddleware } from '../middleware/licence';
import { errorHandler } from '../middleware/error-handler';
import type { ApiKeySession, Env, HonoEnv } from '../types';
import type { Database } from '../db';

export interface CreateExternalTestAppOptions {
  /** Scopes the stub session grants. Default `['*']` (all scopes). */
  scopes?: string[];
  /**
   * Full session override. Pass `null` to set NO `apiSession` (so
   * `requireScope` short-circuits to 401). When omitted, a default
   * workspace-key session is built from `scopes`.
   */
  session?: ApiKeySession | null;
  /** Tenant Drizzle client. Defaults to a throwing mock (fine for 401/403 tests). */
  tenantDb?: Database;
  /** Override individual env bindings. */
  env?: Partial<Env>;
  /**
   * The master database (a `createMasterPgliteDb()` one), for routes that read
   * or write it. Conformance mode serves it to the Rust server; the test still
   * mocks the route's own master connection to hand it out.
   */
  masterDb?: Database;
}

const defaultSession = (scopes: string[]): ApiKeySession => ({
  keyId: 'key_test',
  // Personal key: routes that need an actor (e.g. activities.assignedToId,
  // articles.authorId) fall back to `userId`. These ids are master-DB user
  // ids stored as plain varchars, so no tenant FK is violated.
  keyType: 'personal',
  workspaceId: 'ws_test',
  userId: 'user_test',
  scopes,
  tier: 'enterprise',
  databaseUrl: null,
  licensedApps: null,
});

/** Minimal env — only `publishEntityEvent` reads `c.env`, and only the queue
 *  bindings, which are intentionally absent so events no-op. */
const passingRateLimit = { limit: () => Promise.resolve({ success: true }) };

const defaultEnv = (): Env =>
  ({
    HYPERDRIVE_MASTER: {},
    API_CACHE: {},
    RL_FREE: passingRateLimit,
    RL_BUSINESS: passingRateLimit,
    RL_SCALE: passingRateLimit,
    RL_ENTERPRISE: passingRateLimit,
    ENVIRONMENT: 'test',
    NEON_API_KEY: 'test',
  }) as unknown as Env;

/** Chainable Drizzle-shaped proxy that throws if a query is actually awaited.
 *  Used as the default `tenantDb` for tests that never touch the DB. */
function throwingDb(): Database {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (_res: unknown, rej: (e: Error) => void) =>
            rej(new Error('Test used tenantDb without providing one. Pass `tenantDb` to createExternalTestApp.'));
        }
        return () => chain;
      },
    },
  );
  return chain as unknown as Database;
}

/**
 * The `/v1/<object>` groups the Rust backend serves (`rust/modules/external-api`,
 * the `external-api` conformance suite). With `CONFORMANCE_TARGET=rust`, a
 * request to one of them runs on both backends and the answers are compared;
 * a request to any other group still runs on TypeScript alone, until its group
 * is ported. `''` is `GET /v1` itself, `health` is `/v1/health/db`.
 */
export const RUST_V1_SEGMENTS: ReadonlySet<string> = new Set(['', 'health', 'oauth', 'app-storage', 'user-apps', 'settings']);

/** The `/v1/<object>` segment a test path addresses, or null outside `/v1`. */
function v1Segment(input: string): string | null {
  const path = /^https?:\/\//.test(input) ? new URL(input).pathname : input;
  const match = /^\/v1(?:\/([^/?#]*))?(?:[/?#]|$)/.exec(path);
  return match ? (match[1] ?? '') : null;
}

/** Whether the Rust backend serves the group `input` addresses. */
export function servedByRust(input: string): boolean {
  const segment = v1Segment(input);
  return segment !== null && RUST_V1_SEGMENTS.has(segment);
}

export function createExternalTestApp(options: CreateExternalTestAppOptions = {}) {
  const scopes = options.scopes ?? ['*'];
  const session =
    options.session === null ? null : options.session ?? defaultSession(scopes);
  const tenantDb = options.tenantDb ?? throwingDb();
  // Conformance (`CONFORMANCE_TARGET=rust`) or coverage (record-only) mode.
  const target = conformanceTarget();
  const recorder = target ? null : recordOnlyTarget();
  const sideEffects = target ? createSideEffectRecorder() : null;
  const env: Env = { ...defaultEnv(), ...(sideEffects?.bindings ?? {}), ...options.env } as Env;
  // A test's own REALTIME / ENTITY_EVENTS binding keeps working, recorded too.
  const own = options.env as Record<string, unknown> | undefined;
  const ownRealtime = own?.REALTIME as { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } | undefined;
  if (sideEffects && ownRealtime && typeof ownRealtime.fetch === 'function') {
    (env as unknown as Record<string, unknown>).REALTIME = sideEffects.wrapRealtime(ownRealtime);
  }
  const ownEvents = own?.ENTITY_EVENTS as Parameters<NonNullable<typeof sideEffects>['wrapEvents']>[0] | undefined;
  if (sideEffects && ownEvents && (typeof ownEvents.send === 'function' || typeof ownEvents.sendBatch === 'function')) {
    (env as unknown as Record<string, unknown>).ENTITY_EVENTS = sideEffects.wrapEvents(ownEvents);
  }
  const reporting = target ?? recorder;

  const buildApp = (db: Database) => {
    const stub = createMiddleware<HonoEnv>(async (c, next) => {
      if (session) {
        c.set('apiSession', session);
        c.set('workspaceId', session.workspaceId);
        if (session.clerkOrgId) c.set('clerkOrgId', session.clerkOrgId);
        c.set('userId', session.userId ?? session.keyId);
        c.set('tenantDb', db);
      }
      await next();
      // The route that answered, for the conformance report.
      if (reporting) {
        const endpoint = matchedRoutes(c)[c.req.routeIndex];
        if (endpoint && endpoint.method !== 'ALL') c.res.headers.set(ROUTE_HEADER, endpoint.path);
      }
    });

    const built = new Hono<HonoEnv>();
    // The worker's own error answers (src/index.ts), as the Rust server gives them.
    built.onError(errorHandler);
    built.notFound((c) =>
      c.json({ error: { code: 'NOT_FOUND', message: 'The requested endpoint does not exist' } }, 404),
    );
    built.use('*', stub);
    // Mounted ahead of the key layers, as in src/index.ts: the client
    // credentials are its authentication.
    built.route('/v1/oauth', oauth);
    // The real licence gate: it only reads the session, so it needs no bindings.
    built.use('/v1/*', licenceMiddleware);
    built.route('/v1', v1);
    return built;
  };
  const app = buildApp(tenantDb);

  // `publishEntityEvent` hands its send to `waitUntil`; the recorder waits for it.
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => {
      if (typeof promise?.catch === 'function') promise.catch(() => {});
      if (sideEffects && promise) sideEffects.track(promise);
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;

  // Conformance compares only the groups Rust serves; coverage lists them all.
  let inventory: Promise<void> = Promise.resolve();
  if (target) inventory = recordInventory(target, app.routes.filter((route) => servedByRust(route.path)));
  else if (recorder) inventory = recordInventory(recorder, app.routes);
  const runHere = (input: string, init?: RequestInit) =>
    Promise.resolve(
      reporting
        ? app.request(input, init, env as unknown as Record<string, unknown>, executionCtx)
        : app.request(input, init, env as unknown as Record<string, unknown>),
    );

  return {
    app,
    env,
    session,
    tenantDb,
    /** `app.request()` with the (binding-less) test env injected. */
    request: async (input: string, init?: RequestInit): Promise<Response> => {
      if (target && servedByRust(input)) {
        await inventory;
        // Rust reads a real database: a test that gave none (it only checks
        // refusals) gets the shared pglite, which its routes never reach.
        const db = options.tenantDb ?? (await createPgliteDb()).db;
        return conformanceRequest({
          target,
          ctx: {
            userId: session ? (session.userId ?? session.keyId) : '',
            orgId: session?.clerkOrgId ?? null,
            workspaceId: session?.workspaceId ?? 'ws_test',
            clerkOrgId: session?.clerkOrgId ?? null,
            sessionId: '',
            tenantDb: db,
            masterDb: options.masterDb,
          },
          env: env as unknown as Record<string, unknown>,
          input,
          init,
          runTypeScript: async (runDb, path, requestInit, runEnv) =>
            buildApp(runDb).request(path, requestInit, runEnv ?? (env as unknown as Record<string, unknown>), executionCtx),
          sideEffects: sideEffects!,
          // The key's session, as the Rust server's `/v1` conformance layer reads it.
          context: { apiSession: session },
        });
      }
      if (recorder) {
        await inventory;
        return recordOnlyRequest(recorder, init?.method ?? 'GET', input, () => runHere(input, init));
      }
      return runHere(input, init);
    },
  };
}
