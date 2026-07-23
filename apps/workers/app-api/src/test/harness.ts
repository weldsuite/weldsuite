/**
 * Test harness for app-api unit + integration tests.
 *
 * Two flavours are provided:
 *
 * 1. `createTestApp(routePath, routes, ctx?)` — builds a Hono app with a
 *    stub auth middleware that injects fake `userId`/`orgId`/`tenantDb`/
 *    `workspaceId` into the context, then mounts the routes under test.
 *    Exercise endpoints with `app.request()`. No Clerk JWT is needed.
 *
 * 2. `createMockDb(overrides)` — returns a `Database`-shaped object whose
 *    query-builder methods can be stubbed per test. Use this for service
 *    unit tests when you don't need a real PostgreSQL.
 *
 * For true integration tests against PostgreSQL (covering Drizzle joins,
 * indexes, constraints) we'll later layer pglite or vitest-pool-workers
 * on top of this harness — the public surface (`request`, `ctx`) won't
 * change.
 */

import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { initPermissionMiddleware } from '@weldsuite/permissions/server';
import type { Database } from '../db';
import type { Env, Variables } from '../types';
import type { ResolvedPermissions } from '@weldsuite/permissions/types';

// One-time init: the `requirePermission` middleware throws if its DB
// query factory was never registered. Tests pre-cache `userPermissions`
// on the context (see `createTestApp`), so the factory is never actually
// invoked — we just need to satisfy the init guard.
let _permissionsInitialized = false;
function ensurePermissionsInit() {
  if (_permissionsInitialized) return;
  initPermissionMiddleware({
    createQueries: () => {
      throw new Error(
        'Test harness: requirePermission tried to query the DB. Cache `userPermissions` via `context.permissions` to bypass.',
      );
    },
  });
  _permissionsInitialized = true;
}

export interface TestContext {
  userId: string;
  orgId: string | null;
  workspaceId: string;
  sessionId: string;
  tenantDb: Database;
  /**
   * Pre-resolved permissions cached on the context. When set, the
   * `requirePermission` middleware short-circuits its DB query and uses
   * this value directly. Use `permissions: ['*']` to grant everything.
   */
  permissions?: ResolvedPermissions;
  /**
   * Pre-resolved feature-flag evaluator cached on the context, mirroring
   * what `featureFlagsMiddleware` sets via `c.get('flags')`. Inject a stub
   * (e.g. `{ isOn: async () => true }`) to test flag-gated routes without a
   * real Flagship binding. Left unset → `c.get('flags')` is undefined, which
   * is exactly the binding-less local-dev fallback.
   */
  flags?: Variables['flags'];
}

export interface CreateTestAppOptions {
  /** Override individual context values (userId, orgId, …). */
  context?: Partial<TestContext>;
  /** Override individual env bindings. */
  env?: Partial<Env>;
}

/**
 * Build a `ResolvedPermissions` for tests. Pass permission keys
 * (`'companies:read', 'companies:create'`) or the wildcard `'*'` for
 * an admin-equivalent user.
 */
export function permissions(...keys: string[]): ResolvedPermissions {
  return {
    permissions: keys.includes('*') ? ['*'] : keys,
    role: keys.includes('*') ? 'admin' : 'member',
    roleId: null,
    isOwner: keys.includes('*'),
  };
}

const defaultContext = (): TestContext => ({
  userId: 'user_test_default',
  orgId: 'org_test_default',
  workspaceId: 'org_test_default',
  sessionId: 'sess_test_default',
  tenantDb: createMockDb(),
});

const defaultEnv = (): Env => ({
  DATABASE_URL_MASTER: 'postgres://test',
  WORKSPACE_CACHE: {} as KVNamespace,
  ENVIRONMENT: 'test',
  CLERK_SECRET_KEY: 'test',
  NEON_API_KEY: 'test',
});

/**
 * Build a fresh Hono app, mount one router under `basePath`, and return
 * helpers for issuing requests. Tests should treat the returned `app` as
 * disposable — create a new one per test for full isolation.
 */
export function createTestApp(
  basePath: string,
  router: Hono<{ Bindings: Env; Variables: Variables }>,
  options: CreateTestAppOptions = {},
) {
  ensurePermissionsInit();
  const ctx: TestContext = { ...defaultContext(), ...options.context };
  const env: Env = { ...defaultEnv(), ...options.env };

  const stubAuth = createMiddleware<{ Bindings: Env; Variables: Variables }>(
    async (c, next) => {
      c.set('requestId', 'req_test');
      c.set('userId', ctx.userId);
      c.set('orgId', ctx.orgId);
      c.set('sessionId', ctx.sessionId);
      c.set('tenantDb', ctx.tenantDb);
      c.set('workspaceId', ctx.workspaceId);
      if (ctx.permissions) {
        // Cache the pre-resolved permissions so `requirePermission`
        // bypasses its DB query entirely.
        c.set('userPermissions', ctx.permissions);
      }
      if (ctx.flags) {
        // Mirror featureFlagsMiddleware so flag-gated routes can be tested.
        c.set('flags', ctx.flags);
      }
      await next();
    },
  );

  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', stubAuth);
  app.route(basePath, router);

  // Routes fire side effects (entity events, webhook fan-out, calendar sync)
  // through `c.executionCtx.waitUntil(...)`. Outside the Workers runtime that
  // getter throws "This context has no ExecutionContext", which would 500 every
  // mutation. Supply a mock: run each task fire-and-forget and swallow
  // rejections so a missing binding never surfaces as an unhandled rejection.
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => {
      if (promise && typeof promise.catch === 'function') promise.catch(() => {});
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;

  return {
    app,
    ctx,
    env,
    executionCtx,
    /** Convenience wrapper around `app.request()` that injects env + executionCtx. */
    request: (input: string, init?: RequestInit) =>
      app.request(input, init, env as unknown as Record<string, unknown>, executionCtx),
  };
}

/**
 * Minimal Drizzle-shaped mock. Each chainable builder method (`select`,
 * `from`, `where`, `limit`, etc.) returns the same proxy so tests can
 * assert call shapes without hitting a database. Override individual
 * methods via the `overrides` argument.
 *
 * Designed for service unit tests where you only need to assert the
 * service called the right query shape, or where the service is a pure
 * function that doesn't touch the db at all.
 */
export function createMockDb(overrides: Partial<Database> = {}): Database {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'then') return undefined;
        return () => chain;
      },
    },
  );

  return new Proxy(chain, {
    get(_target, prop: string) {
      if (prop in overrides) {
        return (overrides as Record<string, unknown>)[prop];
      }
      return () => chain;
    },
  }) as unknown as Database;
}
