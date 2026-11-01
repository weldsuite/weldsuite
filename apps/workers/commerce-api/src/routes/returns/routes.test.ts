/**
 * Every /api/returns route on pglite (the shared suite in
 * ../../testing/shipping-crud-suite.ts). Runs against Rust in conformance mode.
 *
 * The table's NOT NULL `return_number` is not in the create schema: it only
 * gets in as a passthrough key, and a body without it is the route's 500.
 */

import { describe, expect, it, vi } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeShippingCrud } from '../../testing/shipping-crud-suite';
import { returnsRoutes } from './index';

vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const crud = describeShippingCrud({
  base: '/api/returns',
  routes: returnsRoutes,
  table: schema.returns,
  gates: { read: 'returns:read', create: 'returns:create', update: 'returns:update', delete: 'returns:delete' },
  resource: 'Return',
  noun: { one: 'return', many: 'returns' },
  idPrefix: 'ret',
  entityType: 'return',
  seed: (n) => ({ returnNumber: `RET-${n}` }),
  detail: {
    returnNumber: 'RET-1',
    status: 'requested',
    customerId: null,
    items: null,
    refundAmount: null,
    returnMethod: 'label',
    approvalStatus: 'pending',
    approvedAt: null,
  },
  valid: {
    body: {
      returnNumber: 'RET-NEW',
      customerId: 'cus_1',
      status: 'requested',
      reason: 'size',
      customerName: 'Ann',
      items: [{ productName: 'Shirt', quantity: 1 }],
      refundAmount: 12.5,
      reasonText: 'not a column',
      orderId: 'not a column either',
    },
    stored: {
      returnNumber: 'RET-NEW',
      customerId: 'cus_1',
      status: 'requested',
      reason: 'size',
      customerName: 'Ann',
      items: [{ productName: 'Shirt', quantity: 1 }],
      // A jsonb column: the number as sent.
      refundAmount: 12.5,
      returnMethod: 'label',
      approvalStatus: 'pending',
    },
    event: { customerId: 'cus_1', status: 'requested' },
  },
  unstorable: [{ customerId: 'cus_1' }],
  invalid: [{ customerId: 5 }, { status: 'x'.repeat(31) }, { refundAmount: true }, { reasonText: 1 }, { reasonId: 2 }],
  emptyBodyStatus: 500,
  patch: {
    target: { customerId: 'cus_6' },
    body: { status: 'approved', approvedBy: 'user_1', refundAmount: '19.99' },
    // jsonb keeps the string "19.99", but Drizzle JSON.parses a jsonb string on
    // read when it can: the row answers the number.
    stored: { status: 'approved', approvedBy: 'user_1', refundAmount: 19.99, customerId: 'cus_6' },
    event: { customerId: 'cus_6', status: 'approved' },
  },
  invalidPatch: { refundAmount: { amount: 1 } },
  filters: [
    { query: 'customerId=cus_needle', match: { customerId: 'cus_needle' } },
    { query: 'status=approved', match: { status: 'approved' } },
  ],
  misses: ['status=refunded'],
  goneCursorCount: 'drops-last-condition',
});

describe('/api/returns · return specifics', () => {
  it('a jsonb string reads back parsed when it is JSON, as sent when it is not', async () => {
    const id = crud.seedId(1);
    const { request } = crud.app('returns:update');
    expect((await request(`/api/returns/${id}`, crud.json({ refundAmount: 'about 12' }, 'PATCH'))).status).toBe(200);
    expect(await crud.detailOf(id)).toMatchObject({ refundAmount: 'about 12' });
    expect((await request(`/api/returns/${id}`, crud.json({ refundAmount: '{"amount":5}' }, 'PATCH'))).status).toBe(200);
    expect(await crud.detailOf(id)).toMatchObject({ refundAmount: { amount: 5 } });
  });
});
