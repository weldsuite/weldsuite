import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { WELD_TAX_CODES as DOMAIN_TAX_CODES } from '../../../../../../../packages/domains/books/src/jurisdictions/us/tax-codes';
import type { SalesTaxRule } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import {
  WELD_TAX_CODES,
  emptyRuleForm,
  isWeldTaxCode,
  makeRuleSchema,
  ruleToForm,
  sortRules,
  toCreateRuleInput,
  toUpdateRuleInput,
} from './rule-model';

const setup = en.weldbooksUs.salesTax.setup;
const schema = makeRuleSchema(setup.validation);

describe('tax codes', () => {
  it('are the codes of the books domain, in the same order', () => {
    expect([...WELD_TAX_CODES]).toEqual([...DOMAIN_TAX_CODES]);
  });

  it('each have a label and a description', () => {
    for (const code of WELD_TAX_CODES) {
      expect(setup.taxCodes[code].label, code).not.toBe('');
      expect(setup.taxCodes[code].description, code).not.toBe('');
    }
  });

  it('are recognised', () => {
    expect(isWeldTaxCode('saas')).toBe(true);
    expect(isWeldTaxCode('txcd_10103001')).toBe(false);
  });
});

describe('rule payload', () => {
  it('sends a taxable rule with its share, use and dates', () => {
    const form = {
      ...emptyRuleForm('2027-01-01'),
      taxCode: 'saas',
      taxablePercent: '80',
      appliesToUse: 'business' as const,
      notes: ' Texas SaaS ',
    };
    expect(toCreateRuleInput('sta_1', form)).toEqual({
      agencyId: 'sta_1',
      taxCode: 'saas',
      taxable: true,
      taxablePercent: 80,
      appliesToUse: 'business',
      effectiveFrom: '2027-01-01',
      notes: 'Texas SaaS',
    });
  });

  it('sends a rate override only when there is one', () => {
    expect(toCreateRuleInput('sta_1', { ...emptyRuleForm('2027-01-01'), rateOverride: '3' }).rateOverride).toBe(3);
    expect(toCreateRuleInput('sta_1', emptyRuleForm('2027-01-01'))).not.toHaveProperty('rateOverride');
  });

  it('ignores the share and the override of a rule that is not taxable', () => {
    const form = { ...emptyRuleForm('2027-01-01'), taxable: false, taxablePercent: '50', rateOverride: '3' };
    expect(toCreateRuleInput('sta_1', form)).toMatchObject({ taxable: false, taxablePercent: 100 });
    expect(toCreateRuleInput('sta_1', form)).not.toHaveProperty('rateOverride');
    expect(toUpdateRuleInput(form)).toMatchObject({ taxable: false, taxablePercent: 100, rateOverride: null });
  });

  it('treats a blank share as 100%', () => {
    expect(toCreateRuleInput('sta_1', { ...emptyRuleForm('2027-01-01'), taxablePercent: '' }).taxablePercent).toBe(100);
  });

  it('clears optional fields with null on an update', () => {
    expect(toUpdateRuleInput({ ...emptyRuleForm('2027-01-01'), effectiveTo: '', notes: '' })).toMatchObject({
      effectiveTo: null,
      notes: null,
      rateOverride: null,
    });
  });

  it('round-trips a stored rule through the form', () => {
    const rule: SalesTaxRule = {
      id: 'str_1',
      agencyId: 'sta_1',
      taxCode: 'saas',
      taxable: true,
      taxablePercent: '80.0000',
      appliesToUse: 'business',
      rateOverride: '3.0000',
      effectiveFrom: '2027-01-01',
      effectiveTo: null,
      notes: null,
    };
    expect(ruleToForm(rule)).toEqual({
      taxCode: 'saas',
      taxable: true,
      taxablePercent: '80',
      appliesToUse: 'business',
      rateOverride: '3',
      effectiveFrom: '2027-01-01',
      effectiveTo: '',
      notes: '',
    });
  });
});

describe('rule validation', () => {
  const valid = emptyRuleForm('2027-01-01');

  it('accepts a rule with a start date', () => {
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it('needs a start date and an end date that is not before it', () => {
    expect(schema.safeParse({ ...valid, effectiveFrom: '' }).success).toBe(false);
    expect(schema.safeParse({ ...valid, effectiveTo: '2026-12-31' }).success).toBe(false);
  });

  it('needs percentages from 0 to 100', () => {
    expect(schema.safeParse({ ...valid, taxablePercent: '101' }).success).toBe(false);
    expect(schema.safeParse({ ...valid, rateOverride: 'abc' }).success).toBe(false);
    expect(schema.safeParse({ ...valid, taxablePercent: '80', rateOverride: '3' }).success).toBe(true);
  });

  it('does not check the share of a rule that is not taxable', () => {
    expect(schema.safeParse({ ...valid, taxable: false, taxablePercent: 'x', rateOverride: 'y' }).success).toBe(true);
  });
});

describe('sortRules', () => {
  it('groups by product in the order of the code list, oldest first', () => {
    const sorted = sortRules([
      { taxCode: 'handling', effectiveFrom: '2000-01-01' },
      { taxCode: 'saas', effectiveFrom: '2027-01-01' },
      { taxCode: 'saas', effectiveFrom: '2000-01-01' },
      { taxCode: 'custom', effectiveFrom: '2000-01-01' },
    ]);
    expect(sorted.map((r) => `${r.taxCode}@${r.effectiveFrom}`)).toEqual([
      'saas@2000-01-01',
      'saas@2027-01-01',
      'handling@2000-01-01',
      'custom@2000-01-01',
    ]);
  });
});
