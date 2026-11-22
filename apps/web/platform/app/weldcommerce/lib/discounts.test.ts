import { describe, expect, it } from 'vitest';
import type { CommerceDiscount } from '@/hooks/queries/use-commerce-orders-queries';
import {
  buildDiscountFormSchema,
  discountStatusLabel,
  discountStatusTone,
  emptyDiscountValues,
  formatDiscountValue,
  formatUsage,
  isoToLocalInput,
  localInputToIso,
  toDiscountInput,
  valuesFromDiscount,
} from './discounts';

const discount: CommerceDiscount = {
  id: 'dsc_1',
  name: 'Spring',
  description: null,
  code: 'SPRING',
  type: 'percentage',
  value: '10.00',
  currency: null,
  maxDiscountAmount: '25.00',
  appliesTo: 'categories',
  productIds: [],
  variantIds: [],
  categoryIds: ['cat_1'],
  minimumSubtotal: null,
  minimumQuantity: null,
  usageLimit: 50,
  usageLimitPerCustomer: null,
  usageCount: 3,
  status: 'active',
  effectiveStatus: 'active',
  startsAt: null,
  endsAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

describe('display', () => {
  it('toned and worded effective statuses, an unknown one as stored', () => {
    expect(discountStatusTone('used_up')).toBe('danger');
    expect(discountStatusTone('scheduled')).toBe('warning');
    expect(discountStatusLabel('used_up')).toBe('Used up');
    expect(discountStatusLabel('on_hold')).toBe('on hold');
  });

  it('reads a value as a percentage, an amount or free shipping', () => {
    expect(formatDiscountValue(discount)).toBe('10%');
    expect(formatDiscountValue({ type: 'fixed_amount', value: '5.00', currency: 'EUR' })).toContain('5.00');
    expect(formatDiscountValue({ type: 'free_shipping', value: '0', currency: null })).toBe('Free shipping');
  });

  it('reads usage with and without a limit', () => {
    expect(formatUsage(discount)).toBe('3 of 50');
    expect(formatUsage({ usageCount: 3, usageLimit: null })).toBe('3');
  });
});

describe('date inputs', () => {
  it('round-trips a timestamp through a datetime-local value', () => {
    const iso = new Date(2026, 10, 21, 9, 30).toISOString();
    expect(isoToLocalInput(iso)).toBe('2026-11-21T09:30');
    expect(localInputToIso('2026-11-21T09:30')).toBe(iso);
  });

  it('treats blank and invalid values as none', () => {
    expect(isoToLocalInput(null)).toBe('');
    expect(isoToLocalInput('garbage')).toBe('');
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso('garbage')).toBeNull();
  });
});

describe('toDiscountInput', () => {
  it('builds a percentage code, clearing what a percentage does not use', () => {
    const values = {
      ...emptyDiscountValues('EUR'),
      name: ' Spring ',
      code: ' SPRING ',
      value: '10',
      currency: 'EUR',
      appliesTo: 'categories' as const,
      categoryIds: ['cat_1'],
      productIds: ['prod_stale'],
      usageLimit: 50,
    };
    expect(toDiscountInput(values)).toMatchObject({
      name: 'Spring',
      code: 'SPRING',
      type: 'percentage',
      value: '10',
      currency: null,
      maxDiscountAmount: null,
      appliesTo: 'categories',
      productIds: [],
      categoryIds: ['cat_1'],
      variantIds: [],
      usageLimit: 50,
      usageLimitPerCustomer: null,
      startsAt: null,
    });
  });

  it('keeps the currency of a fixed amount, sends 0 for free shipping, and leaves variants alone for a product code', () => {
    const fixed = toDiscountInput({ ...emptyDiscountValues('EUR'), type: 'fixed_amount', value: '5', currency: 'eur', name: 'a', code: 'a' });
    expect(fixed.currency).toBe('EUR');
    expect(fixed.maxDiscountAmount).toBeNull();

    const free = toDiscountInput({ ...emptyDiscountValues('EUR'), type: 'free_shipping', value: '12', name: 'a', code: 'a' });
    expect(free.value).toBe('0');
    expect(free.currency).toBeNull();

    const products = toDiscountInput({ ...emptyDiscountValues('EUR'), appliesTo: 'products', productIds: ['p1'], name: 'a', code: 'a', value: '1' });
    expect(products.productIds).toEqual(['p1']);
    expect('variantIds' in products).toBe(false);
  });

  it('fills the form from a discount and back to the same body', () => {
    const values = valuesFromDiscount(discount);
    expect(values.value).toBe('10');
    expect(values.maxDiscountAmount).toBe('25.00');
    expect(toDiscountInput(values)).toMatchObject({ code: 'SPRING', value: '10', maxDiscountAmount: '25.00', categoryIds: ['cat_1'] });
  });
});

describe('buildDiscountFormSchema', () => {
  const schema = buildDiscountFormSchema();
  const valid = { ...emptyDiscountValues('EUR'), name: 'Spring', code: 'SPRING', value: '10' };
  const messages = (values: unknown) => {
    const result = schema.safeParse(values);
    return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  };

  it('accepts a percentage code', () => {
    expect(messages(valid)).toEqual([]);
  });

  it('keeps a percentage between 0 and 100 and needs a value for every type but free shipping', () => {
    expect(messages({ ...valid, value: '101' })).toEqual(['value: A percentage cannot be more than 100.']);
    expect(messages({ ...valid, value: '' })).toEqual(['value: Enter a value.']);
    expect(messages({ ...valid, value: '0' })).toEqual(['value: Enter an amount greater than 0, such as 10 or 12.50.']);
    expect(messages({ ...valid, type: 'free_shipping', value: '' })).toEqual([]);
  });

  it('needs a currency for a fixed amount', () => {
    expect(messages({ ...valid, type: 'fixed_amount', currency: '' })).toEqual(['currency: Enter a three-letter currency code.']);
  });

  it('refuses a code with spaces, and a scope with nothing chosen', () => {
    expect(messages({ ...valid, code: 'SPRING SALE' })).toEqual(['code: A code cannot contain spaces.']);
    expect(messages({ ...valid, appliesTo: 'products' })).toEqual(['productIds: Choose at least one product.']);
    expect(messages({ ...valid, appliesTo: 'categories' })).toEqual(['categoryIds: Choose at least one category.']);
  });

  it('wants the end after the start', () => {
    expect(messages({ ...valid, startsAt: '2026-12-01T10:00', endsAt: '2026-11-01T10:00' })).toEqual(['endsAt: The end must be after the start.']);
    expect(messages({ ...valid, startsAt: '2026-11-01T10:00', endsAt: '2026-12-01T10:00' })).toEqual([]);
  });
});
