import { describe, expect, it } from 'vitest';
import type { ReorderRule } from '@weldsuite/app-api-client/schemas/replenishment';
import { EMPTY_RULE_FORM, formToRuleInput, makeRuleFormSchema, ruleToForm } from './rule-form';

const item = { productId: 'p1', variantId: null, warehouseId: 'w1' };

describe('formToRuleInput', () => {
  it('builds an automatic rule with defaults cleared', () => {
    const result = formToRuleInput(EMPTY_RULE_FORM, item);
    expect(result).toEqual({
      ok: true,
      input: {
        productId: 'p1',
        variantId: null,
        warehouseId: 'w1',
        method: 'auto',
        minQty: null,
        maxQty: null,
        serviceLevel: null,
        reviewPeriodDays: null,
        leadTimeDaysOverride: null,
        productSupplierId: null,
      },
    });
  });

  it('converts the service level percentage and passes overrides through', () => {
    const result = formToRuleInput(
      { ...EMPTY_RULE_FORM, serviceLevelPct: '97.5', reviewPeriodDays: '14', leadTimeDaysOverride: '30', productSupplierId: 'ps1' },
      item,
    );
    expect(result.ok && result.input).toMatchObject({ serviceLevel: 0.975, reviewPeriodDays: 14, leadTimeDaysOverride: 30, productSupplierId: 'ps1' });
  });

  it('requires min and max for a min/max rule, with min not above max', () => {
    const base = { ...EMPTY_RULE_FORM, method: 'min_max' as const };
    expect(formToRuleInput(base, item)).toEqual({ ok: false, errors: { maxQty: 'minmax' } });
    expect(formToRuleInput({ ...base, minQty: '20', maxQty: '10' }, item)).toEqual({ ok: false, errors: { maxQty: 'minmax' } });
    const ok = formToRuleInput({ ...base, minQty: '10', maxQty: '40' }, item);
    expect(ok.ok && ok.input).toMatchObject({ method: 'min_max', minQty: 10, maxQty: 40 });
  });

  it('drops min and max from a rule that is not min/max', () => {
    const result = formToRuleInput({ ...EMPTY_RULE_FORM, method: 'off', minQty: '5', maxQty: '9' }, item);
    expect(result.ok && result.input).toMatchObject({ method: 'off', minQty: null, maxQty: null });
  });

  it('reports text and fractions as invalid', () => {
    const result = formToRuleInput({ ...EMPTY_RULE_FORM, reviewPeriodDays: 'abc', leadTimeDaysOverride: '1.5' }, item);
    expect(result).toEqual({ ok: false, errors: { reviewPeriodDays: 'invalid', leadTimeDaysOverride: 'invalid' } });
  });

  it('accepts the highest service level, 99.9%, despite floating point', () => {
    const result = formToRuleInput({ ...EMPTY_RULE_FORM, serviceLevelPct: '99.9' }, item);
    expect(result.ok && result.input.serviceLevel).toBe(0.999);
  });

  it('refuses values outside the API ranges', () => {
    expect(formToRuleInput({ ...EMPTY_RULE_FORM, serviceLevelPct: '30' }, item)).toEqual({ ok: false, errors: { serviceLevelPct: 'invalid' } });
    expect(formToRuleInput({ ...EMPTY_RULE_FORM, reviewPeriodDays: '120' }, item)).toEqual({ ok: false, errors: { reviewPeriodDays: 'invalid' } });
  });
});

describe('ruleToForm', () => {
  it('shows a stored rule as input text', () => {
    const rule: ReorderRule = {
      id: 'r1',
      itemKey: 'p1||w1',
      productId: 'p1',
      variantId: null,
      warehouseId: 'w1',
      method: 'min_max',
      minQty: 10,
      maxQty: 40,
      serviceLevel: '0.975',
      reviewPeriodDays: null,
      leadTimeDaysOverride: 30,
      productSupplierId: null,
      createdAt: '',
      updatedAt: '',
    };
    expect(ruleToForm(rule)).toEqual({
      method: 'min_max',
      minQty: '10',
      maxQty: '40',
      serviceLevelPct: '97.5',
      reviewPeriodDays: '',
      leadTimeDaysOverride: '30',
      productSupplierId: '',
    });
    expect(ruleToForm(null)).toEqual(EMPTY_RULE_FORM);
  });
});

describe('makeRuleFormSchema', () => {
  const schema = makeRuleFormSchema({ invalid: 'Not a valid number', minmax: 'Min must not exceed max' });

  it('passes a good form and puts translated messages on the bad fields', () => {
    expect(schema.safeParse(EMPTY_RULE_FORM).success).toBe(true);
    const bad = schema.safeParse({ ...EMPTY_RULE_FORM, method: 'min_max', minQty: '5', maxQty: '2' });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]).toMatchObject({ path: ['maxQty'], message: 'Min must not exceed max' });
  });
});
