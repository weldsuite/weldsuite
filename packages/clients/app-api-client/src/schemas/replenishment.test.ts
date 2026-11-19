import { describe, expect, it } from 'vitest';
import {
  IMPORT_CHUNK_SIZE,
  createPurchaseOrdersFromPlansSchema,
  dismissPlanSchema,
  importRowsSchema,
  salesHistoryRowSchema,
  updateReplenishmentSettingsSchema,
  upsertReorderRuleSchema,
} from './replenishment';

const row = { date: '2026-03-01', sku: 'SKU-1', quantity: 4 };

describe('updateReplenishmentSettingsSchema', () => {
  it('accepts a full valid settings object', () => {
    const input = {
      replenishmentEnabled: true,
      defaultServiceLevel: 0.95,
      defaultReviewPeriodDays: 7,
      lookbackDays: 365,
      defaultLeadTimeDays: 14,
      demandWarehouseId: null,
      historyCutoverDate: '2026-01-31',
      runHourUtc: 3,
    };
    expect(updateReplenishmentSettingsSchema.parse(input)).toEqual(input);
  });

  it('accepts an empty patch, every field being optional', () => {
    expect(updateReplenishmentSettingsSchema.parse({})).toEqual({});
  });

  it.each([
    ['service level below 0.5', { defaultServiceLevel: 0.49 }],
    ['service level above 0.999', { defaultServiceLevel: 1 }],
    ['review period of 0 days', { defaultReviewPeriodDays: 0 }],
    ['review period over 90 days', { defaultReviewPeriodDays: 91 }],
    ['fractional review period', { defaultReviewPeriodDays: 7.5 }],
    ['lookback under 28 days', { lookbackDays: 27 }],
    ['lookback over 730 days', { lookbackDays: 731 }],
    ['negative lead time', { defaultLeadTimeDays: -1 }],
    ['lead time over 365 days', { defaultLeadTimeDays: 366 }],
    ['cutover date in the wrong format', { historyCutoverDate: '01-02-2026' }],
    ['run hour 24', { runHourUtc: 24 }],
    ['negative run hour', { runHourUtc: -1 }],
  ])('rejects %s', (_name, input) => {
    expect(updateReplenishmentSettingsSchema.safeParse(input).success).toBe(false);
  });

  it('accepts the service level bounds 0.5 and 0.999', () => {
    expect(updateReplenishmentSettingsSchema.safeParse({ defaultServiceLevel: 0.5 }).success).toBe(true);
    expect(updateReplenishmentSettingsSchema.safeParse({ defaultServiceLevel: 0.999 }).success).toBe(true);
  });
});

describe('dismissPlanSchema', () => {
  it('accepts a snooze time or none', () => {
    expect(dismissPlanSchema.parse({ until: '2026-12-01T00:00:00Z' })).toEqual({ until: '2026-12-01T00:00:00Z' });
    expect(dismissPlanSchema.parse({})).toEqual({});
  });

  it('rejects a non-string snooze time', () => {
    expect(dismissPlanSchema.safeParse({ until: 12 }).success).toBe(false);
  });
});

