/**
 * Pressure test for the first-party API: the module workers the platform SPA
 * and the mobile apps call (crm-api, desk-api, flow-api, commerce-api) plus
 * app-api, authenticated as a real member through a Clerk session.
 *
 * Each iteration is one "user action", picked by weight: mostly list/search
 * reads, and WRITE_RATIO of the time a full create → read → update → delete
 * flow. Everything it creates is named `loadtest …` and deleted in the same
 * iteration; `pnpm load-test cleanup` removes leftovers from aborted runs.
 *
 * Run through scripts/load-test/run.mjs (`pnpm load-test platform <profile>`).
 */

import { sleep } from 'k6';
import { assertSafeTarget, baseOptions, isWriteIteration, MARKER, pickWeighted, platformHost, random, thinkTime, uniqueSuffix } from '../lib/config.js';
import { bearerToken, initialToken } from '../lib/auth.js';
import { createClient, endpointMetrics, jsonField } from '../lib/http.js';
import { summaryOutputs } from '../lib/summary.js';

const API = 'platform';

const metrics = endpointMetrics([
  'people_list', 'people_search', 'people_page2', 'people_get', 'people_create', 'people_update', 'people_delete',
  'companies_list', 'companies_create', 'companies_update', 'companies_delete',
  'tickets_list', 'tickets_create', 'tickets_update', 'tickets_delete',
  'tasks_list', 'tasks_create', 'tasks_update', 'tasks_delete',
  'projects_list', 'products_list',
  'notifications_list', 'notifications_unread', 'my_role', 'search',
]);

export const options = baseOptions(API, 'run');

export function setup() {
  assertSafeTarget();
  const token = initialToken();
  // Fail fast on a wrong host, revoked session or missing permission instead of
  // spending ten minutes producing 401s.
  const api = client(token);
  const res = api.get('my_role', 'app', '/api/my-role');
  if (res.status !== 200) {
    throw new Error(`Pre-flight GET /api/my-role returned ${res.status}: ${String(res.body).slice(0, 300)}`);
  }
  return token;
}

function client(shared) {
  return createClient({
    api: API,
    metrics,
    hostFor: platformHost,
    headers: () => ({ Authorization: `Bearer ${bearerToken(shared)}` }),
  });
}

const SEARCH_TERMS = ['a', 'e', 'jan', 'info', 'test', 'acme', 'support', 'order'];
const randomTerm = () => SEARCH_TERMS[Math.floor(random() * SEARCH_TERMS.length)];

const READS = [
  { weight: 20, run: (api) => api.get('people_list', 'crm', '/api/people?limit=25') },
  { weight: 5, run: (api) => api.get('people_search', 'crm', `/api/people?limit=25&search=${randomTerm()}`) },
  {
    weight: 3,
    run: (api) => {
      const first = api.get('people_list', 'crm', '/api/people?limit=100');
      const cursor = jsonField(first, 'pagination.cursor');
      if (cursor) api.get('people_page2', 'crm', `/api/people?limit=100&cursor=${encodeURIComponent(cursor)}`);
    },
  },
  { weight: 8, run: (api) => api.get('companies_list', 'crm', '/api/companies?limit=25') },
  { weight: 12, run: (api) => api.get('tickets_list', 'desk', '/api/tickets?limit=25') },
  { weight: 10, run: (api) => api.get('tasks_list', 'flow', '/api/tasks?limit=50') },
  { weight: 5, run: (api) => api.get('projects_list', 'flow', '/api/projects?limit=25') },
  { weight: 5, run: (api) => api.get('products_list', 'commerce', '/api/products?limit=25') },
  { weight: 8, run: (api) => api.get('notifications_unread', 'app', '/api/notifications/unread-count') },
  { weight: 3, run: (api) => api.get('notifications_list', 'app', '/api/notifications?limit=25') },
  { weight: 4, run: (api) => api.get('my_role', 'app', '/api/my-role') },
  { weight: 5, run: (api) => api.post('search', 'app', '/api/search', { q: randomTerm(), limit: 5 }, { kind: 'read', expect: [200] }) },
];

/** Create a record, run `steps` on it, and always try to delete it again. */
function lifecycle(api, { create, steps, remove }) {
  const res = create();
  const id = jsonField(res, 'data.id');
  if (!id) return;
  try {
    steps(id);
  } finally {
    remove(id);
  }
}

const WRITES = [
  {
    weight: 40,
    run: (api) => {
      const s = uniqueSuffix();
      lifecycle(api, {
        create: () => api.post('people_create', 'crm', '/api/people', {
          firstName: MARKER,
          lastName: s,
          email: `${MARKER}+${s}@example.com`,
        }),
        steps: (id) => {
          api.get('people_get', 'crm', `/api/people/${id}`);
          api.patch('people_update', 'crm', `/api/people/${id}`, { title: 'Load test' });
        },
        remove: (id) => api.del('people_delete', 'crm', `/api/people/${id}`),
      });
    },
  },
  {
    weight: 20,
    run: (api) => {
      lifecycle(api, {
        create: () => api.post('companies_create', 'crm', '/api/companies', { name: `${MARKER} ${uniqueSuffix()}` }),
        steps: (id) => api.patch('companies_update', 'crm', `/api/companies/${id}`, { description: 'Load test' }),
        remove: (id) => api.del('companies_delete', 'crm', `/api/companies/${id}`),
      });
    },
  },
  {
    weight: 25,
    run: (api) => {
      const s = uniqueSuffix();
      lifecycle(api, {
        create: () => api.post('tickets_create', 'desk', '/api/tickets', {
          customerEmail: `${MARKER}+${s}@example.com`,
          customerName: MARKER,
          subject: `${MARKER} ${s}`,
          channel: 'api',
        }),
        steps: (id) => api.patch('tickets_update', 'desk', `/api/tickets/${id}`, { description: 'Updated by load test' }),
        remove: (id) => api.del('tickets_delete', 'desk', `/api/tickets/${id}`),
      });
    },
  },
  {
    weight: 15,
    run: (api) => {
      lifecycle(api, {
        create: () => api.post('tasks_create', 'flow', '/api/tasks', { title: `${MARKER} ${uniqueSuffix()}` }),
        steps: (id) => api.patch('tasks_update', 'flow', `/api/tasks/${id}`, { description: 'Updated by load test' }),
        remove: (id) => api.del('tasks_delete', 'flow', `/api/tasks/${id}`),
      });
    },
  },
];

export function run(shared) {
  const api = client(shared);
  const pool = isWriteIteration() ? WRITES : READS;
  pickWeighted(pool).run(api);
  const pause = thinkTime();
  if (pause) sleep(pause);
}

export function handleSummary(data) {
  return summaryOutputs(API, data);
}
