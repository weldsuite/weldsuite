import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  EMPTY_SALES_TAX_LINE,
  dimensionPayload,
  overrideChecks,
  salesTaxLineFields,
  salesTaxLinePayload,
} from './document-tax-form';

const messages = { reasonRequired: 'Reason needed', amountInvalid: 'Amount invalid' };
const lineSchema = z.object({ ...salesTaxLineFields }).superRefine(overrideChecks(messages));

function check(values: Partial<typeof EMPTY_SALES_TAX_LINE>) {
  const result = lineSchema.safeParse({ ...EMPTY_SALES_TAX_LINE, ...values });
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

describe('tax override validation', () => {
  it('needs a reason when an amount is given', () => {
    expect(check({ taxOverrideEnabled: true, taxOverrideAmount: '4.2', taxOverrideReason: '' })).toEqual([
      'taxOverrideReason: Reason needed',
    ]);
    expect(check({ taxOverrideEnabled: true, taxOverrideAmount: '4.2', taxOverrideReason: '   ' })).toEqual([
      'taxOverrideReason: Reason needed',
    ]);
  });

  it('accepts an amount with a reason, and a zero amount (no tax at all)', () => {
    expect(check({ taxOverrideEnabled: true, taxOverrideAmount: '4.2', taxOverrideReason: 'State ruling' })).toEqual([]);
    expect(check({ taxOverrideEnabled: true, taxOverrideAmount: '0', taxOverrideReason: 'Exempt by statute' })).toEqual([]);
  });

  it('rejects a negative or non-numeric amount', () => {
    expect(check({ taxOverrideEnabled: true, taxOverrideAmount: '-1', taxOverrideReason: 'x' })).toEqual([
      'taxOverrideAmount: Amount invalid',
    ]);
    expect(check({ taxOverrideEnabled: true, taxOverrideAmount: 'abc', taxOverrideReason: 'x' })).toEqual([
      'taxOverrideAmount: Amount invalid',
    ]);
  });

  it('ignores the fields while the override is off or the amount is empty', () => {
    expect(check({ taxOverrideEnabled: false, taxOverrideAmount: '5', taxOverrideReason: '' })).toEqual([]);
    expect(check({ taxOverrideEnabled: true, taxOverrideAmount: '', taxOverrideReason: '' })).toEqual([]);
  });
});

describe('salesTaxLinePayload', () => {
  it('sends a complete override and the line settings', () => {
    expect(
      salesTaxLinePayload({
        ...EMPTY_SALES_TAX_LINE,
        productId: 'prod_1',
        taxCode: 'saas',
        taxUse: 'business',
        taxIncluded: true,
        taxOverrideEnabled: true,
        taxOverrideAmount: '4.20',
        taxOverrideReason: ' State ruling ',
      }),
    ).toEqual({
      productId: 'prod_1',
      taxCode: 'saas',
      taxUse: 'business',
      taxIncluded: true,
      taxOverrideAmount: '4.2',
      taxOverrideReason: 'State ruling',
    });
  });

  it('sends nulls for the defaults, which clears a stored override when the toggle is turned off', () => {
    expect(salesTaxLinePayload({ ...EMPTY_SALES_TAX_LINE, taxOverrideAmount: '9', taxOverrideReason: 'x' })).toEqual({
      productId: null,
      taxCode: null,
      taxUse: null,
      taxIncluded: false,
      taxOverrideAmount: null,
      taxOverrideReason: null,
    });
  });

  it('drops an override that has no reason', () => {
    const payload = salesTaxLinePayload({ ...EMPTY_SALES_TAX_LINE, taxOverrideEnabled: true, taxOverrideAmount: '9' });
    expect(payload.taxOverrideAmount).toBeNull();
    expect(payload.taxOverrideReason).toBeNull();
  });
});

describe('dimensionPayload', () => {
  it('sends ids, and null for none', () => {
    expect(dimensionPayload({ classId: 'dim_c', locationId: '' })).toEqual({ classId: 'dim_c', locationId: null });
  });
});
