/**
 * Every /api/inventory-movements route on pglite, through the shared CRUD
 * suite (../../test/crud-suite.ts); runs against Rust in conformance mode.
 * The table has no `deletedAt`: a delete removes the row.
 */

import { expect, it } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { inventoryMovementsRoutes } from './index';

describeCrud('/api/inventory-movements', {
  base: '/api/inventory-movements',
  routes: inventoryMovementsRoutes,
  table: schema.inventoryMovements,
  gates: { read: 'inventory:read', create: 'inventory:create', update: 'inventory:update', delete: 'inventory:delete' },
  seed: (n) => ({ movementNumber: `MV-${n}`, movementType: 'transfer', productId: 'prod_seed', quantity: n }),
  // movementNumber and movementType are NOT NULL and only reach the row as passthrough keys.
  valid: {
    productId: 'prod_1',
    quantity: 5,
    movementNumber: 'MV-NEW',
    movementType: 'relocation',
    type: 'not a column',
    reference: 'not a column',
    sourceWarehouseId: 'wh_a',
  },
  unstorable: [
    { productId: 'prod_1', quantity: 5 },
    { productId: 'prod_1', quantity: 5, movementNumber: 'MV-X', movementType: 'transfer', startedAt: '2026-01-01' },
  ],
  invalid: [{ productId: 'p' }, { quantity: 1.5 }, { quantity: 1, reference: 'x'.repeat(256) }, { quantity: '1' }],
  patches: [{ quantity: 9 }, { movementType: 'putaway', status: 'completed' }, { notes: 'moved', productId: 'prod_2' }],
  invalidPatch: { quantity: 'many' },
  unstorablePatch: { completedAt: '2026-01-01' },
  filters: [
    { query: 'productId=prod_filter', match: { productId: 'prod_filter' } },
    { query: 'warehouseId=wh_src', match: { sourceWarehouseId: 'wh_src' } },
    { query: 'warehouseId=wh_dst', match: { destWarehouseId: 'wh_dst' } },
  ],
  queries: ['productId=&warehouseId='],
  softDelete: false,
});

it('exports the router the suite mounts', () => {
  expect(inventoryMovementsRoutes.routes.length).toBeGreaterThan(0);
});
