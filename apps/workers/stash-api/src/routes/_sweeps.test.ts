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
import { boxesRoutes } from './boxes';
import { pickersRoutes } from './pickers';
import { pickListsRoutes } from './pick-lists';
import { stockAdjustmentsRoutes } from './stock-adjustments';
import { warehouseLocationsRoutes } from './warehouse-locations';
import { warehousesRoutes } from './warehouses';
import { warehouseZonesRoutes } from './warehouse-zones';
import { wmsSuppliersRoutes } from './wms-suppliers';

const ROUTES_DIR = __dirname;

/** Route dirs intentionally excluded from entity-event coverage. */
const EXEMPT_ROUTES = new Set<string>([
  // wms-activity — read-only append-only audit log; no mutations, no entity events.
  'wms-activity',
]);

const AUTH_CASES: AuthGateCase<Env, Variables>[] = [
  { mount: '/api/warehouse-locations', router: warehouseLocationsRoutes, prefix: 'locations' },
  { mount: '/api/warehouses', router: warehousesRoutes, prefix: 'warehouses' },
  { mount: '/api/warehouse-zones', router: warehouseZonesRoutes, prefix: 'warehouses' },
  { mount: '/api/wms-suppliers', router: wmsSuppliersRoutes, prefix: 'suppliers' },
  // stock-adjustments is append-only: no PATCH /:id or DELETE /:id
  { mount: '/api/stock-adjustments', router: stockAdjustmentsRoutes, prefix: 'inventory', skipPatch: true, skipDelete: true },
  { mount: '/api/boxes', router: boxesRoutes, prefix: 'boxes' },
  // pickers: uses PUT /:id (full update) not PATCH /:id; PATCH /:id/status is a sub-action.
  { mount: '/api/pickers', router: pickersRoutes, prefix: 'warehouses', skipPatch: true },
  { mount: '/api/pick-lists', router: pickListsRoutes, prefix: 'picklists' },
];

const LIST_CASES: ListSweepCase<Env, Variables>[] = [
  { mount: '/api/warehouse-locations', router: warehouseLocationsRoutes, permission: 'locations:read' },
  { mount: '/api/warehouses', router: warehousesRoutes, permission: 'warehouses:read' },
  { mount: '/api/warehouse-zones', router: warehouseZonesRoutes, permission: 'warehouses:read' },
  { mount: '/api/wms-suppliers', router: wmsSuppliersRoutes, permission: 'suppliers:read' },
  { mount: '/api/pick-lists', router: pickListsRoutes, permission: 'picklists:read' },
  { mount: '/api/stock-adjustments', router: stockAdjustmentsRoutes, permission: 'inventory:read' },
  // pickers: omitted from sweep until the warehouse_workers migration is generated + applied.
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
