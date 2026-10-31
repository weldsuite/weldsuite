/**
 * Every /api/boxes route on pglite, through the shared CRUD suite
 * (../../test/crud-suite.ts); runs against Rust in conformance mode.
 */

import { expect, it } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { boxesRoutes } from './index';

describeCrud('/api/boxes', {
  base: '/api/boxes',
  routes: boxesRoutes,
  table: schema.boxes,
  gates: { read: 'boxes:read', create: 'boxes:create', update: 'boxes:update', delete: 'boxes:delete' },
  seed: (n) => ({ name: `Box ${n}`, code: `BX-${n}`, length: '10', width: '10', height: '10' }),
  valid: {
    name: 'Medium Mailer',
    code: 'BX-M',
    length: 30,
    width: '20.5',
    height: 10,
    weight: 2,
    unit: 'cm',
    isActive: true,
    cost: { amount: 1, currency: 'EUR' },
  },
  unstorable: [
    { name: 'No size', code: 'BX-N' },
    { name: 'Dated', code: 'BX-D', length: 1, width: 1, height: 1, deletedAt: '2026-01-01T00:00:00.000Z' },
  ],
  invalid: [
    { name: '', code: 'X', length: 1, width: 1, height: 1 },
    { name: 'x', code: 'X', length: true },
    { name: 'x'.repeat(256), code: '' },
    { code: 'X', unit: 'x'.repeat(11) },
  ],
  patches: [{ name: 'Large Mailer', length: 40 }, { code: 'BX-L' }, { material: 'cardboard', metadata: null }],
  invalidPatch: { width: false },
  unstorablePatch: { updatedAt: '2026-01-01T00:00:00.000Z' },
  filters: [
    { query: 'search=Needle', match: { name: 'Needle box' } },
    { query: 'search=CODE-HAY', match: { code: 'CODE-HAY' } },
  ],
  queries: ['search='],
});

it('exports the router the suite mounts', () => {
  expect(boxesRoutes.routes.length).toBeGreaterThan(0);
});
