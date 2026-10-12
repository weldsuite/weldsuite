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
import inboxRoutes from './inbox';
import domainRoutes from './domains';
import mailboxRoutes from './mailboxes';
import settingsRoutes from './settings';
import billingRoutes from './billing';
import prospectRoutes from './prospects';
import listRoutes from './lists';
import campaignRoutes from './campaigns';
import suppressionRoutes from './suppressions';
import overviewRoutes from './overview';

const ROUTES_DIR = __dirname;

/** Route dirs intentionally excluded from entity-event coverage. */
const EXEMPT_ROUTES = new Set<string>([
  // Prospect lists are an organisation aid; the entity-event catalog has no list type (prospects publish reach_prospect:*).
  'lists',
  // The suppression list is a compliance record, not a catalogued entity; additions and removals are the audit trail.
  'suppressions',
]);

const AUTH_CASES: AuthGateCase<Env, Variables>[] = [
  // Sending surface: prospects, lists, campaigns, suppressions, overview.
  { mount: '/api/reach/prospects', router: prospectRoutes, prefix: 'reach_prospects' },
  { mount: '/api/reach/lists', router: listRoutes, prefix: 'reach_prospects' },
  { mount: '/api/reach/campaigns', router: campaignRoutes, prefix: 'reach_campaigns' },
  // Suppressions are written with reach_settings:update only (no create/delete keys exist) and have no PATCH.
  { mount: '/api/reach/suppressions', router: suppressionRoutes, prefix: 'reach_settings', skipPatch: true },
  { mount: '/api/reach/overview', router: overviewRoutes, prefix: 'reach_campaigns', skipPost: true, skipPatch: true, skipDelete: true },
  // Account surface: domains, mailboxes, settings, billing.
  { mount: '/api/reach/domains', router: domainRoutes, prefix: 'reach_mailboxes', skipPatch: true },
  { mount: '/api/reach/mailboxes', router: mailboxRoutes, prefix: 'reach_mailboxes' },
  { mount: '/api/reach/settings', router: settingsRoutes, prefix: 'reach_settings', skipPost: true, skipPatch: true, skipDelete: true },
  { mount: '/api/reach/billing', router: billingRoutes, prefix: 'reach_settings', skipPost: true, skipPatch: true, skipDelete: true },
  // The inbox has no standard CRUD: threads are read-only here and replies, labels and CRM hand-offs are
  // sub-actions (tested in inbox/inbox.test.ts, which also checks their permissions). Only the GET gate is standard.
  { mount: '/api/reach/inbox', router: inboxRoutes, prefix: 'reach_inbox', skipPost: true, skipPatch: true, skipDelete: true },
];

const LIST_CASES: ListSweepCase<Env, Variables>[] = [
  { mount: '/api/reach/prospects', router: prospectRoutes, permission: 'reach_prospects:read' },
  { mount: '/api/reach/lists', router: listRoutes, permission: 'reach_prospects:read' },
  { mount: '/api/reach/campaigns', router: campaignRoutes, permission: 'reach_campaigns:read' },
  { mount: '/api/reach/suppressions', router: suppressionRoutes, permission: 'reach_settings:read' },
  { mount: '/api/reach/domains', router: domainRoutes, permission: 'reach_mailboxes:read' },
  { mount: '/api/reach/mailboxes', router: mailboxRoutes, permission: 'reach_mailboxes:read' },
  { mount: '/api/reach/inbox', router: inboxRoutes, permission: 'reach_inbox:read' },
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
