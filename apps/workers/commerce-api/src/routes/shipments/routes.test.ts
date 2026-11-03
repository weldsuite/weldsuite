/**
 * Every /api/shipments route on pglite (the shared suite in
 * ../../testing/shipping-crud-suite.ts). Runs against Rust in conformance mode.
 *
 * The table's NOT NULL `shipment_number` is not in the create schema: it only
 * gets in as a passthrough key, and a body without it is the route's 500.
 */

import { describe, expect, it, vi } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeShippingCrud } from '../../testing/shipping-crud-suite';
import { shipmentsRoutes } from './index';

vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const crud = describeShippingCrud({
  base: '/api/shipments',
  routes: shipmentsRoutes,
  table: schema.shipments,
  gates: { read: 'parcels:read', create: 'parcels:create', update: 'parcels:update', delete: 'parcels:delete' },
  resource: 'Shipment',
  noun: { one: 'shipment', many: 'shipments' },
  idPrefix: 'shp',
  entityType: 'shipment',
  seed: (n) => ({ shipmentNumber: `SHP-${n}` }),
  detail: {
    shipmentNumber: 'SHP-1',
    status: 'draft',
    type: 'outbound',
    parcelIds: null,
    totalParcels: 0,
    carrierId: null,
    totalWeight: null,
    totalCost: null,
    shippedAt: null,
  },
  valid: {
    body: {
      shipmentNumber: 'SHP-NEW',
      carrierId: 'crr_1',
      status: 'pending',
      totalWeight: 2.5,
      totalCost: { amount: 9.95, currency: 'EUR' },
      parcelIds: ['par_1'],
      trackingNumber: 'not a column',
      cost: 9.95,
    },
    stored: {
      shipmentNumber: 'SHP-NEW',
      carrierId: 'crr_1',
      status: 'pending',
      totalWeight: '2.500',
      totalCost: { amount: 9.95, currency: 'EUR' },
      parcelIds: ['par_1'],
      type: 'outbound',
      totalParcels: 0,
    },
    event: { carrierId: 'crr_1', status: 'pending' },
  },
  unstorable: [{ carrierId: 'crr_1' }, { shipmentNumber: 'SHP-X', type: 'x'.repeat(21) }],
  invalid: [
    { carrierId: 5 },
    { status: 'x'.repeat(31) },
    { cost: true },
    { currency: 'x'.repeat(11) },
    { reference: 'x'.repeat(256) },
    { trackingNumber: 'x'.repeat(256) },
  ],
  emptyBodyStatus: 500,
  patch: {
    target: { carrierId: 'crr_6' },
    body: { status: 'shipped', carrierId: null, totalWeight: '1.2' },
    stored: { status: 'shipped', carrierId: null, totalWeight: '1.200' },
    // `data.carrierId ?? existing.carrierId`: a cleared carrier still reports the old one.
    event: { carrierId: 'crr_6', status: 'shipped' },
  },
  invalidPatch: { cost: [] },
  filters: [
    { query: 'carrierId=crr_needle', match: { carrierId: 'crr_needle' } },
    { query: 'status=shipped', match: { status: 'shipped' } },
  ],
  misses: ['carrierId=crr_needle&status=shipped'],
  goneCursorCount: 'drops-last-condition',
});

describe('/api/shipments · shipment specifics', () => {
  it('PATCH /:id publishes the carrier it sets', async () => {
    crud.clearEvents();
    const id = crud.seedId(1);
    const res = await crud.app('parcels:update').request(`/api/shipments/${id}`, crud.json({ carrierId: 'crr_next' }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(crud.published()).toEqual([
      { entityType: 'shipment', action: 'updated', entityId: id, data: { id, carrierId: 'crr_next', status: 'draft' } },
    ]);
  });
});
