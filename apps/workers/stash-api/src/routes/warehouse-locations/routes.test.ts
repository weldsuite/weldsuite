/**
 * Every /api/warehouse-locations route on pglite, through the shared CRUD
 * suite (../../test/crud-suite.ts); runs against Rust in conformance mode.
 * Locations list by picking sequence, then code.
 */

import { expect, it } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { warehouseLocationsRoutes } from './index';

describeCrud('/api/warehouse-locations', {
  base: '/api/warehouse-locations',
  routes: warehouseLocationsRoutes,
  table: schema.warehouseLocations,
  gates: { read: 'locations:read', create: 'locations:create', update: 'locations:update', delete: 'locations:delete' },
  seed: (n) => ({ warehouseId: 'wh_seed', name: `Bin ${n}`, code: `A-${String(n).padStart(2, '0')}`, pickingSequence: n % 2 }),
  valid: {
    warehouseId: 'wh_1',
    zoneId: null,
    name: 'Bin 1',
    code: 'B-01',
    barcode: 'LOC-0001',
    aisle: 'B',
    level: 2,
    length: 10.5,
    width: 20,
    height: 0.25,
    maxWeight: 1500,
    maxItems: 40,
    isPrimaryPick: true,
    abcClass: 'A',
    metadata: { temperature: 'ambient' },
  },
  unstorable: [{ warehouseId: 'wh_1', name: 'Huge', code: 'H-1', length: 123456789 }],
  invalid: [
    { warehouseId: 'w', name: 'x', code: '' },
    { warehouseId: 'w', name: 'x', code: 'c', abcClass: 'AB' },
    { name: 'x', code: 'c', level: 1.5, length: '3' },
    { warehouseId: 'w', name: 'x', code: 'c', isActive: 1, metadata: [] },
  ],
  patches: [
    { name: 'Bin 2', length: 3, width: 4.5, zoneId: null },
    { warehouseId: 'wh_ignored', isActive: false, height: 7, maxWeight: 12.75 },
    { code: 'B-02', barcode: 'LOC-0002', pickingSequence: 3, metadata: { a: 1 } },
  ],
  invalidPatch: { maxItems: 2.5 },
  filters: [
    { query: 'search=Needle', match: { name: 'Needle bin' } },
    { query: 'search=BAR-HAY', match: { barcode: 'BAR-HAY' } },
    { query: 'warehouseId=wh_filter', match: { warehouseId: 'wh_filter' } },
    { query: 'zoneId=zone_filter', match: { zoneId: 'zone_filter' } },
    { query: 'locationType=bulk', match: { locationType: 'bulk' } },
    { query: 'isActive=false', match: { isActive: false } },
    { query: 'isEmpty=false', match: { isEmpty: false } },
    { query: 'isBlocked=true', match: { isBlocked: true } },
    { query: 'abcClass=C', match: { abcClass: 'C' } },
    { query: 'barcode=SCAN-1', match: { barcode: 'SCAN-1' } },
  ],
  queries: ['isActive=true&isEmpty=true', 'warehouseId=&zoneId=&abcClass='],
});

it('exports the router the suite mounts', () => {
  expect(warehouseLocationsRoutes.routes.length).toBeGreaterThan(0);
});
