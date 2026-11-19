import { describe, expect, it } from 'vitest';
import { createReplenishmentApi } from './replenishment';
import { RESPONSE, recordingApi, type DomainCase } from './recording-api.test-helper';

const CASES: DomainCase<ReturnType<typeof createReplenishmentApi>>[] = [
  { name: 'getSettings', call: (c) => c.getSettings(), expected: { method: 'GET', path: '/replenishment/settings' } },
  {
    name: 'updateSettings',
    call: (c) => c.updateSettings({ runHourUtc: 4 }),
    expected: { method: 'PATCH', path: '/replenishment/settings', body: { runHourUtc: 4 } },
  },
  { name: 'listPlans without params', call: (c) => c.listPlans(), expected: { method: 'GET', path: '/replenishment/plans' } },
  {
    name: 'listPlans with filters',
    call: (c) => c.listPlans({ needsReorder: true, urgency: 'lead_time', limit: 100, search: '' }),
    expected: { method: 'GET', path: '/replenishment/plans?needsReorder=true&urgency=lead_time&limit=100' },
  },
  { name: 'getPlan', call: (c) => c.getPlan('p1'), expected: { method: 'GET', path: '/replenishment/plans/p1' } },
  { name: 'getPlanDemand', call: (c) => c.getPlanDemand('p1'), expected: { method: 'GET', path: '/replenishment/plans/p1/demand' } },
  {
    name: 'dismissPlan with a snooze time',
    call: (c) => c.dismissPlan('p1', { until: '2026-12-01T00:00:00Z' }),
    expected: { method: 'POST', path: '/replenishment/plans/p1/dismiss', body: { until: '2026-12-01T00:00:00Z' } },
  },
  {
    name: 'dismissPlan defaults to an empty body',
    call: (c) => c.dismissPlan('p1'),
    expected: { method: 'POST', path: '/replenishment/plans/p1/dismiss', body: {} },
  },
  { name: 'restorePlan', call: (c) => c.restorePlan('p1'), expected: { method: 'POST', path: '/replenishment/plans/p1/restore', body: {} } },
  { name: 'listRules without params', call: (c) => c.listRules(), expected: { method: 'GET', path: '/replenishment/rules' } },
  {
    name: 'listRules with filters',
    call: (c) => c.listRules({ productId: 'prod_1', warehouseId: 'wh_1' }),
    expected: { method: 'GET', path: '/replenishment/rules?productId=prod_1&warehouseId=wh_1' },
  },
  {
    name: 'upsertRule',
    call: (c) => c.upsertRule({ productId: 'prod_1', warehouseId: 'wh_1', method: 'auto' }),
    expected: { method: 'PUT', path: '/replenishment/rules', body: { productId: 'prod_1', warehouseId: 'wh_1', method: 'auto' } },
  },
  { name: 'deleteRule', call: (c) => c.deleteRule('r1'), expected: { method: 'DELETE', path: '/replenishment/rules/r1' } },
  { name: 'listRuns without params', call: (c) => c.listRuns(), expected: { method: 'GET', path: '/replenishment/runs' } },
  { name: 'listRuns with a limit', call: (c) => c.listRuns({ limit: 5 }), expected: { method: 'GET', path: '/replenishment/runs?limit=5' } },
  { name: 'startRun', call: (c) => c.startRun(), expected: { method: 'POST', path: '/replenishment/runs', body: {} } },
  {
    name: 'createPurchaseOrders',
    call: (c) => c.createPurchaseOrders({ planIds: ['p1', 'p2'], quantities: { p1: 12 } }),
    expected: { method: 'POST', path: '/replenishment/purchase-orders', body: { planIds: ['p1', 'p2'], quantities: { p1: 12 } } },
  },
  { name: 'listIncoming without params', call: (c) => c.listIncoming(), expected: { method: 'GET', path: '/replenishment/incoming' } },
  {
    name: 'listIncoming with a warehouse',
    call: (c) => c.listIncoming({ warehouseId: 'wh_1' }),
    expected: { method: 'GET', path: '/replenishment/incoming?warehouseId=wh_1' },
  },
  { name: 'listImports', call: (c) => c.listImports(), expected: { method: 'GET', path: '/replenishment/imports' } },
  {
    name: 'createImport',
    call: (c) => c.createImport({ fileName: 'sales.csv' }),
    expected: { method: 'POST', path: '/replenishment/imports', body: { fileName: 'sales.csv' } },
  },
  {
    name: 'addImportRows',
    call: (c) => c.addImportRows('i1', { rows: [{ date: '2026-01-05', sku: 'A-1', quantity: 3 }], startRow: 0 }),
    expected: {
      method: 'POST',
      path: '/replenishment/imports/i1/rows',
      body: { rows: [{ date: '2026-01-05', sku: 'A-1', quantity: 3 }], startRow: 0 },
    },
  },
  {
    name: 'completeImport',
    call: (c) => c.completeImport('i1'),
    expected: { method: 'POST', path: '/replenishment/imports/i1/complete', body: {} },
  },
  { name: 'deleteImport', call: (c) => c.deleteImport('i1'), expected: { method: 'DELETE', path: '/replenishment/imports/i1' } },
];

describe('createReplenishmentApi', () => {
  it.each(CASES)('$name sends the right request', async ({ call, expected }) => {
    const { api, calls } = recordingApi();
    const result = await call(createReplenishmentApi(api));
    expect(calls).toEqual([expected]);
    expect(result).toBe(RESPONSE);
  });
});
