/**
 * Every /api/pickups route on pglite (the shared suite in
 * ../../testing/shipping-crud-suite.ts). Runs against Rust in conformance mode.
 *
 * `POST /` can never store a pickup: the table's `pickup_date` is NOT NULL
 * without a default, and a date sent in JSON stays a string, which Drizzle's
 * timestamp column can't write (`value.toISOString is not a function`).
 */

import { describe, expect, it, vi } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeShippingCrud } from '../../testing/shipping-crud-suite';
import { pickupsRoutes } from './index';

vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const crud = describeShippingCrud({
  base: '/api/pickups',
  routes: pickupsRoutes,
  table: schema.pickups,
  gates: { read: 'pickups:read', create: 'pickups:create', update: 'pickups:update', delete: 'pickups:delete' },
  resource: 'Pickup',
  noun: { one: 'pickup', many: 'pickups' },
  idPrefix: 'pup',
  entityType: 'parcel_pickup',
  seed: (n) => ({ pickupNumber: `PU-${n}`, carrierId: 'crr_seed', pickupDate: new Date(Date.UTC(2026, 1, 1, 9)) }),
  detail: {
    pickupNumber: 'PU-1',
    status: 'scheduled',
    carrierId: 'crr_seed',
    carrierName: null,
    pickupDate: '2026-02-01T09:00:00.000Z',
    timeWindow: null,
    totalParcels: 0,
    totalWeight: null,
    confirmedAt: null,
  },
  unstorable: [
    { pickupNumber: 'PU-NEW', carrierId: 'crr_1', pickupDate: '2026-02-01T09:00:00.000Z', status: 'scheduled' },
    { pickupNumber: 'PU-NEW', carrierId: 'crr_1', scheduledAt: '2026-02-01T09:00:00.000Z' },
  ],
  invalid: [{ carrierId: 5 }, { warehouseId: 1 }, { status: 'x'.repeat(31) }, { notes: 1 }, { scheduledAt: 7 }],
  emptyBodyStatus: 500,
  patch: {
    body: { status: 'confirmed', confirmationNumber: 'CONF-1', notes: 'not a column' },
    stored: { status: 'confirmed', confirmationNumber: 'CONF-1', carrierId: 'crr_seed' },
    event: { carrierId: 'crr_seed', status: 'confirmed' },
  },
  invalidPatch: { status: 'x'.repeat(31) },
  filters: [
    { query: 'carrierId=crr_needle', match: { carrierId: 'crr_needle' } },
    { query: 'status=confirmed', match: { status: 'confirmed' } },
  ],
  misses: ['carrierId=crr_needle&status=confirmed'],
  goneCursorCount: 'drops-last-condition',
});

describe('/api/pickups · pickup specifics', () => {
  it('PATCH /:id moves the pickup to another carrier and publishes it', async () => {
    crud.clearEvents();
    const id = crud.seedId(1);
    const res = await crud.app('pickups:update').request(`/api/pickups/${id}`, crud.json({ carrierId: 'crr_next' }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(crud.published()).toEqual([
      { entityType: 'parcel_pickup', action: 'updated', entityId: id, data: { id, carrierId: 'crr_next', status: 'scheduled' } },
    ]);
  });

  it('PATCH /:id with a pickupDate is the route 500: a JSON date is a string', async () => {
    const id = crud.seedId(1);
    const res = await crud
      .app('pickups:update')
      .request(`/api/pickups/${id}`, crud.json({ pickupDate: '2026-03-01T09:00:00.000Z' }, 'PATCH'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update pickup' } });
    expect(await crud.detailOf(id)).toMatchObject({ pickupDate: '2026-02-01T09:00:00.000Z', carrierId: 'crr_next' });
  });
});
