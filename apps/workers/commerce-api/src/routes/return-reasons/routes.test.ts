/**
 * Every /api/return-reasons route on pglite (the shared suite in
 * ../../testing/shipping-crud-suite.ts). Runs against Rust in conformance mode.
 *
 * The create schema (`name`, `description`, …) does not require the table's
 * NOT NULL `code` and `label`: they only get in as passthrough keys, and a body
 * without them is the route's 500.
 */

import { describe, expect, it, vi } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeShippingCrud } from '../../testing/shipping-crud-suite';
import { returnReasonsRoutes } from './index';

vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const crud = describeShippingCrud({
  base: '/api/return-reasons',
  routes: returnReasonsRoutes,
  table: schema.returnReasons,
  gates: { read: 'returns:read', create: 'returns:create', update: 'returns:update', delete: 'returns:delete' },
  resource: 'Return reason',
  noun: { one: 'return reason', many: 'return reasons' },
  idPrefix: 'rsn',
  entityType: 'return_reason',
  seed: (n) => ({ code: `R${n}`, label: `Reason ${n}` }),
  detail: {
    code: 'R1',
    label: 'Reason 1',
    description: null,
    groupId: null,
    displayOrder: 0,
    isActive: true,
    requiresPhotos: false,
    refundEligible: true,
    restockingFee: null,
    usageCount: 0,
    translations: null,
  },
  valid: {
    body: {
      code: 'DAMAGED',
      label: 'Damaged',
      groupId: 'rrg_1',
      description: 'Arrived broken',
      isActive: true,
      requiresPhotos: true,
      restockingFee: 5.5,
      translations: [{ locale: 'nl', label: 'Beschadigd' }],
      name: 'not a column',
    },
    stored: {
      code: 'DAMAGED',
      label: 'Damaged',
      groupId: 'rrg_1',
      description: 'Arrived broken',
      isActive: true,
      requiresPhotos: true,
      restockingFee: '5.50',
      translations: [{ locale: 'nl', label: 'Beschadigd' }],
      displayOrder: 0,
    },
    event: { label: 'Damaged', code: 'DAMAGED', groupId: 'rrg_1' },
  },
  unstorable: [{ name: 'Only a name' }, { code: 'NO_LABEL' }],
  invalid: [{ name: 5 }, { description: 1 }, { groupId: 7 }, { isActive: 'yes' }],
  // `{}` passes the schema; the table then misses its code.
  emptyBodyStatus: 500,
  patch: {
    target: { groupId: 'rrg_old' },
    body: { label: 'Relabelled', groupId: null, requiresPhotos: true },
    stored: { label: 'Relabelled', code: 'R6', groupId: null, requiresPhotos: true },
    // `data.groupId ?? existing.groupId`: a cleared group still reports the old one.
    event: { label: 'Relabelled', code: 'R6', groupId: 'rrg_old' },
  },
  invalidPatch: { isActive: 'no' },
  filters: [{ query: 'groupId=rrg_needle', match: { groupId: 'rrg_needle' } }],
  misses: ['groupId=rrg_none'],
  goneCursorCount: 'drops-last-condition',
});

describe('/api/return-reasons · return reason specifics', () => {
  it('POST / without a group publishes no groupId', async () => {
    crud.clearEvents();
    const res = await crud.app('returns:create').request('/api/return-reasons', crud.json({ code: 'LOST', label: 'Lost' }));
    expect(res.status).toBe(201);
    expect(crud.published()).toEqual([
      {
        entityType: 'return_reason',
        action: 'created',
        entityId: expect.stringMatching(/^rsn_/),
        data: { id: expect.stringMatching(/^rsn_/), label: 'Lost', code: 'LOST' },
      },
    ]);
  });

  it('PATCH /:id publishes the code as it was, even when it sets a new one', async () => {
    crud.clearEvents();
    const id = crud.seedId(1);
    const res = await crud.app('returns:update').request(`/api/return-reasons/${id}`, crud.json({ code: 'R1-NEW' }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(await crud.detailOf(id)).toMatchObject({ code: 'R1-NEW', label: 'Reason 1' });
    expect(crud.published()).toEqual([
      { entityType: 'return_reason', action: 'updated', entityId: id, data: { id, label: 'Reason 1', code: 'R1', groupId: null } },
    ]);
  });
});
