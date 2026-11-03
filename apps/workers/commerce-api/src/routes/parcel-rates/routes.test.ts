/**
 * Every /api/parcel-rates route on pglite: rate calculation over the stored
 * shipping prices (weight ranges, volumetric weight, markup, handling fee,
 * fuel surcharge, rounding), selecting a rate for a parcel, and the active
 * carriers. Runs against Rust in conformance mode.
 *
 * `POST /select` publishes no entity event (an action, not a lifecycle).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { parcelRatesRoutes } from './index';

const BASE = '/api/parcel-rates';
const { carriers, shippingPrices, parcels } = schema;

let db: Database;

const app = (...keys: string[]) =>
  createTestApp(BASE, parcelRatesRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const parcelOf = async (id: string) => (await db.select().from(parcels).where(eq(parcels.id, id)).limit(1))[0];

/** A calculate body for `weight` kg in a `size` cm cube… or box. */
const quote = (weight: number, [length, width, height]: [number, number, number]) => ({
  origin: { country: 'NL', postalCode: '5611EM' },
  destination: { country: 'BE', postalCode: '1000' },
  parcel: { weight: { value: weight, unit: 'kg' }, dimensions: { length, width, height, unit: 'cm' } },
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = new Date(Date.UTC(2026, 0, 1));
  await db.insert(carriers).values([
    { id: 'crr_dhl', name: 'DHL', code: 'DHL', logo: 'https://cdn.example/dhl.png', createdAt: at, updatedAt: at },
    { id: 'crr_post', name: 'PostNL', code: 'POSTNL', createdAt: at, updatedAt: at },
    { id: 'crr_off', name: 'Off', code: 'OFF', isActive: false, createdAt: at, updatedAt: at },
    { id: 'crr_del', name: 'Deleted', code: 'DEL', deletedAt: at, createdAt: at, updatedAt: at },
  ]);
  await db.insert(shippingPrices).values([
    {
      id: 'spr_flat',
      name: 'PostNL standard',
      carrierId: 'crr_post',
      serviceType: 'standard',
      flatRate: { amount: 5.5, currency: 'EUR' },
      weightRanges: [
        { minWeight: 0, maxWeight: 1, price: { amount: 3, currency: 'EUR' } },
        // A range whose price is 0 keeps the flat rate.
        { minWeight: 3, maxWeight: 4, price: { amount: 0, currency: 'EUR' } },
      ],
    },
    {
      id: 'spr_range',
      name: 'DHL express',
      carrierId: 'crr_dhl',
      serviceType: 'express',
      currency: 'USD',
      flatRate: { amount: 20, currency: 'USD' },
      weightRanges: [
        { minWeight: 0, maxWeight: 2, price: { amount: 7.5, currency: 'USD' } },
        { minWeight: 2, maxWeight: 10, price: { amount: 12, currency: 'USD' } },
        // maxWeight 0 is no upper bound.
        { minWeight: 10, maxWeight: 0, price: { amount: 30, currency: 'USD' } },
      ],
      percentageMarkup: '10',
      handlingFee: { amount: 1.5, currency: 'USD' },
      fuelSurcharge: '5',
    },
    { id: 'spr_nosvc', name: 'DHL bare', carrierId: 'crr_dhl', currency: null },
    { id: 'spr_inactive', name: 'Inactive', carrierId: 'crr_dhl', isActive: false, flatRate: { amount: 1, currency: 'EUR' } },
    { id: 'spr_offcarrier', name: 'Inactive carrier', carrierId: 'crr_off', flatRate: { amount: 2, currency: 'EUR' } },
    { id: 'spr_delcarrier', name: 'Deleted carrier', carrierId: 'crr_del', serviceType: 'economy', flatRate: { amount: 4, currency: 'GBP' } },
    { id: 'spr_nocarrier', name: 'No carrier', flatRate: { amount: 2.5, currency: 'EUR' } },
    { id: 'spr_gone', name: 'Gone', carrierId: 'crr_dhl', deletedAt: at },
  ]);
  await db.insert(parcels).values([
    { id: 'par_one', trackingNumber: 'TRK-1' },
    { id: 'par_two', trackingNumber: 'TRK-2', carrierId: 'crr_old', carrierName: 'Old', serviceType: 'old', shippingCost: { amount: 1, currency: 'EUR' } },
    { id: 'par_three', trackingNumber: 'TRK-3', carrierId: 'crr_old', carrierName: 'Old' },
    { id: 'par_gone', trackingNumber: 'TRK-4', deletedAt: at },
  ]);
}, 60_000);

