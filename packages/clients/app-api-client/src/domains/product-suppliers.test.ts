import { describe, expect, it } from 'vitest';
import { createProductSuppliersApi } from './product-suppliers';
import { RESPONSE, recordingApi, type DomainCase } from './recording-api.test-helper';

const CASES: DomainCase<ReturnType<typeof createProductSuppliersApi>>[] = [
  { name: 'list without params', call: (c) => c.list(), expected: { method: 'GET', path: '/product-suppliers' } },
  {
    name: 'list for a product without a variant',
    call: (c) => c.list({ productId: 'prod_1', variantId: 'none' }),
    expected: { method: 'GET', path: '/product-suppliers?productId=prod_1&variantId=none' },
  },
  {
    name: 'list for a supplier',
    call: (c) => c.list({ supplierId: 'sup_1' }),
    expected: { method: 'GET', path: '/product-suppliers?supplierId=sup_1' },
  },
  {
    name: 'create',
    call: (c) => c.create({ productId: 'prod_1', supplierId: 'sup_1', unitCost: 4.2, isPreferred: true }),
    expected: {
      method: 'POST',
      path: '/product-suppliers',
      body: { productId: 'prod_1', supplierId: 'sup_1', unitCost: 4.2, isPreferred: true },
    },
  },
  {
    name: 'update',
    call: (c) => c.update('ps1', { leadTimeDays: 10 }),
    expected: { method: 'PATCH', path: '/product-suppliers/ps1', body: { leadTimeDays: 10 } },
  },
  { name: 'delete', call: (c) => c.delete('ps1'), expected: { method: 'DELETE', path: '/product-suppliers/ps1' } },
];

describe('createProductSuppliersApi', () => {
  it.each(CASES)('$name sends the right request', async ({ call, expected }) => {
    const { api, calls } = recordingApi();
    const result = await call(createProductSuppliersApi(api));
    expect(calls).toEqual([expected]);
    expect(result).toBe(RESPONSE);
  });
});
