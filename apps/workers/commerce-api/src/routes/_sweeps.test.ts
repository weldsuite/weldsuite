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
import { carriersRoutes } from './carriers';
import { categoriesRoutes } from './categories';
import { ordersRoutes } from './orders';
import { parcelsRoutes } from './parcels';
import { pickupsRoutes } from './pickups';
import { productsRoutes } from './products';
import { returnsRoutes } from './returns';

const ROUTES_DIR = __dirname;

/** Route dirs intentionally excluded from entity-event coverage. */
const EXEMPT_ROUTES = new Set<string>([
  // Parcel helper / singleton / read-only routes — no standard /:id CRUD surface.
  // parcel-settings: singleton GET / + PUT / (no resource /:id lifecycle).
  // parcel-rates: action-only (POST /calculate, POST /select); no resource lifecycle.
  // parcel-analytics: read-only aggregates only; no mutations.
  'parcel-settings',
  'parcel-rates',
  'parcel-analytics',
  // printnode / sendcloud — singleton integration config, not entity CRUD.
  'printnode',
  'sendcloud',
]);

const AUTH_CASES: AuthGateCase<Env, Variables>[] = [
  { mount: '/api/orders', router: ordersRoutes, prefix: 'orders' },
  { mount: '/api/categories', router: categoriesRoutes, prefix: 'categories' },
  { mount: '/api/parcels', router: parcelsRoutes, prefix: 'parcels' },
  { mount: '/api/pickups', router: pickupsRoutes, prefix: 'pickups' },
  { mount: '/api/returns', router: returnsRoutes, prefix: 'returns' },
  { mount: '/api/carriers', router: carriersRoutes, prefix: 'carriers' },
];

const LIST_CASES: ListSweepCase<Env, Variables>[] = [
  { mount: '/api/products', router: productsRoutes, permission: 'products:read' },
  { mount: '/api/orders', router: ordersRoutes, permission: 'orders:read' },
  { mount: '/api/categories', router: categoriesRoutes, permission: 'categories:read' },
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
  });
});
