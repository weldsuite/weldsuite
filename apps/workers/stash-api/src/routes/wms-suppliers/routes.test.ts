/**
 * Every /api/wms-suppliers route on pglite, through the shared CRUD suite
 * (../../test/crud-suite.ts); runs against Rust in conformance mode.
 */

import { expect, it } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { wmsSuppliersRoutes } from './index';

describeCrud('/api/wms-suppliers', {
  base: '/api/wms-suppliers',
  routes: wmsSuppliersRoutes,
  table: schema.suppliers,
  gates: { read: 'suppliers:read', create: 'suppliers:create', update: 'suppliers:update', delete: 'suppliers:delete' },
  seed: (n) => ({ name: `Supplier ${n}`, code: `SUP-${n}` }),
  valid: {
    name: 'Acme Parts',
    code: 'ACME',
    email: 'orders@acme.test',
    isActive: false,
    rating: 4,
    defaultLeadTimeDays: 7,
    taxId: null,
    tags: ['metal', 'bolts'],
    metadata: { since: 2020 },
  },
  unstorable: [{ name: 'Slow', defaultLeadTimeDays: 3000000000 }],
  invalid: [
    { name: '' },
    { name: 'x', email: 'not-an-email' },
    { name: 'x', rating: 9 },
    { name: 'x', currency: 'EURO', tags: [1] },
    { email: 'a@b.co', rating: 0.5 },
  ],
  patches: [
    { name: 'Acme Two', isActive: true },
    { isActive: false, notes: 'paused' },
    { taxId: null, currency: 'EUR', tags: [] },
  ],
  invalidPatch: { email: 'nope' },
  filters: [
    { query: 'search=Needle', match: { name: 'Needle supplier' } },
    { query: 'search=hay%40stack.test', match: { email: 'hay@stack.test' } },
    { query: 'status=inactive', match: { status: 'inactive' } },
    { query: 'status=active', match: { status: 'active' } },
    { query: 'isActive=false', match: { isActive: false } },
  ],
  queries: ['status=blocked', 'isActive=true'],
});

it('exports the router the suite mounts', () => {
  expect(wmsSuppliersRoutes.routes.length).toBeGreaterThan(0);
});
