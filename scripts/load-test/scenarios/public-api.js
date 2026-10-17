/**
 * Pressure test for the public API (external-api, api-test.weldsuite.org),
 * authenticated with a workspace API key (`wsk_…`).
 *
 * The public API is rate-limited per workspace by plan tier (60 / 300 / 1000
 * / 5000 requests per minute, apps/workers/external-api/src/middleware/
 * rate-limit.ts). A 429 is therefore counted separately and not as a failure:
 * past the limit, this test checks that the limiter holds and the API stays
 * healthy behind it. Use a workspace on the enterprise tier to push the
 * workers themselves.
 *
 * Key needs scopes people:*, companies:*, tasks:*, tickets:read, products:read.
 */

import http from 'k6/http';
import { sleep } from 'k6';
import { assertSafeTarget, baseOptions, isWriteIteration, MARKER, pickWeighted, publicApiHost, thinkTime, uniqueSuffix } from '../lib/config.js';
import { createClient, endpointMetrics, jsonField } from '../lib/http.js';
import { summaryOutputs } from '../lib/summary.js';

const API = 'public';

// 429 is the limiter working, not the API failing.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 429));

const metrics = endpointMetrics([
  'whoami', 'people_list', 'people_get', 'people_create', 'people_update', 'people_delete',
  'companies_list', 'companies_create', 'companies_update', 'companies_delete',
  'tasks_list', 'tasks_create', 'tasks_update', 'tasks_delete',
  'tickets_list', 'products_list',
]);

export const options = baseOptions(API, 'run');

const api = createClient({
  api: API,
  metrics,
  hostFor: publicApiHost,
  headers: () => ({ Authorization: `Bearer ${__ENV.WELD_API_KEY}` }),
});

export function setup() {
  assertSafeTarget();
  if (!__ENV.WELD_API_KEY) throw new Error('Set WELD_API_KEY (a wsk_… key for the test workspace) in scripts/load-test/.env');
  const res = api.get('whoami', '', '/v1/');
  if (res.status !== 200) {
    throw new Error(`Pre-flight GET /v1/ returned ${res.status}: ${String(res.body).slice(0, 300)}`);
  }
  const tier = jsonField(res, 'data.workspace.tier');
  console.log(`Public API: workspace tier "${tier}", rate limit ${res.headers['X-Ratelimit-Limit'] || '?'} requests/min`);
  return {};
}

const READS = [
  { weight: 25, run: () => api.get('people_list', '', '/v1/people?limit=25') },
  { weight: 15, run: () => api.get('companies_list', '', '/v1/companies?limit=25') },
  { weight: 20, run: () => api.get('tasks_list', '', '/v1/tasks?limit=50') },
  { weight: 20, run: () => api.get('tickets_list', '', '/v1/tickets?limit=25') },
  { weight: 15, run: () => api.get('products_list', '', '/v1/products?limit=25') },
  { weight: 5, run: () => api.get('whoami', '', '/v1/') },
];

function lifecycle({ create, steps, remove }) {
  const id = jsonField(create(), 'data.id');
  if (!id) return;
  try {
    steps(id);
  } finally {
    // A rate-limited delete would leave the record behind, so wait it out.
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = remove(id);
      if (res.status !== 429) break;
      sleep(Number(res.headers['Retry-After'] || 5));
    }
  }
}

const WRITES = [
  {
    weight: 45,
    run: () => {
      const s = uniqueSuffix();
      lifecycle({
        create: () => api.post('people_create', '', '/v1/people', { firstName: MARKER, lastName: s, email: `${MARKER}+${s}@example.com` }),
        steps: (id) => {
          api.get('people_get', '', `/v1/people/${id}`);
          api.patch('people_update', '', `/v1/people/${id}`, { title: 'Load test' });
        },
        remove: (id) => api.del('people_delete', '', `/v1/people/${id}`),
      });
    },
  },
  {
    weight: 30,
    run: () => lifecycle({
      create: () => api.post('companies_create', '', '/v1/companies', { name: `${MARKER} ${uniqueSuffix()}` }),
      steps: (id) => api.patch('companies_update', '', `/v1/companies/${id}`, { description: 'Load test' }),
      remove: (id) => api.del('companies_delete', '', `/v1/companies/${id}`),
    }),
  },
  {
    weight: 25,
    run: () => lifecycle({
      create: () => api.post('tasks_create', '', '/v1/tasks', { title: `${MARKER} ${uniqueSuffix()}` }),
      steps: (id) => api.patch('tasks_update', '', `/v1/tasks/${id}`, { description: 'Updated by load test' }),
      remove: (id) => api.del('tasks_delete', '', `/v1/tasks/${id}`),
    }),
  },
];

export function run() {
  const pool = isWriteIteration() ? WRITES : READS;
  pickWeighted(pool).run();
  const pause = thinkTime();
  if (pause) sleep(pause);
}

export function handleSummary(data) {
  return summaryOutputs(API, data);
}
