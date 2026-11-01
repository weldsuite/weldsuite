/**
 * Every /api/parcel-analytics route on pglite: the overview (status and
 * carrier breakdowns, shipment and return counts, the zeroed timeline) and a
 * carrier's performance, with their date windows and refusals. Runs against
 * Rust in conformance mode.
 *
 * The timeline holds the last seven days by today's date: only its shape is
 * asserted. The default window is the last 30 days, so the rows it should see
 * are seeded relative to now; the rest sit in March 2025.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { parcelAnalyticsRoutes } from './index';

const BASE = '/api/parcel-analytics';
const MARCH = 'dateFrom=2025-03-01T00:00:00.000Z&dateTo=2025-03-31T23:59:59.999Z';

let db: Database;

const app = (...keys: string[]) =>
  createTestApp(BASE, parcelAnalyticsRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });
const get = async (path: string) => {
  const res = await app('orders:read').request(`${BASE}${path}`);
  expect(res.status, path).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
};

const march = (day: number) => new Date(Date.UTC(2025, 2, day, 12));
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

type Carrier = { carrierId: string; carrierName: string; parcelCount: number; deliveredCount: number; averageDeliveryTime: number };
const byCarrier = (carriers: unknown) => [...(carriers as Carrier[])].sort((a, b) => a.carrierId.localeCompare(b.carrierId));

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const parcel = (id: string, createdAt: Date, status: string, carrierId: string | null, carrierName: string | null, deletedAt: Date | null = null) => ({
    id,
    createdAt,
    updatedAt: createdAt,
    deletedAt,
    status,
    carrierId,
    carrierName,
  });
  await db.insert(schema.parcels).values([
    parcel('par_a1', march(2), 'delivered', 'crr_a', 'DHL'),
    parcel('par_a2', march(3), 'delivered', 'crr_a', 'DHL'),
    parcel('par_a3', march(4), 'exception', 'crr_a', 'DHL'),
    parcel('par_b1', march(5), 'delivered', 'crr_b', 'PostNL'),
    parcel('par_b2', march(6), 'failed', 'crr_b', 'PostNL'),
    parcel('par_b3', march(7), 'failed', 'crr_b', 'PostNL'),
    parcel('par_b4', march(8), 'shipped', 'crr_b', 'PostNL'),
    parcel('par_b5', march(9), 'shipped', 'crr_b', 'PostNL'),
    parcel('par_b6', march(10), 'shipped', 'crr_b', 'PostNL'),
    parcel('par_n1', march(11), 'draft', null, null),
    parcel('par_n2', march(12), 'pending', null, null),
    parcel('par_n3', march(13), 'in_transit', null, null),
    parcel('par_gone', march(14), 'delivered', 'crr_a', 'DHL', march(20)),
    parcel('par_may', new Date(Date.UTC(2025, 4, 1)), 'delivered', 'crr_a', 'DHL'),
    parcel('par_c1', daysAgo(2), 'delivered', 'crr_c', 'GLS'),
    parcel('par_c2', daysAgo(1), 'pending', 'crr_c', 'GLS'),
  ]);
  const numbered = (prefix: string, id: string, createdAt: Date, deletedAt: Date | null = null) => ({
    id,
    createdAt,
    updatedAt: createdAt,
    deletedAt,
    [prefix]: `${id.toUpperCase()}`,
  });
  await db.insert(schema.shipments).values([
    numbered('shipmentNumber', 'shp_m1', march(2)),
    numbered('shipmentNumber', 'shp_m2', march(3)),
    numbered('shipmentNumber', 'shp_gone', march(4), march(5)),
    numbered('shipmentNumber', 'shp_may', new Date(Date.UTC(2025, 4, 1))),
    numbered('shipmentNumber', 'shp_now', daysAgo(1)),
  ] as (typeof schema.shipments.$inferInsert)[]);
  await db.insert(schema.returns).values([
    numbered('returnNumber', 'ret_m1', march(2)),
    numbered('returnNumber', 'ret_may', new Date(Date.UTC(2025, 4, 1))),
    numbered('returnNumber', 'ret_now', daysAgo(3)),
  ] as (typeof schema.returns.$inferInsert)[]);
}, 60_000);

describe('GET /api/parcel-analytics', () => {
  it('breaks the window down by status and carrier', async () => {
    const data = await get(`?${MARCH}`);
    expect(data.overview).toEqual({
      totalParcels: 12,
      totalShipments: 2,
      totalDelivered: 3,
      // in_transit + shipped
      totalInTransit: 4,
      // pending + draft
      totalPending: 2,
      totalReturns: 1,
      averageDeliveryTime: 0,
    });
    expect(data.costs).toEqual({ totalShippingCost: 0, averageShippingCost: 0, currency: 'EUR' });
    // Groups come back in the database's order: compared sorted.
    expect(byCarrier(data.carriers)).toEqual([
      { carrierId: 'crr_a', carrierName: 'DHL', parcelCount: 3, deliveredCount: 2, averageDeliveryTime: 0 },
      { carrierId: 'crr_b', carrierName: 'PostNL', parcelCount: 6, deliveredCount: 1, averageDeliveryTime: 0 },
      { carrierId: 'unknown', carrierName: 'Unknown', parcelCount: 3, deliveredCount: 0, averageDeliveryTime: 0 },
    ]);
    // The keys, not their order: the Rust backend writes them sorted.
    expect(Object.keys(data).sort()).toEqual(['carriers', 'costs', 'overview', 'timeline']);
  });

  it('answers a seven-day timeline of zeros', async () => {
    const data = await get(`?${MARCH}`);
    const timeline = data.timeline as Array<Record<string, unknown>>;
    expect(timeline).toHaveLength(7);
    for (const day of timeline) {
      expect(day).toEqual({
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        parcelsCreated: 0,
        parcelsDelivered: 0,
        totalCost: 0,
      });
    }
  });

  it('filters the parcels by carrier, not the shipments or returns', async () => {
    const data = await get(`?${MARCH}&carrierId=crr_b`);
    expect(data.overview).toEqual({
      totalParcels: 6,
      totalShipments: 2,
      totalDelivered: 1,
      totalInTransit: 3,
      totalPending: 0,
      totalReturns: 1,
      averageDeliveryTime: 0,
    });
    expect(data.carriers).toEqual([
      { carrierId: 'crr_b', carrierName: 'PostNL', parcelCount: 6, deliveredCount: 1, averageDeliveryTime: 0 },
    ]);
    const none = await get(`?${MARCH}&carrierId=crr_none`);
    expect(none.overview).toMatchObject({ totalParcels: 0, totalDelivered: 0, totalShipments: 2 });
    expect(none.carriers).toEqual([]);
  });

  it('defaults to the last 30 days, and dateTo to now', async () => {
    const recent = await get('');
    expect(recent.overview).toEqual({
      totalParcels: 2,
      totalShipments: 1,
      totalDelivered: 1,
      totalInTransit: 0,
      totalPending: 1,
      totalReturns: 1,
      averageDeliveryTime: 0,
    });
    expect(recent.carriers).toEqual([
      { carrierId: 'crr_c', carrierName: 'GLS', parcelCount: 2, deliveredCount: 1, averageDeliveryTime: 0 },
    ]);
    const sinceApril = await get('?dateFrom=2025-04-01');
    expect(sinceApril.overview).toMatchObject({ totalParcels: 3, totalDelivered: 2, totalShipments: 2, totalReturns: 2 });
  });

  it('an empty window answers zeros', async () => {
    const data = await get('?dateFrom=2020-01-01T00:00:00.000Z&dateTo=2020-01-02T00:00:00.000Z');
    expect(data.overview).toEqual({
      totalParcels: 0,
      totalShipments: 0,
      totalDelivered: 0,
      totalInTransit: 0,
      totalPending: 0,
      totalReturns: 0,
      averageDeliveryTime: 0,
    });
    expect(data.carriers).toEqual([]);
  });

  it('a date JavaScript cannot read is the route 500', async () => {
    const res = await app('orders:read').request(`${BASE}?dateFrom=not-a-date`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch analytics' } });
  });

  it('refuses a repeated query parameter (400) and a caller without orders:read (403)', async () => {
    expect((await app('orders:read').request(`${BASE}?carrierId=crr_a&carrierId=crr_b`)).status).toBe(400);
    expect((await app('orders:update').request(BASE)).status).toBe(403);
  });
});

describe('GET /api/parcel-analytics/carrier/:carrierId', () => {
  it('counts delivered and failed parcels and rounds the rate to one decimal', async () => {
    expect(await get(`/carrier/crr_a?${MARCH}`)).toEqual({
      carrierId: 'crr_a',
      totalParcels: 3,
      deliveredCount: 2,
      // `exception` and `failed` both count as failed.
      failedCount: 1,
      deliveryRate: 66.7,
      averageDeliveryTime: 0,
      totalCost: 0,
    });
    expect(await get(`/carrier/crr_b?${MARCH}`)).toEqual({
      carrierId: 'crr_b',
      totalParcels: 6,
      deliveredCount: 1,
      failedCount: 2,
      deliveryRate: 16.7,
      averageDeliveryTime: 0,
      totalCost: 0,
    });
  });

  it('defaults to the last 30 days; an unknown carrier is all zeros', async () => {
    expect(await get('/carrier/crr_c')).toMatchObject({ totalParcels: 2, deliveredCount: 1, failedCount: 0, deliveryRate: 50 });
    expect(await get('/carrier/crr_a')).toMatchObject({ totalParcels: 0, deliveryRate: 0 });
    expect(await get(`/carrier/crr_none?${MARCH}`)).toEqual({
      carrierId: 'crr_none',
      totalParcels: 0,
      deliveredCount: 0,
      failedCount: 0,
      deliveryRate: 0,
      averageDeliveryTime: 0,
      totalCost: 0,
    });
  });

  it('a date JavaScript cannot read is the route 500', async () => {
    const res = await app('orders:read').request(`${BASE}/carrier/crr_a?dateTo=31-03-2025`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch carrier performance' } });
  });

  it('refuses a repeated query parameter (400) and a caller without orders:read (403)', async () => {
    expect((await app('orders:read').request(`${BASE}/carrier/crr_a?dateFrom=a&dateFrom=b`)).status).toBe(400);
    expect((await app().request(`${BASE}/carrier/crr_a`)).status).toBe(403);
  });
});
