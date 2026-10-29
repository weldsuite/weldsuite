/**
 * Test harness for API worker unit + integration tests.
 *
 * 1. `createTestApp(routePath, routes, ctx?)` builds a Hono app with a stub
 *    auth middleware that injects fake `userId`/`orgId`/`tenantDb`/
 *    `workspaceId` into the context, then mounts the routes under test.
 *    Exercise endpoints with `request()`. No Clerk JWT is needed.
 *
 * 2. `createMockDb(overrides)` returns a `Database`-shaped object whose
 *    query-builder methods can be stubbed per test. Use this for service
 *    unit tests when you don't need a real PostgreSQL.
 */

import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { matchedRoutes } from 'hono/route';
import { initPermissionMiddleware } from '@weldsuite/permissions/server';
import type { ResolvedPermissions } from '@weldsuite/permissions/types';
import type { Database, KitEnv, KitVariables } from '../env';
import {
  ROUTE_HEADER,
  conformanceRequest,
  conformanceTarget,
  createSideEffectRecorder,
  recordInventory,
  recordOnlyRequest,
  recordOnlyTarget,
} from './conformance';

// One-time init: the `requirePermission` middleware throws if its DB
// query factory was never registered. Tests pre-cache `userPermissions`
// on the context (see `createTestApp`), so the factory is never actually
// invoked — we just need to satisfy the init guard.
let permissionsInitialized = false;
function ensurePermissionsInit() {
  if (permissionsInitialized) return;
  initPermissionMiddleware({
    createQueries: () => {
      throw new Error(
        'Test harness: requirePermission tried to query the DB. Cache `userPermissions` via `context.permissions` to bypass.',
      );
    },
  });
  permissionsInitialized = true;
}

export interface TestContext {
  userId: string;
  orgId: string | null;
  /** `workspaces.id` of the workspace; defaults to `ws_test_default`. */
  workspaceId: string;
  /** Clerk org id of the workspace; defaults to `orgId` (`org_test_default`). */
  clerkOrgId?: string | null;
  sessionId: string;
  /** Clerk's `fva` claim; defaults to both factors just verified, so `requireSecondFactor` passes. */
  factorVerificationAge?: readonly [number, number] | null;
  tenantDb: Database;
  /**
   * Pre-resolved permissions cached on the context. When set, the
   * `requirePermission` middleware short-circuits its DB query and uses
   * this value directly. Use `permissions('*')` to grant everything.
   */
  permissions?: ResolvedPermissions;
  /**
   * Pre-resolved feature-flag evaluator cached on the context, mirroring
   * what `featureFlagsMiddleware` sets via `c.get('flags')`. Inject a stub
   * (e.g. `{ isOn: async () => true }`) to test flag-gated routes without a
   * real Flagship binding. Left unset → `c.get('flags')` is undefined, which
   * is exactly the binding-less local-dev fallback.
   */
  flags?: KitVariables['flags'];
}

export interface CreateTestAppOptions<E extends KitEnv = KitEnv> {
  /** Override individual context values (userId, orgId, …). */
  context?: Partial<TestContext>;
  /** Override individual env bindings. */
  env?: Partial<E>;
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
  workspaceId: 'ws_test_default',
  sessionId: 'sess_test_default',
  factorVerificationAge: [0, 0],
  tenantDb: createMockDb(),
});

const defaultEnv = (): KitEnv => ({
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
 *
 * With `CONFORMANCE_TARGET=rust`, `request()` runs on the Rust backend and is
 * compared with this app (./conformance.ts).
 */
export function createTestApp<E extends KitEnv, V extends KitVariables>(
  basePath: string,
  router: Hono<{ Bindings: E; Variables: V }>,
  options: CreateTestAppOptions<E> = {},
) {
  ensurePermissionsInit();
  const ctx: TestContext = { ...defaultContext(), ...options.context };
  const target = conformanceTarget();
  const recorder = target ? null : recordOnlyTarget();
  // Conformance mode records what the app sends to the queue and realtime.
  const sideEffects = target ? createSideEffectRecorder() : null;
  const env = {
    ...defaultEnv(),
    ...(sideEffects?.bindings ?? {}),
    ...options.env,
  } as E;

  const buildApp = (tenantDb: Database) => {
    const stubAuth = createMiddleware<{ Bindings: E; Variables: V }>(async (c, next) => {
      const set = c.set as (key: string, value: unknown) => void;
      set('requestId', 'req_test');
      set('userId', ctx.userId);
      set('orgId', ctx.orgId);
      set('sessionId', ctx.sessionId);
      set('factorVerificationAge', ctx.factorVerificationAge);
      set('tenantDb', tenantDb);
      set('workspaceId', ctx.workspaceId);
      set('clerkOrgId', ctx.clerkOrgId === undefined ? ctx.orgId : ctx.clerkOrgId);
      // Cache the pre-resolved permissions so `requirePermission` bypasses its
      // DB query entirely.
      if (ctx.permissions) set('userPermissions', ctx.permissions);
      // Mirror featureFlagsMiddleware so flag-gated routes can be tested.
      if (ctx.flags) set('flags', ctx.flags);
      await next();
      // Conformance mode reports which route answered: the last matched
      // handler that isn't a middleware.
      if (target || recorder) {
        const endpoint = matchedRoutes(c)
          .filter((r) => r.method !== 'ALL')
          .at(-1);
        if (endpoint) c.res.headers.set(ROUTE_HEADER, endpoint.path);
      }
    });

    const built = new Hono<{ Bindings: E; Variables: V }>();
    built.use('*', stubAuth);
    built.route(basePath, router);
    return built;
  };
  const app = buildApp(ctx.tenantDb);
  // Recorded before the first request goes out, so the report has the routes.
  const reporting = target ?? recorder;
  const inventory = reporting ? recordInventory(reporting, app.routes) : Promise.resolve();
  const runHere = (input: string, init?: RequestInit) =>
    Promise.resolve(app.request(input, init, env as unknown as Record<string, unknown>, executionCtx));

  // Routes fire side effects (entity events, webhook fan-out, calendar sync)
  // through `c.executionCtx.waitUntil(...)`. Outside the Workers runtime that
  // getter throws "This context has no ExecutionContext", which would 500 every
  // mutation. Supply a mock: run each task fire-and-forget and swallow
  // rejections so a missing binding never surfaces as an unhandled rejection.
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => {
      if (typeof promise?.catch === 'function') promise.catch(() => {});
      if (sideEffects && promise) sideEffects.track(promise);
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
    request: (input: string, init?: RequestInit): Promise<Response> =>
      target
        ? inventory.then(() => conformanceRequest({
            target,
            ctx: { ...ctx, clerkOrgId: ctx.clerkOrgId === undefined ? ctx.orgId : ctx.clerkOrgId },
            env: env as unknown as Record<string, unknown>,
            input,
            init,
            runTypeScript: async (tenantDb, path, requestInit) =>
              buildApp(tenantDb).request(path, requestInit, env as unknown as Record<string, unknown>, executionCtx),
            sideEffects: sideEffects!,
          }))
        : recorder
          ? inventory.then(() => recordOnlyRequest(recorder, init?.method ?? 'GET', input, () => runHere(input, init)))
          : runHere(input, init),
  };
}

/**
 * Minimal Drizzle-shaped mock. Each chainable builder method (`select`,
 * `from`, `where`, `limit`, etc.) returns the same proxy so tests can
 * assert call shapes without hitting a database. Override individual
 * methods via the `overrides` argument.
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
