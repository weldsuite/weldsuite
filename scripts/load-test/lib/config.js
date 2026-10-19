/**
 * Shared configuration for the k6 pressure tests: target hosts, the
 * production guard, load profiles and pass/fail thresholds.
 *
 * Everything is read from environment variables (k6 exposes them as
 * `__ENV`); `run.mjs` loads them from `scripts/load-test/.env`.
 */

export const WELD_ENV = (__ENV.WELD_ENV || 'test').toLowerCase();
export const PROFILE = (__ENV.PROFILE || 'smoke').toLowerCase();
export const RUN_ID = __ENV.RUN_ID || String(Date.now());
export const SCALE = Number(__ENV.SCALE || 1);
/** Share of iterations that run a write flow (create → update → delete). */
export const WRITE_RATIO = clamp(Number(__ENV.WRITE_RATIO ?? 0.2), 0, 1);
/** Marker on every record the test creates; `cleanup` deletes by it. */
export const MARKER = 'loadtest';

const HOST_SUFFIX = WELD_ENV === 'production' ? '' : `-${WELD_ENV}`;

/**
 * Host for a first-party module worker (`crm` → crm-api-test.weldsuite.org,
 * `app` → app-api-test.weldsuite.org). The platform SPA is deployed with
 * VITE_API_MODULES=all, so it calls the module workers directly; that is the
 * default here too. VIA_APP_API=1 routes everything through app-api's
 * forwarder instead, and BASE_URL pins a single host (e.g. local
 * `pnpm dev:api` on http://localhost:8789).
 */
export function platformHost(module) {
  if (__ENV.BASE_URL) return __ENV.BASE_URL.replace(/\/$/, '');
  if (truthy(__ENV.VIA_APP_API)) return `https://app-api${HOST_SUFFIX}.weldsuite.org`;
  return `https://${module}-api${HOST_SUFFIX}.weldsuite.org`;
}

export function publicApiHost() {
  if (__ENV.PUBLIC_API_URL) return __ENV.PUBLIC_API_URL.replace(/\/$/, '');
  return `https://api${HOST_SUFFIX}.weldsuite.org`;
}

/** Refuse to run against production unless explicitly allowed. */
export function assertSafeTarget() {
  if (WELD_ENV === 'production' && __ENV.ALLOW_PRODUCTION !== 'yes') {
    throw new Error(
      'Refusing to pressure-test production. Set ALLOW_PRODUCTION=yes if you really mean it.',
    );
  }
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
 * Pass/fail criteria. Only requests tagged with `api` count, so the Clerk
 * token calls never skew the result. On `breakpoint` the latency and error
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

function truthy(value) {
  return value === '1' || value === 'true' || value === 'yes';
}

function clamp(n, min, max) {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}
