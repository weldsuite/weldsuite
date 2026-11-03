/**
 * Test harness for the worker's public routes, with the conformance suite.
 *
 * `createWebhookTestApp(options)` sends a request through the worker's own
 * `fetch` (the full Hono app of src/index.ts), with the test's env and an
 * `executionCtx` whose `waitUntil` work is awaited before the answer is
 * returned (so a test sees what a receiver forwarded in the background).
 *
 * With `CONFORMANCE_TARGET=rust` a request to a route the Rust server serves
 * (`RUST_ROUTES`, `rust/modules/integrations`) runs on both backends and the
 * answers are compared; any other route still runs on TypeScript alone. The
 * worker has no module id, so its suites name their own (`integrations`)
 * and the runner reports the routes no test reached. In record-only mode
 * (coverage) every route is listed.
 *
 * The worker's master database is `getMasterDb(env)`: a test that reaches
 * it mocks `../db` to hand out `conformanceMasterDb(masterDb)` and passes
 * the same `masterDb` here.
 */

import {
  ROUTE_HEADER,
  conformanceRequest,
  conformanceTarget,
  createSideEffectRecorder,
  recordInventory,
  recordOnlyRequest,
  recordOnlyTarget,
} from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import worker, { type Env } from '../index';

/** Every route the worker serves (src/index.ts and the routers it mounts). */
export const WORKER_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'POST', path: '/webhooks/github' },
  { method: 'POST', path: '/webhooks/bank-feeds/:provider' },
  { method: 'POST', path: '/webhooks/woocommerce/auth' },
  { method: 'POST', path: '/webhooks/connectors/:connectionId' },
  { method: 'POST', path: '/webhooks/stripe-connect' },
  { method: 'GET', path: '/webhooks/meta/ads' },
  { method: 'POST', path: '/webhooks/meta/ads' },
  { method: 'GET', path: '/robots.txt' },
  { method: 'GET', path: '/health' },
  { method: 'POST', path: '/integration-webhook/slack' },
  { method: 'POST', path: '/integration-webhook/twilio/:connectionId' },
  { method: 'POST', path: '/integration-webhook/github/:connectionId' },
  { method: 'POST', path: '/webhook/hubspot' },
  { method: 'POST', path: '/webhook/gcal/:connectionId' },
  { method: 'POST', path: '/webhook/:connectionId' },
];

/** The routes the Rust server serves, as `METHOD path`. */
export const RUST_ROUTES: ReadonlySet<string> = new Set([
  'POST /webhooks/bank-feeds/:provider',
  'POST /webhooks/github',
  'POST /webhook/hubspot',
  'POST /webhook/gcal/:connectionId',
  'POST /webhook/:connectionId',
  'GET /webhooks/meta/ads',
  'POST /webhooks/meta/ads',
  'POST /webhooks/connectors/:connectionId',
  'POST /webhooks/stripe-connect',
  'POST /integration-webhook/slack',
  'POST /integration-webhook/twilio/:connectionId',
  'POST /integration-webhook/github/:connectionId',
]);

function pathOf(input: string): string {
  return /^https?:\/\//.test(input) ? new URL(input).pathname : (input.split('?')[0] ?? input);
}

/** The registered route a request lands on, in Hono's order (first match). */
export function routeFor(method: string, input: string): string | null {
  const segments = pathOf(input).split('/');
  for (const route of WORKER_ROUTES) {
    if (route.method !== method.toUpperCase()) continue;
    const pattern = route.path.split('/');
    if (pattern.length !== segments.length) continue;
    if (pattern.every((part, i) => part.startsWith(':') ? (segments[i] ?? '') !== '' : part === segments[i])) {
      return route.path;
    }
  }
  return null;
}

function servedByRust(method: string, input: string): boolean {
  const route = routeFor(method, input);
  return route !== null && RUST_ROUTES.has(`${method.toUpperCase()} ${route}`);
}

export interface CreateWebhookTestAppOptions {
  /** The worker's env (bindings and secrets; test doubles need only what the routes call). */
  env?: Record<string, unknown>;
  /** The master database (`createMasterPgliteDb()`), for routes that read it. */
  masterDb?: unknown;
  /**
   * The tenant database every workspace opens (`createPgliteDb()`); the test
   * mocks `getTenantDbForWorkspace` to hand out `conformanceTenantDb(tenantDb)`.
   */
  tenantDb?: unknown;
}

export function createWebhookTestApp(options: CreateWebhookTestAppOptions = {}) {
  const target = conformanceTarget();
  const recorder = target ? null : recordOnlyTarget();
  const sideEffects = target ? createSideEffectRecorder() : null;
  const env = { ENVIRONMENT: 'test', ...(sideEffects?.bindings ?? {}), ...options.env } as unknown as Record<
    string,
    unknown
  >;

  // `waitUntil` work: tracked for the conformance comparison, and awaited
  // before a plain run answers.
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
    const url = /^https?:\/\//.test(input) ? input : `http://localhost${input}`;
    pending = [];
    const response = await worker.fetch!(new Request(url, init) as never, runEnv as unknown as Env, executionCtx);
    await Promise.allSettled(pending);
    const route = routeFor(init?.method ?? 'GET', input);
    if (!route || !(target ?? recorder)) return response;
    // The route that answered, for the conformance report.
    const headers = new Headers(response.headers);
    headers.set(ROUTE_HEADER, route);
    return new Response(response.body, { status: response.status, headers });
  };

  let inventory: Promise<void> = Promise.resolve();
  if (target) inventory = recordInventory(target, WORKER_ROUTES.filter((r) => RUST_ROUTES.has(`${r.method} ${r.path}`)));
  else if (recorder) inventory = recordInventory(recorder, WORKER_ROUTES);

  return {
    env,
    request: async (input: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (target && servedByRust(method, input)) {
        await inventory;
        const tenantDb = options.tenantDb ?? (await createPgliteDb()).db;
        return conformanceRequest({
          target,
          ctx: {
            userId: '',
            orgId: null,
            workspaceId: 'ws_test',
            clerkOrgId: null,
            sessionId: '',
            tenantDb: tenantDb as never,
            masterDb: options.masterDb as never,
          },
          env,
          input,
          init,
          runTypeScript: async (_db, path, requestInit, runEnv) => runHere(path, requestInit, runEnv ?? env),
          sideEffects: sideEffects!,
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
