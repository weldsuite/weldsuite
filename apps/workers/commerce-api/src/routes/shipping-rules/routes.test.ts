/**
 * Every /api/shipping-rules route on pglite (the shared suite in
 * ../../testing/shipping-crud-suite.ts). Runs against Rust in conformance mode.
 */

import { describe, expect, it, vi } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeShippingCrud } from '../../testing/shipping-crud-suite';
import { shippingRulesRoutes } from './index';

vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const crud = describeShippingCrud({
  base: '/api/shipping-rules',
  routes: shippingRulesRoutes,
  table: schema.shippingRules,
  gates: { read: 'parcels:read', create: 'parcels:create', update: 'parcels:update', delete: 'parcels:delete' },
  resource: 'Shipping rule',
  noun: { one: 'shipping rule', many: 'shipping rules' },
  idPrefix: 'srul',
  entityType: 'shipping_rule',
  seed: (n) => ({ name: `Rule ${n}` }),
  detail: {
    name: 'Rule 1',
    description: null,
    isActive: true,
    priority: 0,
    conditions: null,
    conditionLogic: 'all',
    actions: null,
    usageCount: 0,
    lastUsedAt: null,
  },
  valid: {
    body: {
      name: 'Heavy parcels',
      conditions: [{ field: 'weight', operator: 'greater_than', value: 20 }],
      actions: [{ type: 'set_carrier', value: 'crr_1' }],
      priority: 1,
      isActive: true,
      conditionLogic: 'any',
      carrierId: 'not a column',
    },
    stored: {
      name: 'Heavy parcels',
      conditions: [{ field: 'weight', operator: 'greater_than', value: 20 }],
      actions: [{ type: 'set_carrier', value: 'crr_1' }],
      priority: 1,
      isActive: true,
      conditionLogic: 'any',
      usageCount: 0,
    },
    event: { name: 'Heavy parcels' },
  },
  unstorable: [{ name: 'Busy rule', usageCount: 'many' }],
  invalid: [{}, { name: '' }, { name: 'x'.repeat(256) }, { name: 'x', priority: 0.5 }, { name: 'x', carrierId: 3 }],
  emptyBodyStatus: 400,
  patch: {
    body: { name: 'Renamed rule', isActive: false, conditions: null },
    stored: { name: 'Renamed rule', isActive: false, conditions: null },
    event: { name: 'Renamed rule' },
  },
  invalidPatch: { isActive: 1 },
  filters: [{ query: 'search=Needle', match: { name: 'Needle rule' } }],
  misses: ['search=needle'],
  goneCursorCount: 'drops-last-condition',
});

describe('/api/shipping-rules · shipping rule specifics', () => {
  it('PATCH /:id without a name publishes the stored one', async () => {
    crud.clearEvents();
    const id = crud.seedId(1);
    const res = await crud.app('parcels:update').request(`/api/shipping-rules/${id}`, crud.json({ priority: 9 }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(await crud.detailOf(id)).toMatchObject({ name: 'Rule 1', priority: 9 });
    expect(crud.published()).toEqual([{ entityType: 'shipping_rule', action: 'updated', entityId: id, data: { id, name: 'Rule 1' } }]);
  });
});
