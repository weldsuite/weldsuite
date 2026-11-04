/**
 * Every /api/warehouse-zones route on pglite, through the shared CRUD suite
 * (../../test/crud-suite.ts); runs against Rust in conformance mode. Zones
 * list by picking sequence, then id.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { warehouseZonesRoutes } from './index';

describeCrud('/api/warehouse-zones', {
  base: '/api/warehouse-zones',
  routes: warehouseZonesRoutes,
  table: schema.warehouseZones,
  gates: { read: 'warehouses:read', create: 'warehouses:create', update: 'warehouses:update', delete: 'warehouses:delete' },
  seed: (n) => ({ warehouseId: 'wh_seed', name: `Zone ${n}`, code: `Z-${n}`, pickingSequence: n % 3 }),
  valid: { warehouseId: 'wh_1', name: 'Receiving', code: 'RCV', zoneType: 'receiving', minTemperature: 2, metadata: { dock: 3 } },
  unstorable: [{ warehouseId: 'wh_1', name: 'Too warm', minTemperature: 3000000000 }],
  invalid: [
    { warehouseId: '', name: 'x' },
    { warehouseId: 'w', name: 'x', priority: 1.5 },
    { warehouseId: 'w', name: 'x', metadata: 'str' },
    { warehouseId: 'x'.repeat(31), name: '', isActive: 'no' },
  ],
  patches: [
    { name: 'Shipping', zoneType: 'shipping', isActive: false },
    { warehouseId: 'wh_ignored', pickingSequence: 4 },
    { description: 'Cold room', temperatureControlled: true, metadata: {} },
  ],
  invalidPatch: { pickingSequence: 'first' },
  filters: [
    { query: 'search=Needle', match: { name: 'Needle zone' } },
    { query: 'warehouseId=wh_filter', match: { warehouseId: 'wh_filter' } },
    { query: 'zoneType=quarantine', match: { zoneType: 'quarantine' } },
    { query: 'isActive=false', match: { isActive: false } },
  ],
  queries: ['isActive=true', 'isActive=', 'warehouseId=&zoneType='],
});

describe('/api/warehouse-zones · cursor on a zone without a picking sequence', () => {
  let db: Database;
  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    await db.insert(schema.warehouseZones).values([
      { id: 'zone_a', warehouseId: 'wh_1', name: 'A', pickingSequence: null },
      { id: 'zone_b', warehouseId: 'wh_1', name: 'B', pickingSequence: 1 },
    ]);
  }, 60_000);

  it('pages past nothing when the cursor row has no sequence', async () => {
    const { request } = createTestApp('/api/warehouse-zones', warehouseZonesRoutes, {
      context: { permissions: permissions('warehouses:read'), tenantDb: db },
    });
    const res = await request('/api/warehouse-zones?cursor=zone_a');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(0);
    expect((await request('/api/warehouse-zones?cursor=zone_b&limit=1')).status).toBe(200);
  });
});

it('exports the router the suite mounts', () => {
  expect(warehouseZonesRoutes.routes.length).toBeGreaterThan(0);
});
