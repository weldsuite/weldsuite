/**
 * Cross-route safety sweeps for this worker (the same checks app-api runs, from
 * @weldsuite/worker-kit/testing/sweeps):
 *
 * - entity-event coverage: every core-CRUD mutation (`post('/')`,
 *   `patch|put('/:id')`, `delete('/:id')`) publishes an entity event;
 * - auth gates: standard CRUD calls answer 403 without their permission;
 * - list endpoints: GET / answers 200 with the list envelope on an empty tenant.
 *
 * Add a route to AUTH_CASES / LIST_CASES when it follows the standard shape,
 * and to EXEMPT_ROUTES (with a one-line reason) when it has nothing to publish.
 */

import { describe, expect, it } from 'vitest';
import {
  authGateStatuses,
  findMissingEntityEvents,
  listEndpointResult,
  type AuthGateCase,
  type ListSweepCase,
} from '@weldsuite/worker-kit/testing/sweeps';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Env, Variables } from '../types';
import projectsRoutes from './projects';
import reportsRoutes from './reports';
import dashboardsRoutes from './dashboards';
import cohortsRoutes from './cohorts';

const ROUTES_DIR = __dirname;

/** Route dirs intentionally excluded from entity-event coverage. */
const EXEMPT_ROUTES = new Set<string>([
  // POST /api/panel/query only reads: a typed spec in, rows out, nothing is written.
  'query',
  // Tracked-visitor data never goes on the entity bus (EVT-005): profiles, erasure (the Durable
  // Object keeps the trail), recordings, favourites, AI summaries and the live view.
  'people',
  'sessions',
  'insights',
  'live',
  // heatmaps (panel_heatmap_page) and keys (panel_key) are config objects and publish; they are
  // not in the standard-shape lists below because they are mounted at /pages and under a project.
]);

const AUTH_CASES: AuthGateCase<Env, Variables>[] = [
  { mount: '/api/panel/projects', router: projectsRoutes, prefix: 'panel_projects' },
  { mount: '/api/panel/reports', router: reportsRoutes, prefix: 'panel_reports' },
  { mount: '/api/panel/dashboards', router: dashboardsRoutes, prefix: 'panel_reports' },
  { mount: '/api/panel/cohorts', router: cohortsRoutes, prefix: 'panel_reports' },
];

const LIST_CASES: ListSweepCase<Env, Variables>[] = [
  { mount: '/api/panel/projects', router: projectsRoutes, permission: 'panel_projects:read' },
  { mount: '/api/panel/reports', router: reportsRoutes, permission: 'panel_reports:read' },
  { mount: '/api/panel/dashboards', router: dashboardsRoutes, permission: 'panel_reports:read' },
  { mount: '/api/panel/cohorts', router: cohortsRoutes, permission: 'panel_reports:read' },
];

describe('entity-event coverage', () => {
  const report = findMissingEntityEvents(ROUTES_DIR, EXEMPT_ROUTES);

  it('every core-CRUD mutation handler publishes an entity event', () => {
    expect(report.failures, `\n${report.failures.join('\n')}\n`).toEqual([]);
  });

  it('exemptions all reference real route directories', () => {
    expect(report.staleExemptions).toEqual([]);
  });
});

describe.skipIf(AUTH_CASES.length === 0).each(AUTH_CASES)('$mount · auth gates', (c) => {
  it('refuses every standard CRUD call without its permission', async () => {
    for (const r of await authGateStatuses(c)) expect(r.status, r.label).toBe(403);
  });
});

describe.skipIf(LIST_CASES.length === 0).each(LIST_CASES)('$mount · GET / (list endpoint sweep)', (c) => {
  // 60 s: the first case boots pglite (WASM Postgres) for this test process.
  it('returns 200 with the list envelope against an empty tenant', async () => {
    const { db } = await createPgliteDb();
    const r = await listEndpointResult(c, db);
    expect(r.status).toBe(200);
    expect(r.envelopeOk).toBe(true);
  }, 60_000);
});
