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
import { activitiesRoutes } from './activities';
import { companiesRoutes } from './companies';
import { crmAnalyticsRoutes } from './crm-analytics';
import { customerStatusesRoutes } from './customer-statuses';
import { leadsRoutes } from './leads';
import { listsRoutes } from './lists';
import { opportunitiesRoutes } from './opportunities';
import { peopleRoutes } from './people';
import { pipelineStagesRoutes } from './pipeline-stages';
import { pipelinesRoutes } from './pipelines';

const ROUTES_DIR = __dirname;

/** Route dirs intentionally excluded from entity-event coverage. */
const EXEMPT_ROUTES = new Set<string>([]);

const AUTH_CASES: AuthGateCase<Env, Variables>[] = [
  { mount: '/api/opportunities', router: opportunitiesRoutes, prefix: 'opportunities' },
  { mount: '/api/leads', router: leadsRoutes, prefix: 'leads' },
  { mount: '/api/activities', router: activitiesRoutes, prefix: 'activities' },
  { mount: '/api/pipelines', router: pipelinesRoutes, prefix: 'pipelines' },
  // customer-statuses uses customers:read for read, settings:manage for create/update/delete
  { mount: '/api/customer-statuses', router: customerStatusesRoutes, prefix: 'settings' },
  // crm-analytics (saved reports/charts) uses contacts:read for ALL operations,
  // so only the GET-without-read gate fits this standard sweep; the mutations
  // don't gate on create/update/delete.
  { mount: '/api/crm-analytics', router: crmAnalyticsRoutes, prefix: 'contacts', skipPost: true, skipPatch: true, skipDelete: true },
  // pipeline-field-visibility is intentionally omitted: it is nested under
  // /:id with no standard top-level GET / / POST / or /:id PATCH/DELETE, so no
  // assertion in this standard CRUD sweep applies to it.
];

const LIST_CASES: ListSweepCase<Env, Variables>[] = [
  { mount: '/api/companies', router: companiesRoutes, permission: 'companies:read' },
  { mount: '/api/people', router: peopleRoutes, permission: 'people:read' },
  { mount: '/api/activities', router: activitiesRoutes, permission: 'activities:read' },
  { mount: '/api/leads', router: leadsRoutes, permission: 'leads:read' },
  { mount: '/api/pipelines', router: pipelinesRoutes, permission: 'pipelines:read' },
  { mount: '/api/pipeline-stages', router: pipelineStagesRoutes, permission: 'pipelines:read' },
  { mount: '/api/lists', router: listsRoutes, permission: 'companies:read' },
  { mount: '/api/opportunities', router: opportunitiesRoutes, permission: 'opportunities:read' },
  { mount: '/api/customer-statuses', router: customerStatusesRoutes, permission: 'customers:read' },
  { mount: '/api/crm-analytics', router: crmAnalyticsRoutes, permission: 'contacts:read' },
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
