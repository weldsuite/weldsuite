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
import commentsRoutes from './comments';
import connectionsRoutes from './connections';
import cyclesRoutes from './cycles';
import inboxRoutes from './inbox';
import issuesRoutes from './issues';
import labelsRoutes from './labels';
import pullRequestsRoutes from './pull-requests';
import repositoriesRoutes from './repositories';
import teamsRoutes from './teams';

const ROUTES_DIR = __dirname;

/** Route dirs intentionally excluded from entity-event coverage. */
/**
 * Every route directory has either core CRUD that publishes, or none: `accounts`
 * (the member's own login, not a catalogued entity), `pull-requests` and `inbox`
 * (read-only) and `internal` (the GitHub event intake) have nothing the sweep checks.
 */
const EXEMPT_ROUTES = new Set<string>([]);

const AUTH_CASES: AuthGateCase<Env, Variables>[] = [
  { mount: '/api/merge/teams', router: teamsRoutes, prefix: 'merge_teams' },
  { mount: '/api/merge/labels', router: labelsRoutes, prefix: 'merge_teams' },
  { mount: '/api/merge/cycles', router: cyclesRoutes, prefix: 'merge_teams' },
  { mount: '/api/merge/issues', router: issuesRoutes, prefix: 'merge_issues' },
  { mount: '/api/merge/comments', router: commentsRoutes, prefix: 'merge_issues', skipGet: true, skipPost: true },
  { mount: '/api/merge/pull-requests', router: pullRequestsRoutes, prefix: 'merge_pull_requests', skipPost: true, skipPatch: true, skipDelete: true },
  { mount: '/api/merge/connections', router: connectionsRoutes, prefix: 'merge_connections', skipPost: true, skipPatch: true },
  { mount: '/api/merge/repositories', router: repositoriesRoutes, prefix: 'merge_connections' },
];

const LIST_CASES: ListSweepCase<Env, Variables>[] = [
  { mount: '/api/merge/teams', router: teamsRoutes, permission: 'merge_teams:read' },
  { mount: '/api/merge/labels', router: labelsRoutes, permission: 'merge_teams:read' },
  { mount: '/api/merge/cycles', router: cyclesRoutes, permission: 'merge_teams:read' },
  { mount: '/api/merge/issues', router: issuesRoutes, permission: 'merge_issues:read' },
  { mount: '/api/merge/pull-requests', router: pullRequestsRoutes, permission: 'merge_pull_requests:read' },
  { mount: '/api/merge/inbox', router: inboxRoutes, permission: 'merge_pull_requests:read' },
  { mount: '/api/merge/connections', router: connectionsRoutes, permission: 'merge_connections:read' },
  { mount: '/api/merge/repositories', router: repositoriesRoutes, permission: 'merge_connections:read' },
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
