/**
 * Every /api/warehouses route on pglite, through the shared CRUD suite
 * (../../test/crud-suite.ts); runs against Rust in conformance mode.
 */

import { expect, it } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { warehousesRoutes } from './index';

describeCrud('/api/warehouses', {
  base: '/api/warehouses',
  routes: warehousesRoutes,
  table: schema.warehouses,
  gates: { read: 'warehouses:read', create: 'warehouses:create', update: 'warehouses:update', delete: 'warehouses:delete' },
  seed: (n) => ({ name: `Warehouse ${n}`, code: `WH-${n}` }),
  valid: {
    name: 'Main Warehouse',
    code: 'WH-MAIN',
    isActive: true,
    address: { line1: 'not a column' },
    metadata: { region: 'eu' },
    city: 'Eindhoven',
    priority: 2,
    tags: ['a', 'b'],
  },
  unstorable: [{ name: 'Dated', receivedAt: 'x', deletedAt: '2026-01-01' }],
  invalid: [{ name: '' }, { code: 'WH' }, { name: 'x', isActive: 'yes' }, { name: 'x', code: 'x'.repeat(51) }],
  patches: [{ name: 'North', isActive: false }, { code: 'WH-N' }, { city: 'Delft', metadata: { a: 1 } }],
  invalidPatch: { name: 7 },
  unstorablePatch: { updatedAt: '2026-01-01T00:00:00.000Z' },
  filters: [
    { query: 'search=Needle', match: { name: 'Needle warehouse' } },
    { query: 'search=WH-HAY', match: { code: 'WH-HAY' } },
  ],
});

it('exports the router the suite mounts', () => {
  expect(warehousesRoutes.routes.length).toBeGreaterThan(0);
});
