/**
 * Every /api/cycle-counts route on pglite, through the shared CRUD suite
 * (../../test/crud-suite.ts); runs against Rust in conformance mode.
 */

import { expect, it } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { cycleCountsRoutes } from './index';

describeCrud('/api/cycle-counts', {
  base: '/api/cycle-counts',
  routes: cycleCountsRoutes,
  table: schema.cycleCounts,
  gates: { read: 'inventory:read', create: 'inventory:create', update: 'inventory:update', delete: 'inventory:delete' },
  seed: (n) => ({ countNumber: `CC-${n}`, warehouseId: 'wh_seed' }),
  // countNumber is NOT NULL and not in the schema: only a passthrough key stores a row.
  valid: { warehouseId: 'wh_1', countNumber: 'CC-NEW', status: 'scheduled', notes: 'Aisle A', countedBy: 'not a column' },
  unstorable: [
    { warehouseId: 'wh_1', status: 'scheduled' },
    { warehouseId: 'wh_1', countNumber: 'CC-D', scheduledDate: '2026-02-01' },
    { warehouseId: null, countNumber: 'CC-N' },
  ],
  invalid: [{ status: 'x'.repeat(31) }, { warehouseId: 5 }, { notes: 1, scheduledDate: false }],
  patches: [{ status: 'in_progress' }, { notes: 'Recount', warehouseId: 'wh_2' }, { status: 'completed', assignedTo: 'u_1' }],
  invalidPatch: { status: 9 },
  unstorablePatch: { scheduledDate: '2026-02-01' },
  filters: [
    { query: 'warehouseId=wh_filter', match: { warehouseId: 'wh_filter' } },
    { query: 'status=completed', match: { status: 'completed' } },
  ],
  queries: ['warehouseId=', 'status=&warehouseId=wh_seed'],
});

it('exports the router the suite mounts', () => {
  expect(cycleCountsRoutes.routes.length).toBeGreaterThan(0);
});
