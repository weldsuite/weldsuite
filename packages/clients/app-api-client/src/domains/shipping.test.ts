import { describe, expect, it } from 'vitest';
import { createShippingApi } from './shipping';
import { RESPONSE, recordingApi, type DomainCase } from './recording-api.test-helper';

const CASES: DomainCase<ReturnType<typeof createShippingApi>>[] = [
  { name: 'getCatalog', call: (c) => c.getCatalog(), expected: { method: 'GET', path: '/carriers/catalog' } },
  { name: 'listCarriers', call: (c) => c.listCarriers(), expected: { method: 'GET', path: '/carriers' } },
  {
    name: 'createCarrier',
    call: (c) => c.createCarrier({ code: 'postnl', contract: 'own', credentials: { apiKey: 'k' } }),
    expected: { method: 'POST', path: '/carriers', body: { code: 'postnl', contract: 'own', credentials: { apiKey: 'k' } } },
  },
  {
    name: 'updateCarrier',
    call: (c) => c.updateCarrier('car_1', { isDefault: true }),
    expected: { method: 'PATCH', path: '/carriers/car_1', body: { isDefault: true } },
  },
  { name: 'deleteCarrier', call: (c) => c.deleteCarrier('car_1'), expected: { method: 'DELETE', path: '/carriers/car_1' } },
  { name: 'testCarrier', call: (c) => c.testCarrier('car_1'), expected: { method: 'POST', path: '/carriers/car_1/test', body: {} } },
  {
    name: 'listProducts',
    call: (c) => c.listProducts('car_1', { toCountry: 'NL', business: false }),
    expected: { method: 'GET', path: '/carriers/car_1/products?toCountry=NL&business=false' },
  },
  {
    name: 'listServicePoints',
    call: (c) => c.listServicePoints('car_1', { country: 'NL', postalCode: '1012LG', houseNumber: '', limit: 10 }),
    expected: { method: 'GET', path: '/carriers/car_1/service-points?country=NL&postalCode=1012LG&limit=10' },
  },
  {
    name: 'quote',
    call: (c) => c.quote('car_1', { toCountry: 'NL', pieces: [{ weightGrams: 500 }] }),
    expected: { method: 'POST', path: '/carriers/car_1/quote', body: { toCountry: 'NL', pieces: [{ weightGrams: 500 }] } },
  },
  { name: 'getPickListShipping', call: (c) => c.getPickListShipping('pl_1'), expected: { method: 'GET', path: '/pick-lists/pl_1/shipping' } },
  {
    name: 'createLabels',
    call: (c) => c.createLabels('pl_1', { pieces: [{ weightGrams: 800 }], returnLabel: true }),
    expected: { method: 'POST', path: '/pick-lists/pl_1/labels', body: { pieces: [{ weightGrams: 800 }], returnLabel: true } },
  },
  { name: 'voidLabels', call: (c) => c.voidLabels('pl_1'), expected: { method: 'DELETE', path: '/pick-lists/pl_1/labels' } },
  {
    name: 'listParcels',
    call: (c) => c.listParcels({ labelled: true, status: 'in_transit,delivered', limit: 50, search: '' }),
    expected: { method: 'GET', path: '/parcels?labelled=true&status=in_transit%2Cdelivered&limit=50' },
  },
  { name: 'getParcel', call: (c) => c.getParcel('par_1'), expected: { method: 'GET', path: '/parcels/par_1' } },
  { name: 'refreshTracking', call: (c) => c.refreshTracking('par_1'), expected: { method: 'POST', path: '/parcels/par_1/refresh-tracking', body: {} } },
  {
    name: 'createReturnLabel',
    call: (c) => c.createReturnLabel('par_1', { weightGrams: 900 }),
    expected: { method: 'POST', path: '/parcels/par_1/return-label', body: { weightGrams: 900 } },
  },
];

describe('createShippingApi', () => {
  for (const { name, call, expected } of CASES) {
    it(name, async () => {
      const { api, calls } = recordingApi();
      const result = await call(createShippingApi(api));
      expect(calls).toEqual([expected]);
      expect(result).toBe(RESPONSE);
    });
  }
});
