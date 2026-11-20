import { describe, expect, it } from 'vitest';
import { createPurchaseOrdersApi } from './purchase-orders';
import { RESPONSE, recordingApi, type DomainCase } from './recording-api.test-helper';

const CASES: DomainCase<ReturnType<typeof createPurchaseOrdersApi>>[] = [
  { name: 'list without params', call: (c) => c.list(), expected: { method: 'GET', path: '/purchase-orders' } },
  {
    name: 'list with filters',
    call: (c) => c.list({ limit: 50, cursor: 'abc', status: 'draft', supplierId: 'sup_1', search: 'ac me' }),
    expected: { method: 'GET', path: '/purchase-orders?limit=50&cursor=abc&status=draft&supplierId=sup_1&search=ac+me' },
  },
  { name: 'get', call: (c) => c.get('po1'), expected: { method: 'GET', path: '/purchase-orders/po1' } },
  {
    name: 'create',
    call: (c) => c.create({ supplierId: 'sup_1', currency: 'EUR' }),
    expected: { method: 'POST', path: '/purchase-orders', body: { supplierId: 'sup_1', currency: 'EUR' } },
  },
  {
    name: 'update',
    call: (c) => c.update('po1', { internalNotes: 'rush' }),
    expected: { method: 'PATCH', path: '/purchase-orders/po1', body: { internalNotes: 'rush' } },
  },
  { name: 'delete', call: (c) => c.delete('po1'), expected: { method: 'DELETE', path: '/purchase-orders/po1' } },
  { name: 'listLines', call: (c) => c.listLines('po1'), expected: { method: 'GET', path: '/purchase-orders/po1/items' } },
  {
    name: 'createLine',
    call: (c) => c.createLine('po1', { name: 'Widget', unitPrice: 2.5, quantityOrdered: 4 }),
    expected: { method: 'POST', path: '/purchase-orders/po1/items', body: { name: 'Widget', unitPrice: 2.5, quantityOrdered: 4 } },
  },
  {
    name: 'updateLine',
    call: (c) => c.updateLine('po1', 'it1', { quantityOrdered: 9 }),
    expected: { method: 'PATCH', path: '/purchase-orders/po1/items/it1', body: { quantityOrdered: 9 } },
  },
  { name: 'deleteLine', call: (c) => c.deleteLine('po1', 'it1'), expected: { method: 'DELETE', path: '/purchase-orders/po1/items/it1' } },
  { name: 'approve', call: (c) => c.approve('po1'), expected: { method: 'POST', path: '/purchase-orders/po1/approve', body: {} } },
  {
    name: 'markOrdered with dates',
    call: (c) => c.markOrdered('po1', { orderDate: '2026-11-01', expectedDate: '2026-11-15' }),
    expected: {
      method: 'POST',
      path: '/purchase-orders/po1/mark-ordered',
      body: { orderDate: '2026-11-01', expectedDate: '2026-11-15' },
    },
  },
  {
    name: 'markOrdered defaults to an empty body',
    call: (c) => c.markOrdered('po1'),
    expected: { method: 'POST', path: '/purchase-orders/po1/mark-ordered', body: {} },
  },
  {
    name: 'receive',
    call: (c) => c.receive('po1', { idempotencyKey: 'k1', lines: [{ itemId: 'it1', quantity: 3 }] }),
    expected: {
      method: 'POST',
      path: '/purchase-orders/po1/receive',
      body: { idempotencyKey: 'k1', lines: [{ itemId: 'it1', quantity: 3 }] },
    },
  },
  { name: 'cancel', call: (c) => c.cancel('po1'), expected: { method: 'POST', path: '/purchase-orders/po1/cancel', body: {} } },
  { name: 'close', call: (c) => c.close('po1'), expected: { method: 'POST', path: '/purchase-orders/po1/close', body: {} } },
  { name: 'listReceipts', call: (c) => c.listReceipts('po1'), expected: { method: 'GET', path: '/purchase-orders/po1/receipts' } },
  {
    name: 'sendToOdoo',
    call: (c) => c.sendToOdoo('po1'),
    expected: { method: 'POST', path: '/purchase-orders/po1/send-to-odoo', body: {} },
  },
];

describe('createPurchaseOrdersApi', () => {
  it.each(CASES)('$name sends the right request', async ({ call, expected }) => {
    const { api, calls } = recordingApi();
    const result = await call(createPurchaseOrdersApi(api));
    expect(calls).toEqual([expected]);
    expect(result).toBe(RESPONSE);
  });
});