describe('POST /api/parcel-rates/calculate', () => {
  const rates = async (body: unknown) => {
    const res = await app('orders:read').request(`${BASE}/calculate`, json(body));
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: unknown[] }).data;
  };
  const bare = { id: 'spr_nosvc-standard', carrier: 'DHL', service: 'standard', amount: 0, currency: 'EUR' };
  const postnl = (amount: number) => ({ id: 'spr_flat-standard', carrier: 'PostNL', service: 'standard', amount, currency: 'EUR' });
  const dhl = (amount: number) => ({ id: 'spr_range-express', carrier: 'DHL', service: 'express', amount, currency: 'USD' });

  it('prices the active prices of active carriers, cheapest first', async () => {
    // 1.5 kg: DHL's first range, (7.5 × 1.10 + 1.5) × 1.05 = 10.2375 → 10.24; PostNL's flat rate.
    expect(await rates(quote(1.5, [20, 15, 10]))).toEqual([bare, postnl(5.5), dhl(10.24)]);
  });

  it('charges the volumetric weight when it is the larger one', async () => {
    // 50 × 40 × 30 / 5000 = 12 kg: DHL's open-ended range, (30 × 1.1 + 1.5) × 1.05 = 36.225 → 36.23.
    expect(await rates(quote(1, [50, 40, 30]))).toEqual([bare, postnl(5.5), dhl(36.23)]);
  });

  it('a matching range overrides the flat rate unless its price is 0', async () => {
    expect(await rates(quote(0.5, [10, 10, 10]))).toEqual([bare, postnl(3), dhl(10.24)]);
    // 3.5 kg: PostNL's 0-priced range keeps 5.5; DHL's second range (12 × 1.1 + 1.5) × 1.05 = 15.435 → 15.44.
    expect(await rates(quote(3.5, [10, 10, 10]))).toEqual([bare, postnl(5.5), dhl(15.44)]);
  });

  it('refuses an invalid body (400) and a caller without orders:read (403)', async () => {
    const { request } = app('orders:read');
    const valid = quote(1, [10, 10, 10]);
    for (const body of [
      {},
      { ...valid, origin: { country: 'NL' } },
      { ...valid, parcel: { ...valid.parcel, weight: { value: 0 } } },
      { ...valid, parcel: { ...valid.parcel, dimensions: { length: 1, width: 1, height: -1 } } },
      { ...valid, parcel: { ...valid.parcel, weight: { value: '2' } } },
    ]) {
      expect((await request(`${BASE}/calculate`, json(body))).status, JSON.stringify(body)).toBe(400);
    }
    // Units default when left out.
    const noUnits = { ...valid, parcel: { weight: { value: 1 }, dimensions: { length: 10, width: 10, height: 10 } } };
    expect((await request(`${BASE}/calculate`, json(noUnits))).status).toBe(200);
    expect((await app('orders:update').request(`${BASE}/calculate`, json(valid))).status).toBe(403);
  });
});

describe('POST /api/parcel-rates/select', () => {
  const select = async (rateId: string, parcelId: string) => {
    const res = await app('orders:update').request(`${BASE}/select`, json({ rateId, parcelId }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("puts the price's carrier, service and flat rate on the parcel", async () => {
    expect(await select('spr_range-express', 'par_one')).toEqual({
      status: 200,
      body: { data: { parcelId: 'par_one', rateId: 'spr_range-express', carrier: 'DHL', service: 'express' } },
    });
    expect(await parcelOf('par_one')).toMatchObject({
      carrierId: 'crr_dhl',
      carrierName: 'DHL',
      serviceType: 'express',
      shippingCost: { amount: 20, currency: 'USD' },
    });
  });

  it("a rate id without a dash takes the price's service, null in the answer", async () => {
    // No flat rate: the parcel keeps its shipping cost; no service type: 'standard' on the parcel.
    expect(await select('spr_nosvc', 'par_two')).toEqual({
      status: 200,
      body: { data: { parcelId: 'par_two', rateId: 'spr_nosvc', carrier: 'DHL', service: null } },
    });
    expect(await parcelOf('par_two')).toMatchObject({
      carrierId: 'crr_dhl',
      carrierName: 'DHL',
      serviceType: 'standard',
      shippingCost: { amount: 1, currency: 'EUR' },
    });
  });

  it('a price without a carrier leaves the carrier alone and answers none', async () => {
    // Everything after the first dash is the service.
    expect(await select('spr_nocarrier-same-day', 'par_three')).toEqual({
      status: 200,
      body: { data: { parcelId: 'par_three', rateId: 'spr_nocarrier-same-day', service: 'same-day' } },
    });
    expect(await parcelOf('par_three')).toMatchObject({
      carrierId: 'crr_old',
      carrierName: 'Old',
      serviceType: 'same-day',
      shippingCost: { amount: 2.5, currency: 'EUR' },
    });
  });

  it("names a deleted carrier, and doesn't check the parcel exists", async () => {
    expect(await select('spr_delcarrier-', 'par_missing')).toEqual({
      status: 200,
      body: { data: { parcelId: 'par_missing', rateId: 'spr_delcarrier-', carrier: 'Deleted', service: '' } },
    });
    // A deleted parcel is left as it was.
    expect((await select('spr_range-express', 'par_gone')).status).toBe(200);
    expect(await parcelOf('par_gone')).toMatchObject({ carrierId: null, serviceType: null });
  });

  it('404 for a missing or deleted price; 400 for a bad body; 403 without orders:update', async () => {
    expect(await select('spr_missing-standard', 'par_one')).toEqual({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: "Rate with ID 'spr_missing-standard' not found" } },
    });
    expect((await select('spr_gone', 'par_one')).status).toBe(404);
    const { request } = app('orders:update');
    expect((await request(`${BASE}/select`, json({ rateId: 'spr_flat' }))).status).toBe(400);
    expect((await request(`${BASE}/select`, json({ rateId: 1, parcelId: 'par_one' }))).status).toBe(400);
    expect((await app('orders:read').request(`${BASE}/select`, json({ rateId: 'spr_flat', parcelId: 'par_one' }))).status).toBe(403);
  });
});

describe('GET /api/parcel-rates/carriers', () => {
  it('lists the active, live carriers', async () => {
    const res = await app('orders:read').request(`${BASE}/carriers`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string }> };
    expect([...data].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'crr_dhl', name: 'DHL', code: 'DHL', logo: 'https://cdn.example/dhl.png' },
      { id: 'crr_post', name: 'PostNL', code: 'POSTNL', logo: null },
    ]);
  });

  it('needs orders:read', async () => {
    expect((await app('carriers:read').request(`${BASE}/carriers`)).status).toBe(403);
  });
});
