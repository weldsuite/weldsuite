/**
 * Shared configuration for the k6 pressure tests: target hosts, the
 * production guard, load profiles and pass/fail thresholds.
 *
 * Everything is read from environment variables (k6 exposes them as
 * `__ENV`); `run.mjs` loads them from `scripts/load-test/.env`. The hosts
 * and the production rule live in `targets.mjs`, which the runner shares.
 */

import { describeTarget, envOf, platformBase, productionRefusal, publicBase, targetOf } from './targets.mjs';

export const WELD_ENV = envOf(__ENV);
/** `global` (Cloudflare Workers + Clerk) or `eu` (the Rust server + WeldID). */
export const WELD_TARGET = targetOf(__ENV);
export const IS_EU = WELD_TARGET === 'eu';
export const TARGET_LABEL = describeTarget(__ENV);
export const PROFILE = (__ENV.PROFILE || 'smoke').toLowerCase();
export const RUN_ID = __ENV.RUN_ID || String(Date.now());
export const SCALE = Number(__ENV.SCALE || 1);
/** Share of iterations that run a write flow (create → update → delete). */
export const WRITE_RATIO = clamp(Number(__ENV.WRITE_RATIO ?? 0.2), 0, 1);
/** Marker on every record the test creates; `cleanup` deletes by it. */
export const MARKER = 'loadtest';

/**
 * Host for a first-party module (`crm`, `desk`, `flow`, `stash`, `app`).
 * Global: the module's worker (crm-api-test.weldsuite.org), as the platform
 * SPA calls it, or app-api's forwarder with VIA_APP_API=1. EU: the one
 * server (api.test.weldsuite.eu) for every module. BASE_URL pins one host.
 */
export function platformHost(module) {
  return platformBase(__ENV, module);
}

/** Public API base; the scenario adds `/v1/…`. On EU the same host as the platform's. */
export function publicApiHost() {
  return publicBase(__ENV);
}

