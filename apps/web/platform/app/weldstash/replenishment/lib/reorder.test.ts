import { describe, expect, it } from 'vitest';
import type { ReplenishmentPlan } from '@weldsuite/app-api-client/schemas/replenishment';
import {
  addDays,
  createWarnings,
  effectiveQuantity,
  groupBySupplier,
  isOverstock,
  lineValue,
  quantityHint,
  urgencyOf,
} from './reorder';

function plan(overrides: Partial<ReplenishmentPlan> = {}): ReplenishmentPlan {
  return {
    id: 'plan_1',
    itemKey: 'p|v|w',
    productId: 'p1',
    variantId: null,
    warehouseId: 'w1',
    runId: null,
    computedAt: null,
    method: 'seasonal',
    confidence: 'ok',
    historyDays: 365,
    nonzeroDays: 200,
    avgDailyDemand: '5.2000',
    demandStdDev: null,
    seasonality: null,
    forecast30d: null,
    forecast90d: null,
    leadTimeDays: 20,
    reviewPeriodDays: 7,
    serviceLevel: '0.950',
    productSupplierId: null,
    supplierId: 's1',
    safetyStock: 36,
    reorderPoint: 140,
    orderUpTo: 260,
    onHand: 50,
    allocated: 5,
    incoming: 0,
    openDemand: 0,
    inventoryPosition: 45,
    daysOfCover: '8.7',
    stockoutDate: '2026-12-01',
    suggestedQty: 100,
    suggestedValue: null,
    reviewStatus: 'open',
    dismissedUntil: null,
    dismissedBy: null,
    dismissedQty: null,
    purchaseOrderId: null,
    productName: 'Widget',
    productSku: 'W-1',
    variantName: null,
    warehouseName: 'Main',
    warehouseManagedByConnectionId: null,
    supplierName: 'Acme',
    currency: 'EUR',
    unitCost: '2.5000',
    minOrderQty: null,
    orderMultiple: 1,
    ...overrides,
  };
}

describe('effectiveQuantity and lineValue', () => {
  it('uses the edit when there is one, else the suggestion', () => {
    expect(effectiveQuantity(plan(), {})).toBe(100);
    expect(effectiveQuantity(plan(), { plan_1: 40 })).toBe(40);
    expect(effectiveQuantity(plan(), { plan_1: 0 })).toBe(0);
  });

  it('multiplies by the unit cost, which arrives as text', () => {
    expect(lineValue(plan(), 100)).toBe(250);
    expect(lineValue(plan({ unitCost: null }), 100)).toBe(0);
    expect(lineValue(plan({ unitCost: '0.3333' }), 3)).toBe(1);
  });
});

describe('groupBySupplier', () => {
  it('groups by supplier name and puts plans without a supplier last', () => {
    const groups = groupBySupplier([
      plan({ id: 'a', supplierId: 's2', supplierName: 'Zeta' }),
      plan({ id: 'b', supplierId: null, supplierName: null }),
      plan({ id: 'c', supplierId: 's1', supplierName: 'Acme' }),
      plan({ id: 'd', supplierId: 's2', supplierName: 'Zeta' }),
    ]);
    expect(groups.map((g) => g.supplierName)).toEqual(['Acme', 'Zeta', null]);
    expect(groups[1].plans.map((p) => p.id)).toEqual(['a', 'd']);
  });
});

describe('urgencyOf', () => {
  const today = '2026-11-18';

  it('is out of stock when nothing is available', () => {
    expect(urgencyOf(plan({ onHand: 5, allocated: 5 }), today)).toBe('out_of_stock');
  });

  it('is lead time when the stockout falls inside the lead time', () => {
    expect(urgencyOf(plan({ stockoutDate: '2026-12-08' }), today)).toBe('lead_time'); // today + 20
  });

  it('is review when it falls inside lead time plus the review period', () => {
    expect(urgencyOf(plan({ stockoutDate: '2026-12-15' }), today)).toBe('review'); // today + 27
  });

  it('is none further out, or without a stockout date', () => {
    expect(urgencyOf(plan({ stockoutDate: '2027-02-01' }), today)).toBeNull();
    expect(urgencyOf(plan({ stockoutDate: null }), today)).toBeNull();
  });
});

describe('addDays', () => {
  it('rolls over months and years', () => {
    expect(addDays('2026-12-30', 5)).toBe('2027-01-04');
  });
});

describe('isOverstock', () => {
  it('flags more than 180 days of cover', () => {
    expect(isOverstock({ daysOfCover: '181.0' })).toBe(true);
    expect(isOverstock({ daysOfCover: '180.0' })).toBe(false);
    expect(isOverstock({ daysOfCover: null })).toBe(false);
  });
});

describe('quantityHint', () => {
  it('notes a quantity under the minimum or off the pack size', () => {
    expect(quantityHint({ minOrderQty: 50, orderMultiple: 1 }, 20)).toBe('below_minimum');
    expect(quantityHint({ minOrderQty: null, orderMultiple: 12 }, 20)).toBe('not_multiple');
    expect(quantityHint({ minOrderQty: null, orderMultiple: 12 }, 24)).toBeNull();
    expect(quantityHint({ minOrderQty: 50, orderMultiple: 1 }, 0)).toBeNull();
  });
});

describe('createWarnings', () => {
  it('flags lines without a supplier and zero quantities', () => {
    const w = createWarnings(
      [plan({ id: 'a', supplierId: null, supplierName: null }), plan({ id: 'b' }), plan({ id: 'c' })],
      { b: 0 },
      {},
    );
    expect(w.withoutSupplier.map((p) => p.id)).toEqual(['a']);
    expect(w.zeroQuantity.map((p) => p.id)).toEqual(['b']);
    expect(w.belowMinimum).toEqual([]);
  });

  it('warns when a supplier total is under its minimum order value, using edited quantities', () => {
    const selected = [plan({ id: 'a' }), plan({ id: 'b' })]; // 100 x 2.5 = 250 each
    const w = createWarnings(selected, { b: 20 }, { s1: '400.00' });
    expect(w.belowMinimum).toEqual([
      { supplierId: 's1', supplierName: 'Acme', total: 300, minimum: 400, currency: 'EUR' },
    ]);
  });

  it('does not warn when the total reaches the minimum or no minimum is set', () => {
    const selected = [plan({ id: 'a' }), plan({ id: 'b' })];
    expect(createWarnings(selected, {}, { s1: '500.00' }).belowMinimum).toEqual([]);
    expect(createWarnings(selected, {}, { s1: null }).belowMinimum).toEqual([]);
    expect(createWarnings(selected, {}, {}).belowMinimum).toEqual([]);
  });
});
