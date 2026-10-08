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
import { bankAccountsRoutes } from './bank-accounts';
import { bankDepositsRoutes } from './bank-deposits';
import { bankReconciliationsRoutes } from './bank-reconciliations';
import { billsRoutes } from './bills';
import { invoicesRoutes } from './invoices';
import { paymentsRoutes } from './payments';

const ROUTES_DIR = __dirname;

/** Route dirs intentionally excluded from entity-event coverage. */
const EXEMPT_ROUTES = new Set<string>([
  // Accounting read-only / singleton routes — no core-CRUD mutations.
  // accounting-settings: singleton PUT / (not PUT /:id); no post('/') create.
  // accounting-reports, accounting-dashboard: read-only aggregates only.
  'accounting-settings',
  'accounting-reports',
  'accounting-dashboard',
]);

const AUTH_CASES: AuthGateCase<Env, Variables>[] = [
  { mount: '/api/bills', router: billsRoutes, prefix: 'bills' },
  { mount: '/api/bank-accounts', router: bankAccountsRoutes, prefix: 'banking' },
  { mount: '/api/bank-deposits', router: bankDepositsRoutes, prefix: 'banking' },
  { mount: '/api/bank-reconciliations', router: bankReconciliationsRoutes, prefix: 'banking' },
  { mount: '/api/payments', router: paymentsRoutes, prefix: 'banking', skipPatch: true },
];

const LIST_CASES: ListSweepCase<Env, Variables>[] = [
  { mount: '/api/invoices', router: invoicesRoutes, permission: 'invoices:read' },
  { mount: '/api/bills', router: billsRoutes, permission: 'bills:read' },
  { mount: '/api/bank-accounts', router: bankAccountsRoutes, permission: 'banking:read' },
  { mount: '/api/bank-deposits', router: bankDepositsRoutes, permission: 'banking:read' },
  { mount: '/api/bank-reconciliations', router: bankReconciliationsRoutes, permission: 'banking:read' },
  { mount: '/api/payments', router: paymentsRoutes, permission: 'banking:read' },
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
