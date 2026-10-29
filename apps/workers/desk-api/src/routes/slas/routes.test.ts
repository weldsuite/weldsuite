/**
 * Every /api/slas route on pglite, through the shared CRUD suite
 * (../../test/crud-suite.ts); runs against Rust in conformance mode.
 */

import { expect, it } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { slasRoutes } from './index';

describeCrud('/api/slas', {
  base: '/api/slas',
  routes: slasRoutes,
  table: schema.helpdeskSlas,
  gates: { read: 'slas:read', create: 'slas:create', update: 'slas:update', delete: 'slas:delete' },
  seed: (n) => ({ name: `SLA ${n}` }),
  valid: { name: 'Gold', description: 'Fast', isActive: true, isDefault: false },
  unstorable: { name: 'Bad priority', priority: 'high' },
  invalid: [{ name: '' }, { name: 'x', responseTimeMinutes: 1.5 }, { name: 'x', priority: 'x'.repeat(21) }],
  patch: { name: 'Platinum', operationalHours: 'business' },
  invalidPatch: { isActive: 'yes' },
  filters: [{ query: 'search=Needle', match: { name: 'Needle SLA' } }],
});

it('exports the router the suite mounts', () => {
  expect(slasRoutes.routes.length).toBeGreaterThan(0);
});