describe('upsertReorderRuleSchema', () => {
  const base = { productId: 'prod_1', warehouseId: 'wh_1' };

  it('accepts an auto rule with optional tuning', () => {
    const input = { ...base, method: 'auto', serviceLevel: 0.9, reviewPeriodDays: 14, leadTimeDaysOverride: 5, variantId: null };
    expect(upsertReorderRuleSchema.parse(input)).toEqual(input);
  });

  it('accepts a min_max rule with min at most max', () => {
    expect(upsertReorderRuleSchema.safeParse({ ...base, method: 'min_max', minQty: 5, maxQty: 5 }).success).toBe(true);
    expect(upsertReorderRuleSchema.safeParse({ ...base, method: 'min_max', minQty: 0, maxQty: 20 }).success).toBe(true);
  });

  it('rejects a min_max rule whose min exceeds its max, reporting the max field', () => {
    const result = upsertReorderRuleSchema.safeParse({ ...base, method: 'min_max', minQty: 10, maxQty: 5 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['maxQty']);
  });

  it('rejects a min_max rule missing min or max', () => {
    expect(upsertReorderRuleSchema.safeParse({ ...base, method: 'min_max', minQty: 1 }).success).toBe(false);
    expect(upsertReorderRuleSchema.safeParse({ ...base, method: 'min_max', maxQty: 1 }).success).toBe(false);
    expect(upsertReorderRuleSchema.safeParse({ ...base, method: 'min_max', minQty: null, maxQty: null }).success).toBe(false);
  });

  it('does not require min and max for auto and off rules', () => {
    expect(upsertReorderRuleSchema.safeParse({ ...base, method: 'off' }).success).toBe(true);
    expect(upsertReorderRuleSchema.safeParse({ ...base, method: 'auto', minQty: 9, maxQty: 1 }).success).toBe(true);
  });

  it.each([
    ['an empty product id', { ...base, productId: '', method: 'auto' }],
    ['an empty warehouse id', { ...base, warehouseId: '', method: 'auto' }],
    ['an unknown method', { ...base, method: 'manual' }],
    ['a service level of 0.4', { ...base, method: 'auto', serviceLevel: 0.4 }],
    ['a review period of 91 days', { ...base, method: 'auto', reviewPeriodDays: 91 }],
    ['a lead time override of 366 days', { ...base, method: 'auto', leadTimeDaysOverride: 366 }],
    ['a negative minimum', { ...base, method: 'auto', minQty: -1 }],
  ])('rejects %s', (_name, input) => {
    expect(upsertReorderRuleSchema.safeParse(input).success).toBe(false);
  });
});

describe('createPurchaseOrdersFromPlansSchema', () => {
  it('accepts plan ids with per-plan quantities', () => {
    const input = { planIds: ['p1', 'p2'], quantities: { p1: 12 } };
    expect(createPurchaseOrdersFromPlansSchema.parse(input)).toEqual(input);
  });

  it('accepts plan ids without quantities', () => {
    expect(createPurchaseOrdersFromPlansSchema.safeParse({ planIds: ['p1'] }).success).toBe(true);
  });

  it('rejects no plans, an empty id and more than 500 plans', () => {
    expect(createPurchaseOrdersFromPlansSchema.safeParse({ planIds: [] }).success).toBe(false);
    expect(createPurchaseOrdersFromPlansSchema.safeParse({ planIds: [''] }).success).toBe(false);
    const many = Array.from({ length: 501 }, (_, i) => `p${i}`);
    expect(createPurchaseOrdersFromPlansSchema.safeParse({ planIds: many }).success).toBe(false);
    expect(createPurchaseOrdersFromPlansSchema.safeParse({ planIds: many.slice(0, 500) }).success).toBe(true);
  });

  it('rejects quantities below 1 or fractional', () => {
    expect(createPurchaseOrdersFromPlansSchema.safeParse({ planIds: ['p1'], quantities: { p1: 0 } }).success).toBe(false);
    expect(createPurchaseOrdersFromPlansSchema.safeParse({ planIds: ['p1'], quantities: { p1: 1.5 } }).success).toBe(false);
  });
});

describe('salesHistoryRowSchema', () => {
  it('accepts a row with the optional columns', () => {
    const input = { ...row, warehouseCode: 'MAIN', reference: 'SO-9' };
    expect(salesHistoryRowSchema.parse(input)).toEqual(input);
  });

  it('allows a negative quantity (a return) but not a fractional one', () => {
    expect(salesHistoryRowSchema.safeParse({ ...row, quantity: -2 }).success).toBe(true);
    expect(salesHistoryRowSchema.safeParse({ ...row, quantity: 1.5 }).success).toBe(false);
  });

  it('rejects a badly formatted date and an empty SKU', () => {
    expect(salesHistoryRowSchema.safeParse({ ...row, date: '2026/03/01' }).success).toBe(false);
    expect(salesHistoryRowSchema.safeParse({ ...row, sku: '' }).success).toBe(false);
  });
});

describe('importRowsSchema', () => {
  it('accepts a chunk with a start row, including 0', () => {
    expect(importRowsSchema.parse({ rows: [row], startRow: 0 })).toEqual({ rows: [row], startRow: 0 });
    expect(importRowsSchema.parse({ rows: [row] })).toEqual({ rows: [row] });
  });

  it('limits a chunk to IMPORT_CHUNK_SIZE rows and at least one', () => {
    expect(IMPORT_CHUNK_SIZE).toBe(1000);
    const full = Array.from({ length: IMPORT_CHUNK_SIZE }, () => row);
    expect(importRowsSchema.safeParse({ rows: full }).success).toBe(true);
    expect(importRowsSchema.safeParse({ rows: [...full, row] }).success).toBe(false);
    expect(importRowsSchema.safeParse({ rows: [] }).success).toBe(false);
  });

  it('bounds startRow to 0 through 1,000,000,000 and whole numbers', () => {
    expect(importRowsSchema.safeParse({ rows: [row], startRow: -1 }).success).toBe(false);
    expect(importRowsSchema.safeParse({ rows: [row], startRow: 1.5 }).success).toBe(false);
    expect(importRowsSchema.safeParse({ rows: [row], startRow: 1_000_000_001 }).success).toBe(false);
    expect(importRowsSchema.safeParse({ rows: [row], startRow: 1_000_000_000 }).success).toBe(true);
  });
});
