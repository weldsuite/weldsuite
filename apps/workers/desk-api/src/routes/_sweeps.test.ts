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
import { conversationsRoutes } from './conversations';
import { deskConversationsRoutes } from './desk-conversations';
import { deskWidgetRoutes } from './desk-widget';
import { helpdeskAnalyticsRoutes } from './helpdesk-analytics';
import { helpdeskContactsRoutes } from './helpdesk-contacts';
import { slasRoutes } from './slas';
import { ticketsRoutes } from './tickets';

const ROUTES_DIR = __dirname;

/** Route dirs intentionally excluded from entity-event coverage. */
const EXEMPT_ROUTES = new Set<string>([
  // helpdesk-integrations — Discord/Slack channel connections on the same
  // integrationConnections table as `integrations` (connect): infra, not a
  // business entity, and the events catalog has no integration-connection
  // entity type (only `workflow_integration`, an unrelated object).
  'helpdesk-integrations',
]);

const AUTH_CASES: AuthGateCase<Env, Variables>[] = [
  { mount: '/api/conversations', router: conversationsRoutes, prefix: 'conversations' },
  { mount: '/api/slas', router: slasRoutes, prefix: 'slas' },
  // helpdesk-contacts uses conversations:* permissions; no DELETE (contacts owned by CRM)
  { mount: '/api/helpdesk-contacts', router: helpdeskContactsRoutes, prefix: 'conversations', skipDelete: true },
  // helpdesk-analytics uses settings:* permissions; full CRUD at top level
  { mount: '/api/helpdesk-analytics', router: helpdeskAnalyticsRoutes, prefix: 'settings' },
];

const LIST_CASES: ListSweepCase<Env, Variables>[] = [
  { mount: '/api/tickets', router: ticketsRoutes, permission: 'tickets:read' },
  { mount: '/api/conversations', router: conversationsRoutes, permission: 'conversations:read' },
  { mount: '/api/helpdesk-contacts', router: helpdeskContactsRoutes, permission: 'conversations:read' },
  { mount: '/api/helpdesk-analytics', router: helpdeskAnalyticsRoutes, permission: 'settings:read' },
  { mount: '/api/desk/conversations', router: deskConversationsRoutes, permission: 'conversations:read' },
  { mount: '/api/desk/widget', router: deskWidgetRoutes, permission: 'settings:read' },
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
