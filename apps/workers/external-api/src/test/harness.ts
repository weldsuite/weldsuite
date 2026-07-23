/**
 * Test harness for external-api route tests.
 *
 * `createExternalTestApp(options)` builds a fresh Hono app, injects a stub
 * that sets the same context variables the real auth + tenant-db middleware
 * would (`apiSession`, `tenantDb`, `workspaceId`, `userId`), then mounts the
 * real `v1` router under `/v1`. The real `authMiddleware` /
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
 * Mirrors apps/workers/app-api/src/test/harness.ts.
 */

import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { v1 } from '../routes/v1';
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
  hasApiAccess: true,
  databaseUrl: null,
});

/** Minimal env — only `publishEntityEvent` reads `c.env`, and only the queue
 *  bindings, which are intentionally absent so events no-op. */
const passingRateLimit = { limit: async () => ({ success: true }) };

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

export function createExternalTestApp(options: CreateExternalTestAppOptions = {}) {
  const scopes = options.scopes ?? ['*'];
  const session =
    options.session === null ? null : options.session ?? defaultSession(scopes);
  const tenantDb = options.tenantDb ?? throwingDb();
  const env: Env = { ...defaultEnv(), ...options.env };

  const stub = createMiddleware<HonoEnv>(async (c, next) => {
    if (session) {
      c.set('apiSession', session);
      c.set('workspaceId', session.workspaceId);
      c.set('userId', session.userId ?? session.keyId);
      c.set('tenantDb', tenantDb);
    }
    await next();
  });

  const app = new Hono<HonoEnv>();
  app.use('*', stub);
  app.route('/v1', v1);

  return {
    app,
    env,
    session,
    tenantDb,
    /** `app.request()` with the (binding-less) test env injected. */
    request: (input: string, init?: RequestInit) =>
      app.request(input, init, env as unknown as Record<string, unknown>),
  };
}
