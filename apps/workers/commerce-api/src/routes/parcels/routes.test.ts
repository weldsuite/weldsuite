/**
 * Every /api/parcels route on pglite (the shared suite in
 * ../../testing/shipping-crud-suite.ts). Runs against Rust in conformance mode.
 *
 * Unlike the other shipping lists, parcels counts with its filters alone, so a
 * cursor whose row is gone leaves the count right.
 */

import { describe, expect, it, vi } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeShippingCrud } from '../../testing/shipping-crud-suite';
import { parcelsRoutes } from './index';

vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const crud = describeShippingCrud({
  base: '/api/parcels',
  routes: parcelsRoutes,
  table: schema.parcels,
  gates: { read: 'parcels:read', create: 'parcels:create', update: 'parcels:update', delete: 'parcels:delete' },
  resource: 'Parcel',
  noun: { one: 'parcel', many: 'parcels' },
  idPrefix: 'par',
  entityType: 'parcel',
  seed: (n) => ({ trackingNumber: `TRK-${n}` }),
  detail: {
    trackingNumber: 'TRK-1',
    referenceNumber: null,
    status: 'draft',
    statusHistory: null,
    weight: null,
    weightUnit: 'kg',
    packageType: 'parcel',
    signatureRequired: false,
    isReturn: false,
    shippedAt: null,
    tags: null,
  },
  valid: {
    body: {
      trackingNumber: '3SABC123',
      referenceNumber: 'ORD-1001',
      carrierId: 'crr_1',
      shipmentId: 'shp_1',
      status: 'pending',
      weight: 1.25,
      weightUnit: 'kg',
      dimensions: { length: 30, width: 20, height: 10, unit: 'cm' },
      recipientName: 'Ann',
      metadata: { source: 'not a column' },
    },
    stored: {
      trackingNumber: '3SABC123',
      referenceNumber: 'ORD-1001',
      carrierId: 'crr_1',
      shipmentId: 'shp_1',
      status: 'pending',
      weight: '1.250',
      weightUnit: 'kg',
      dimensions: { length: 30, width: 20, height: 10, unit: 'cm' },
      recipientName: 'Ann',
      packageType: 'parcel',
      isReturn: false,
    },
    event: { trackingNumber: '3SABC123', referenceNumber: 'ORD-1001', status: 'pending', carrierId: 'crr_1' },
  },
  // The schema allows 10 characters of weight unit, the column 5.
  unstorable: [{ weightUnit: 'pounds' }],
  invalid: [
    { trackingNumber: 'x'.repeat(101) },
    { referenceNumber: 1 },
    { status: 'x'.repeat(31) },
    { weight: true },
    { carrierId: 1 },
    { shipmentId: 2 },
  ],
  // Every column has a default or is nullable: `{}` is a parcel.
  emptyBodyStatus: 201,
  patch: {
    target: { carrierId: 'crr_6' },
    body: { status: 'shipped', weight: '2.5' },
    stored: { status: 'shipped', weight: '2.500', trackingNumber: 'TRK-6', carrierId: 'crr_6' },
    event: { trackingNumber: 'TRK-6', status: 'shipped', carrierId: 'crr_6' },
  },
  invalidPatch: { weight: false },
  filters: [
    { query: 'carrierId=crr_needle', match: { carrierId: 'crr_needle' } },
    { query: 'shipmentId=shp_needle', match: { shipmentId: 'shp_needle' } },
    { query: 'status=delivered', match: { status: 'delivered' } },
    { query: 'search=NEEDLE-1', match: { trackingNumber: 'NEEDLE-1' } },
    { query: 'search=REF-NEEDLE', match: { referenceNumber: 'REF-NEEDLE' } },
  ],
  misses: ['search=needle-1', 'carrierId=crr_needle&status=delivered'],
  goneCursorCount: 'filters',
});

describe('/api/parcels · parcel specifics', () => {
  it('POST / with {} stores a draft parcel and publishes only its id', async () => {
    crud.clearEvents();
    const res = await crud.app('parcels:create').request('/api/parcels', crud.json({}));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(await crud.detailOf(data.id)).toMatchObject({ status: 'draft', weightUnit: 'kg', trackingNumber: null });
    expect(crud.published()).toEqual([
      { entityType: 'parcel', action: 'created', entityId: expect.stringMatching(/^par_/), data: { id: expect.stringMatching(/^par_/) } },
    ]);
  });

  it('PATCH /:id publishes the stored tracking number, status and carrier, not the reference', async () => {
    crud.clearEvents();
    const id = crud.seedId(1);
    const res = await crud.app('parcels:update').request(`/api/parcels/${id}`, crud.json({ referenceNumber: 'REF-1' }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(crud.published()).toEqual([
      { entityType: 'parcel', action: 'updated', entityId: id, data: { id, trackingNumber: 'TRK-1', status: 'draft', carrierId: null } },
    ]);
  });
});
