/**
 * Every /api/return-rules route on pglite (the shared suite in
 * ../../testing/shipping-crud-suite.ts). Runs against Rust in conformance mode.
 */

import { describe, expect, it, vi } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeShippingCrud } from '../../testing/shipping-crud-suite';
import { returnRulesRoutes } from './index';

vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const crud = describeShippingCrud({
  base: '/api/return-rules',
  routes: returnRulesRoutes,
  table: schema.returnRules,
  gates: { read: 'returns:read', create: 'returns:create', update: 'returns:update', delete: 'returns:delete' },
  resource: 'Return rule',
  noun: { one: 'return rule', many: 'return rules' },
  idPrefix: 'rrul',
  entityType: 'return_rule',
  seed: (n) => ({ name: `Rule ${n}` }),
  detail: {
    name: 'Rule 1',
    description: null,
    isActive: true,
    priority: 0,
    conditions: null,
    conditionLogic: 'all',
    actions: null,
    returnWindowDays: 30,
    usageCount: 0,
    lastUsedAt: null,
  },
  valid: {
    body: {
      name: 'Small orders',
      conditions: [{ field: 'total', operator: 'less_than', value: 50 }],
      actions: [{ type: 'auto_approve' }],
      priority: 2,
      isActive: true,
      returnWindowDays: 14,
      metadata: { source: 'test' },
    },
    stored: {
      name: 'Small orders',
      conditions: [{ field: 'total', operator: 'less_than', value: 50 }],
      actions: [{ type: 'auto_approve' }],
      priority: 2,
      isActive: true,
      returnWindowDays: 14,
      conditionLogic: 'all',
    },
    event: { name: 'Small orders' },
  },
  unstorable: [{ name: 'Two weeks', returnWindowDays: 'two weeks' }],
  invalid: [{}, { name: '' }, { name: 'x'.repeat(256) }, { name: 'x', priority: 1.5 }, { name: 'x', isActive: 'no' }],
  emptyBodyStatus: 400,
  patch: {
    body: { name: 'Renamed rule', priority: 5, conditionLogic: 'any' },
    stored: { name: 'Renamed rule', priority: 5, conditionLogic: 'any' },
    event: { name: 'Renamed rule' },
  },
  invalidPatch: { priority: 'high' },
  filters: [{ query: 'search=Needle', match: { name: 'Needle rule' } }],
  misses: ['search=needle'],
  goneCursorCount: 'drops-last-condition',
});

describe('/api/return-rules · return rule specifics', () => {
  it('PATCH /:id without a name publishes the stored one', async () => {
    crud.clearEvents();
    const id = crud.seedId(1);
    const res = await crud.app('returns:update').request(`/api/return-rules/${id}`, crud.json({ returnWindowDays: 60 }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(await crud.detailOf(id)).toMatchObject({ name: 'Rule 1', returnWindowDays: 60 });
    expect(crud.published()).toEqual([{ entityType: 'return_rule', action: 'updated', entityId: id, data: { id, name: 'Rule 1' } }]);
  });
});
