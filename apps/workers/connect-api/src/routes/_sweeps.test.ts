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
import { workflowsRoutes } from './workflows';

const ROUTES_DIR = __dirname;

/** Route dirs intentionally excluded from entity-event coverage. */
const EXEMPT_ROUTES = new Set<string>([
  // Infra / non-entity-object routes (OAuth connections, workflow
  // builder/dashboard aggregates) — nothing meaningful to fan out.
  'integrations',
  'github-connections',
  'github-repo-links',
  'workflow-builder',
  'workflow-dashboard',
  // external-webhooks — user-managed outbound webhook subscriptions (integration
  // config); no `external_webhook` entity type in the events catalog.
  'external-webhooks',
  // github-project-links — GitHub integration links (like github-connections /
  // github-repo-links above): infra, no entity type in the catalog.
  'github-project-links',
]);

const AUTH_CASES: AuthGateCase<Env, Variables>[] = [];

const LIST_CASES: ListSweepCase<Env, Variables>[] = [
  { mount: '/api/workflows', router: workflowsRoutes, permission: 'workflows:read' },
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
