/**
 * Test harness for personal-api's routes, with the conformance suite.
 *
 * `createPersonalTestApp(options)` sends a request through the worker's own
 * Hono app (src/index.ts, every middleware included: CORS, the Clerk session
 * check, the personal account lookup), with the test's env and an
 * `executionCtx` whose `waitUntil` work is awaited before the answer is
 * returned. Sessions are real RS256 tokens ({@link sessionToken}) checked
 * against `CLERK_JWT_KEY`, as `clerkMiddleware()` checks them, so the
 * authorized-party rule and the entitlement claims are exercised too.
 *
 * Databases: personal-api reads the master database (`personal_accounts`,
 * the address registry) and the shared personal database (ADR DATA-011). A
 * test mocks `../db` so `getMasterDb` hands out
 * `conformanceMasterDb(masterDb)` and `getPersonalDb`
 * `conformanceTenantDb(personalDb)`, and passes the same handles here.
 *
 * With `CONFORMANCE_TARGET=rust` every request runs on both backends and the
 * answers are compared. The worker has no API module id, so its suites name
 * their own (`personal`); on Kubernetes one host serves every path, and the
 * worker's `/api/...` paths collide with app-api's and calendar-api's, so the
 * Rust server serves personal-api under {@link RUST_BASE_PATH}. The personal
 * database travels in the context's tenant slot (personal-api has no
 * tenant). In record-only mode (coverage) every route is listed.
 */

import { createSign, generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';
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
import worker from '../index';

/** Where the Rust server serves personal-api (`rust/modules/personal`). */
export const RUST_BASE_PATH = '/personal-api';

/**
 * Routes the Rust server leaves out on purpose (the suites' `excludedRoutes`):
 * free `@weldmail.com` addresses belong to Global (ADR MAIL-010).
 */
export const NOT_ON_RUST: ReadonlySet<string> = new Set([
  'GET /api/mail/weldmail/domain',
  'POST /api/mail/weldmail/check',
  'POST /api/mail/weldmail/reserve',
]);

// One signing key per test file: the token the test signs is checked by
// both backends against the same `CLERK_JWT_KEY`.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: strangerKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const CLERK_PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/**
 * A Clerk session token for `user_personal` (override with `sub`), valid for
 * a minute, signed with this file's key (or another one with
 * `{ foreignKey: true }`).
 */
export function sessionToken(claims: Record<string, unknown> = {}, options: { foreignKey?: boolean } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'ins_personal' }));
  const body = b64url(
    JSON.stringify({ sub: 'user_personal', sid: 'sess_personal', iat: now - 5, nbf: now - 5, exp: now + 120, ...claims }),
  );
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${body}`)
    .sign(options.foreignKey ? strangerKey : privateKey);
  return `${header}.${body}.${b64url(signature)}`;
}

/** `Authorization` and JSON headers for a request as `sub` (default `user_personal`). */
export function authHeaders(claims: Record<string, unknown> = {}): Record<string, string> {
  return { Authorization: `Bearer ${sessionToken(claims)}`, 'Content-Type': 'application/json' };
}

function pathOf(input: string): string {
  return /^https?:\/\//.test(input) ? new URL(input).pathname : (input.split('?')[0] ?? input);
}

/** The weldmail address routes stay on TypeScript alone. */
function servedByRust(input: string): boolean {
  return !pathOf(input).startsWith('/api/mail/weldmail');
}

export interface CreatePersonalTestAppOptions {
  /** The worker's env on top of the defaults (bindings and secrets the routes call). */
  env?: Record<string, unknown>;
  /** The master database (`createMasterPgliteDb()`). */
  masterDb: unknown;
  /** The shared personal database (`createPersonalPgliteDb()`). */
  personalDb: unknown;
}

export function createPersonalTestApp(options: CreatePersonalTestAppOptions) {
  const target = conformanceTarget();
  const recorder = target ? null : recordOnlyTarget();
  const sideEffects = target ? createSideEffectRecorder() : null;
  const env = {
    ENVIRONMENT: 'test',
    CLERK_SECRET_KEY: 'sk_test_personal',
    CLERK_JWT_KEY: CLERK_PUBLIC_PEM,
    DATABASE_URL_MASTER: 'postgres://master.invalid/master',
    DATABASE_URL_PERSONAL: 'postgres://personal.invalid/personal',
    ...(sideEffects?.bindings ?? {}),
    ...options.env,
  } as Record<string, unknown>;

  // The worker's app, behind a middleware that reports the route that
  // answered (the handler Hono ran last; an app-wide middleware is no route).
  const app = new Hono();
  app.use('*', async (c, next) => {
    await next();
    if (!target && !recorder) return;
    const endpoint = matchedRoutes(c)[c.req.routeIndex];
    if (endpoint && endpoint.method !== 'ALL') c.res.headers.set(ROUTE_HEADER, endpoint.path);
  });
  app.route('/', worker);
  const routes = app.routes
    .filter((route) => route.method !== 'ALL')
    .map((route) => ({ method: route.method, path: route.path }));

  // `waitUntil` work (the read push): tracked for the conformance comparison,
  // and awaited before a plain run answers.
  let pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => {
      if (typeof promise?.catch === 'function') promise.catch(() => {});
      pending.push(promise);
      if (sideEffects && promise) sideEffects.track(promise);
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;

  const runHere = async (input: string, init: RequestInit | undefined, runEnv: Record<string, unknown>) => {
    pending = [];
    const response = await app.request(input, init, runEnv, executionCtx);
    await Promise.allSettled(pending);
    return response;
  };

  let inventory: Promise<void> = Promise.resolve();
  if (target) {
    inventory = recordInventory(
      target,
      routes.filter((route) => !NOT_ON_RUST.has(`${route.method} ${route.path}`)),
    );
  } else if (recorder) {
    inventory = recordInventory(recorder, routes);
  }

  return {
    env,
    routes,
    request: async (input: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (target && servedByRust(input)) {
        await inventory;
        return conformanceRequest({
          target,
          ctx: {
            userId: '',
            orgId: null,
            workspaceId: '',
            clerkOrgId: null,
            sessionId: '',
            tenantDb: options.personalDb as never,
            masterDb: options.masterDb as never,
          },
          env,
          input,
          init,
          runTypeScript: async (_db, path, requestInit, runEnv) => runHere(path, requestInit, runEnv ?? env),
          sideEffects: sideEffects!,
          rustBasePath: RUST_BASE_PATH,
        });
      }
      if (recorder) {
        await inventory;
        return recordOnlyRequest(recorder, method, input, () => runHere(input, init, env));
      }
      return runHere(input, init, env);
    },
  };
}
