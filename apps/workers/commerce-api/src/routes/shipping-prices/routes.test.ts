/**
 * Every /api/shipping-prices route on pglite (the shared suite in
 * ../../testing/shipping-crud-suite.ts). Runs against Rust in conformance mode.
 */

import { describe, expect, it, vi } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeShippingCrud } from '../../testing/shipping-crud-suite';
import { shippingPricesRoutes } from './index';

vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const crud = describeShippingCrud({
  base: '/api/shipping-prices',
  routes: shippingPricesRoutes,
  table: schema.shippingPrices,
  gates: { read: 'parcels:read', create: 'parcels:create', update: 'parcels:update', delete: 'parcels:delete' },
  resource: 'Shipping price',
  noun: { one: 'shipping price', many: 'shipping prices' },
  idPrefix: 'spr',
  entityType: 'shipping_price',
  seed: (n) => ({ name: `Price ${n}` }),
  detail: {
    name: 'Price 1',
    carrierId: null,
    serviceType: null,
    weightRanges: null,
    flatRate: null,
    percentageMarkup: null,
    currency: 'EUR',
    effectiveFrom: null,
    isActive: true,
  },
  valid: {
    body: {
      name: 'NL standard',
      carrierId: 'crr_1',
      currency: 'EUR',
      isActive: true,
      flatRate: { amount: 6.95, currency: 'EUR' },
      percentageMarkup: '10',
      fuelSurcharge: 2.25,
      serviceType: 'standard',
      price: 6.95,
    },
    stored: {
      name: 'NL standard',
      carrierId: 'crr_1',
      currency: 'EUR',
      isActive: true,
      flatRate: { amount: 6.95, currency: 'EUR' },
      percentageMarkup: '10.00',
      fuelSurcharge: '2.25',
      serviceType: 'standard',
    },
    event: { name: 'NL standard', carrierId: 'crr_1' },
  },
  // The schema allows 10 characters of currency, the column 3.
  unstorable: [{ name: 'Euro', currency: 'EURO' }],
  invalid: [
    {},
    { name: '' },
    { name: 'x', currency: 'x'.repeat(11) },
    { name: 'x', price: true },
    { name: 'x', carrierId: 1 },
    { name: 'x', isActive: 'true' },
  ],
  emptyBodyStatus: 400,
  patch: {
    target: { carrierId: 'crr_6' },
    body: { name: 'Renamed price', percentageMarkup: 12.5 },
    stored: { name: 'Renamed price', percentageMarkup: '12.50', carrierId: 'crr_6' },
    event: { name: 'Renamed price', carrierId: 'crr_6' },
  },
  invalidPatch: { name: '' },
  filters: [
    { query: 'carrierId=crr_needle', match: { carrierId: 'crr_needle' } },
    { query: 'search=Needle', match: { name: 'Needle rate' } },
  ],
  misses: ['search=needle', 'carrierId=crr_needle&search=Needle'],
  goneCursorCount: 'drops-last-condition',
});

describe('/api/shipping-prices · shipping price specifics', () => {
  it('PATCH /:id publishes the carrier it sets and the stored name', async () => {
    crud.clearEvents();
    const id = crud.seedId(1);
    const res = await crud
      .app('parcels:update')
      .request(`/api/shipping-prices/${id}`, crud.json({ carrierId: 'crr_next' }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(crud.published()).toEqual([
      { entityType: 'shipping_price', action: 'updated', entityId: id, data: { id, name: 'Price 1', carrierId: 'crr_next' } },
    ]);
  });
});