/** A comma-separated setting as a list. */
export function listOf(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** This VU's entry of a list: VUs spread evenly over it (setup takes the first). */
export function forThisVu(list) {
  if (list.length === 0) return undefined;
  const vu = typeof __VU === 'number' && __VU > 0 ? __VU - 1 : 0;
  return list[vu % list.length];
}

/**
 * EU: the test workspaces (WELD_WORKSPACE, `ws_…` ids or slugs, comma
 * separated). Each server pod holds one connection per workspace database
 * (the chart's tenantPoolMaxConnections), so one workspace measures what a
 * single busy workspace gets; several measure the cluster.
 */
export const WORKSPACES = listOf(__ENV.WELD_WORKSPACE);

/**
 * Headers that pick the workspace. EU runs WeldID in membership mode: the
 * token names no workspace, so every request names it in X-Weld-Workspace
 * (`workspaces.id`, or its slug), as the platform does
 * (apps/web/platform/lib/api/workspace-header.ts), and the server checks the
 * member belongs to it. Global takes the workspace from the Clerk session's
 * org claim instead.
 */
export function workspaceHeaders(workspace = forThisVu(WORKSPACES)) {
  return IS_EU && workspace ? { 'X-Weld-Workspace': workspace } : {};
}

/** Refuse to run against production unless explicitly allowed (targets.mjs). */
export function assertSafeTarget() {
  const refusal = productionRefusal(__ENV);
  if (refusal) throw new Error(refusal);
}

/** Seconds of "user think time" between iterations (VU-based profiles only). */
export function thinkTime() {
  if (PROFILE === 'breakpoint' || __ENV.THINK === '0') return 0;
  return 0.5 + random() * 1.5;
}

const scaled = (n) => Math.max(1, Math.round(n * SCALE));

/**
 * k6 scenario for the selected profile.
 *
 *   smoke      1 user for 30s: does everything work at all?
 *   load       50 users for 5 min: a normal busy day.
 *   stress     steps 50 → 100 → 200 → 400 users: where does it degrade?
 *   spike      10 → 500 users in 10s: a sudden rush.
 *   soak       50 users for 30 min (SOAK_DURATION): leaks and slow drift.
 *   breakpoint request rate climbs to 1000 iterations/s and the test stops
 *              itself once errors or latency cross the limit: the ceiling.
 *
 * SCALE multiplies every user count / rate (SCALE=0.2 for a gentle run).
 */
export function scenarioFor(exec) {
  const vus = (stages) => ({ executor: 'ramping-vus', startVUs: 0, stages, gracefulRampDown: '30s', exec });
  switch (PROFILE) {
    case 'smoke':
      return { executor: 'constant-vus', vus: 1, duration: __ENV.DURATION || '30s', exec };
    case 'load':
      return vus([
        { duration: '2m', target: scaled(50) },
        { duration: __ENV.DURATION || '5m', target: scaled(50) },
        { duration: '1m', target: 0 },
      ]);
    case 'stress':
      return vus([
        { duration: '2m', target: scaled(50) },
        { duration: '3m', target: scaled(50) },
        { duration: '2m', target: scaled(100) },
        { duration: '3m', target: scaled(100) },
        { duration: '2m', target: scaled(200) },
        { duration: '3m', target: scaled(200) },
        { duration: '2m', target: scaled(400) },
        { duration: '3m', target: scaled(400) },
        { duration: '2m', target: 0 },
      ]);
    case 'spike':
      return vus([
        { duration: '30s', target: scaled(10) },
        { duration: '10s', target: scaled(500) },
        { duration: '1m', target: scaled(500) },
        { duration: '10s', target: scaled(10) },
        { duration: '1m', target: scaled(10) },
        { duration: '10s', target: 0 },
      ]);
    case 'soak':
      return vus([
        { duration: '2m', target: scaled(50) },
        { duration: __ENV.SOAK_DURATION || __ENV.DURATION || '30m', target: scaled(50) },
        { duration: '1m', target: 0 },
      ]);
    case 'breakpoint':
      return {
        executor: 'ramping-arrival-rate',
        startRate: scaled(5),
        timeUnit: '1s',
        preAllocatedVUs: scaled(50),
        maxVUs: scaled(1000),
        stages: [{ duration: __ENV.DURATION || '15m', target: scaled(1000) }],
        exec,
      };
    default:
      throw new Error(`Unknown PROFILE "${PROFILE}". Use smoke, load, stress, spike, soak or breakpoint.`);
  }
}

/**
 * Pass/fail criteria. Only requests tagged with `api` count, so the token
 * calls (Clerk, the local WeldID token broker) never skew the result. On
 * `breakpoint` the latency and error
 * limits abort the run: the moment they trip is the answer.
 */
export function thresholdsFor(api) {
  const p95Read = Number(__ENV.P95_READ_MS || 800);
  const p95Write = Number(__ENV.P95_WRITE_MS || 1500);
  const maxErrorRate = Number(__ENV.MAX_ERROR_RATE || 0.01);
  if (PROFILE === 'breakpoint') {
    const abort = (threshold) => ({ threshold, abortOnFail: true, delayAbortEval: '30s' });
    return {
      [`http_req_failed{api:${api}}`]: [abort(`rate<${Math.max(maxErrorRate, 0.05)}`)],
      [`http_req_duration{api:${api}}`]: [abort(`p(95)<${Number(__ENV.BREAK_P95_MS || 3000)}`)],
    };
  }
  return {
    [`http_req_failed{api:${api}}`]: [`rate<${maxErrorRate}`],
    [`http_req_duration{api:${api},kind:read}`]: [`p(95)<${p95Read}`],
    [`http_req_duration{api:${api},kind:write}`]: [`p(95)<${p95Write}`],
    checks: ['rate>0.98'],
  };
}

export function baseOptions(api, exec) {
  return {
    scenarios: { [api]: scenarioFor(exec) },
    thresholds: thresholdsFor(api),
    summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
    setupTimeout: '2m',
    userAgent: `weldsuite-loadtest/${RUN_ID}`,
  };
}

/** Random pick from `[{ weight, run }]`. */
export function pickWeighted(items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

export function uniqueSuffix() {
  return `${RUN_ID}-${__VU}-${__ITER}-${Math.floor(random() * 1e6)}`;
}

/** Randomness for the traffic mix and jitter only; nothing here is security-relevant. */
export function random() {
  // eslint-disable-next-line sonarjs/pseudo-random -- load-test traffic mix, not security
  return Math.random();
}

/** Whether this iteration runs a write flow instead of a read. */
export function isWriteIteration() {
  return random() < WRITE_RATIO;
}

function clamp(n, min, max) {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}
