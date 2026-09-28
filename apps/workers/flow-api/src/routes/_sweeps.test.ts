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
import { milestonesRoutes } from './milestones';
import { myTasksRoutes } from './my-tasks';
import { projectsRoutes } from './projects';
import { tasksRoutes } from './tasks';

const ROUTES_DIR = __dirname;

/** Route dirs intentionally excluded from entity-event coverage. */
const EXEMPT_ROUTES = new Set<string>([
  // Settings / read-only routes (moved here from app-api's _event-coverage.test.ts).
  // digest-settings: singleton GET / + PUT / (PUT / still publishes digest_settings).
  'digest-settings',
  // my-tasks: read-only assigned-task list; no mutations.
  'my-tasks',
]);

const AUTH_CASES: AuthGateCase<Env, Variables>[] = [
  // projects GET / is deliberately membership-filtered (scope-based), not
  // hard-blocked by requirePermission — see the note at the top of projects/index.ts.
  { mount: '/api/projects', router: projectsRoutes, prefix: 'projects', skipGet: true },
  { mount: '/api/tasks', router: tasksRoutes, prefix: 'tasks' },
  { mount: '/api/milestones', router: milestonesRoutes, prefix: 'milestones' },
];

const LIST_CASES: ListSweepCase<Env, Variables>[] = [
  { mount: '/api/tasks', router: tasksRoutes, permission: 'tasks:read' },
  { mount: '/api/my-tasks', router: myTasksRoutes, permission: 'tasks:read' },
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
  it('returns 200 with the list envelope against an empty tenant', async () => {
    const { db } = await createPgliteDb();
    const r = await listEndpointResult(c, db);
    expect(r.status).toBe(200);
    expect(r.envelopeOk).toBe(true);
    // A cold pglite boot can pass vitest's 5 s default while the route
    // integration tests boot theirs in parallel (app-api gave its shared
    // boot 60 s).
  }, 60_000);
});
