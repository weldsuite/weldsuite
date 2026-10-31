/**
 * Every /api/purchase-orders route on pglite, through the shared CRUD suite
 * (../../test/crud-suite.ts); runs against Rust in conformance mode.
 */

import { expect, it } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { purchaseOrdersRoutes } from './index';

describeCrud('/api/purchase-orders', {
  base: '/api/purchase-orders',
  routes: purchaseOrdersRoutes,
  table: schema.purchaseOrders,
  gates: { read: 'orders:read', create: 'orders:create', update: 'orders:update', delete: 'orders:delete' },
  seed: (n) => ({ poNumber: `PO-${n}`, supplierId: 'sup_seed' }),
  valid: {
    poNumber: 'PO-NEW',
    supplierId: 'sup_1',
    warehouseId: null,
    status: 'draft',
    total: 125.5,
    currency: 'EUR',
    notes: 'not a column',
    tags: ['urgent'],
  },
  unstorable: [
    { status: 'draft' },
    { poNumber: 'PO-D', orderDate: '2026-01-01' },
    { poNumber: 'PO-C', currency: 'EURO' },
  ],
  invalid: [{ poNumber: 'x'.repeat(101) }, { total: true }, { supplierId: 1 }, { currency: 'x'.repeat(11) }],
  patches: [
    { status: 'approved', total: '99.99' },
    { supplierId: null, poNumber: 'PO-RENAMED' },
    { supplierId: 'sup_2', internalNotes: 'call first' },
  ],
  invalidPatch: { status: false },
  unstorablePatch: { expectedDate: '2026-03-01' },
  filters: [
    { query: 'supplierId=sup_filter', match: { supplierId: 'sup_filter' } },
    { query: 'warehouseId=wh_filter', match: { warehouseId: 'wh_filter' } },
    { query: 'status=received', match: { status: 'received' } },
    { query: 'search=NEEDLE', match: { poNumber: 'PO-NEEDLE' } },
  ],
  queries: ['supplierId=&status=&warehouseId='],
});

it('exports the router the suite mounts', () => {
  expect(purchaseOrdersRoutes.routes.length).toBeGreaterThan(0);
});
