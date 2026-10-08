import { describe, it, expect } from 'vitest';
import {
  TAX_LINE_CATEGORIES,
  TAX_LINE_CATEGORY_KEYS,
  TAX_RETURN_FORMS,
  getDeductiblePercent,
  getTaxLine,
  getTaxLineCatalog,
  isTaxLineCategory,
  isTaxReturnForm,
  resolveNondeductibleLine,
  resolveTaxLine,
} from './tax-lines';

const YEARS = [2023, 2024, 2025, 2026];

describe('catalogs', () => {
  it.each(TAX_RETURN_FORMS.flatMap((form) => YEARS.map((year) => [form, year] as const)))(
    '%s %i: unique, form-prefixed codes with a label and section',
    (form, year) => {
      const catalog = getTaxLineCatalog(form, year);
      expect(catalog.length).toBeGreaterThan(10);
      const codes = catalog.map((l) => l.code);
      expect(new Set(codes).size).toBe(codes.length);
      for (const line of catalog) {
        expect(line.form).toBe(form);
        expect(line.code.startsWith(`${form}.`)).toBe(true);
        expect(line.code).not.toContain(' ');
        // accounts.tax_line is varchar(40)
        expect(line.code.length).toBeLessThanOrEqual(40);
        expect(line.label.length).toBeGreaterThan(0);
        expect(line.line.length).toBeGreaterThan(0);
      }
    },
  );

  it('looks up every catalog line by its code', () => {
    for (const form of TAX_RETURN_FORMS) {
      for (const line of getTaxLineCatalog(form, 2025)) {
        expect(getTaxLine(line.code, 2025)).toEqual(line);
      }
    }
  });

  it('returns undefined for unknown codes', () => {
    expect(getTaxLine('nope.1', 2025)).toBeUndefined();
    expect(getTaxLine('sch_c.999', 2025)).toBeUndefined();
    expect(getTaxLine('sch_c', 2025)).toBeUndefined();
    expect(getTaxLine('.8', 2025)).toBeUndefined();
    expect(getTaxLine('', 2025)).toBeUndefined();
  });

  it('hands out a copy the caller may sort', () => {
    const first = getTaxLineCatalog('sch_c', 2025);
    first.reverse();
    expect(getTaxLineCatalog('sch_c', 2025)[0]?.code).toBe('sch_c.1');
  });

  it('recognises forms and categories', () => {
    expect(isTaxReturnForm('f1120s')).toBe(true);
    expect(isTaxReturnForm('f1040')).toBe(false);
    expect(isTaxLineCategory('advertising')).toBe(true);
    expect(isTaxLineCategory('sch_c.8')).toBe(false);
    expect(TAX_LINE_CATEGORIES).toBe(TAX_LINE_CATEGORY_KEYS);
  });
});

describe('Schedule C', () => {
  it('has Part II lines 8 to 27b, Part III and Part V', () => {
    const codes = getTaxLineCatalog('sch_c', 2025).map((l) => l.code);
    for (const key of [
      '1', '2', '6', '8', '9', '10', '11', '12', '13', '14', '15', '16a', '16b', '17', '18', '19', '20a', '20b',
      '21', '22', '23', '24a', '24b', '25', '26', '27a', '27b', '30', '35', '36', '37', '38', '39', '41', '48',
    ]) {
      expect(codes, key).toContain(`sch_c.${key}`);
    }
  });

  it('swaps lines 27a and 27b for tax year 2025', () => {
    for (const year of [2023, 2024]) {
      expect(getTaxLine('sch_c.27a', year)?.label).toMatch(/^Other expenses/);
      expect(getTaxLine('sch_c.27b', year)?.label).toMatch(/^Energy efficient/);
      expect(getTaxLine('sch_c.27a', year)?.section).toBe('other_deduction');
    }
    for (const year of [2025, 2026, 2030]) {
      expect(getTaxLine('sch_c.27a', year)?.label).toMatch(/^Energy efficient/);
      expect(getTaxLine('sch_c.27b', year)?.label).toMatch(/^Other expenses/);
      expect(getTaxLine('sch_c.27b', year)?.section).toBe('other_deduction');
    }
  });

  it('sends "other expenses" to whichever line is 27a/27b that year', () => {
    expect(resolveTaxLine('other_expenses', 'sch_c', 2024)?.code).toBe('sch_c.27a');
    expect(resolveTaxLine('other_expenses', 'sch_c', 2025)?.code).toBe('sch_c.27b');
    expect(resolveTaxLine('other_expenses', 'sch_c', 2026)?.code).toBe('sch_c.27b');
    // Schedule C has no bad debt, amortization or royalty line.
    expect(resolveTaxLine('bad_debts', 'sch_c', 2025)?.code).toBe('sch_c.27b');
    expect(resolveTaxLine('amortization', 'sch_c', 2024)?.code).toBe('sch_c.27a');
    expect(resolveTaxLine('royalties', 'sch_c', 2025)?.code).toBe('sch_c.27b');
  });

  it('only Schedule C changes with the year in this range', () => {
    for (const form of TAX_RETURN_FORMS.filter((f) => f !== 'sch_c')) {
      expect(getTaxLineCatalog(form, 2024)).toEqual(getTaxLineCatalog(form, 2026));
    }
  });
});

describe('resolveTaxLine', () => {
  it.each(TAX_RETURN_FORMS.flatMap((form) => YEARS.map((year) => [form, year] as const)))(
    'every category resolves on %s for %i',
    (form, year) => {
      for (const category of TAX_LINE_CATEGORIES) {
        const line = resolveTaxLine(category, form, year);
        expect(line, `${category} on ${form} ${year}`).toBeDefined();
        expect(line?.form).toBe(form);
        // the resolved line is a real catalog line for that year
        expect(getTaxLine(line!.code, year)).toEqual(line);
      }
    },
  );

  it('maps the headline expenses to the documented lines', () => {
    expect(resolveTaxLine('advertising', 'sch_c', 2025)?.code).toBe('sch_c.8');
    expect(resolveTaxLine('meals', 'sch_c', 2025)?.code).toBe('sch_c.24b');
    expect(resolveTaxLine('travel', 'sch_c', 2025)?.code).toBe('sch_c.24a');
    expect(resolveTaxLine('legal_professional', 'sch_c', 2025)?.code).toBe('sch_c.17');
    expect(resolveTaxLine('interest_mortgage', 'sch_c', 2025)?.code).toBe('sch_c.16a');
    expect(resolveTaxLine('interest_other', 'sch_c', 2025)?.code).toBe('sch_c.16b');
    expect(resolveTaxLine('rent_vehicles_equipment', 'sch_c', 2025)?.code).toBe('sch_c.20a');
    expect(resolveTaxLine('rent_other', 'sch_c', 2025)?.code).toBe('sch_c.20b');
    expect(resolveTaxLine('wages', 'sch_c', 2025)?.code).toBe('sch_c.26');
    expect(resolveTaxLine('gross_receipts', 'sch_c', 2025)?.code).toBe('sch_c.1');
    expect(resolveTaxLine('cogs_purchases', 'sch_c', 2025)?.code).toBe('sch_c.36');
    expect(resolveTaxLine('cogs_labor', 'sch_c', 2025)?.code).toBe('sch_c.37');

    expect(resolveTaxLine('officer_compensation', 'f1120s', 2025)?.code).toBe('f1120s.7');
    expect(resolveTaxLine('wages', 'f1120s', 2025)?.code).toBe('f1120s.8');
    expect(resolveTaxLine('advertising', 'f1120s', 2025)?.code).toBe('f1120s.16');
    expect(resolveTaxLine('pension', 'f1120s', 2025)?.code).toBe('f1120s.17');
    expect(resolveTaxLine('insurance', 'f1120s', 2025)?.code).toBe('f1120s.20');

    expect(resolveTaxLine('guaranteed_payments', 'f1065', 2025)?.code).toBe('f1065.10');
    expect(resolveTaxLine('wages', 'f1065', 2025)?.code).toBe('f1065.9');
    expect(resolveTaxLine('depreciation', 'f1065', 2025)?.code).toBe('f1065.16a');
    expect(resolveTaxLine('advertising', 'f1065', 2025)?.code).toBe('f1065.21');

    expect(resolveTaxLine('officer_compensation', 'f1120', 2025)?.code).toBe('f1120.12');
    expect(resolveTaxLine('advertising', 'f1120', 2025)?.code).toBe('f1120.22');
    expect(resolveTaxLine('charitable', 'f1120', 2025)?.code).toBe('f1120.19');
    expect(resolveTaxLine('interest_income', 'f1120', 2025)?.code).toBe('f1120.5');

    expect(resolveTaxLine('officer_compensation', 'f990', 2025)?.code).toBe('f990.ix_5');
    expect(resolveTaxLine('gross_receipts', 'f990', 2025)?.code).toBe('f990.viii_2');
  });

  it('puts COGS on Part III for Schedule C and Form 1125-A elsewhere', () => {
    for (const category of ['cogs_beginning_inventory', 'cogs_purchases', 'cogs_labor', 'cogs_materials', 'cogs_other', 'cogs_ending_inventory']) {
      expect(resolveTaxLine(category, 'sch_c', 2025)?.section, category).toBe('cogs');
      for (const form of ['f1065', 'f1120s', 'f1120'] as const) {
        const line = resolveTaxLine(category, form, 2025);
        expect(line?.section, `${category} ${form}`).toBe('cogs');
        expect(line?.code, `${category} ${form}`).toContain('1125a_');
      }
    }
  });

  it('keeps non-deductible items out of the deductions', () => {
    for (const form of ['sch_c', 'f1065', 'f1120s', 'f1120'] as const) {
      for (const category of ['penalties_nondeductible', 'federal_income_tax']) {
        expect(resolveTaxLine(category, form, 2025)?.section, `${category} ${form}`).toBe('not_deductible');
      }
    }
    expect(resolveTaxLine('federal_income_tax', 'f1120', 2025)?.code).toBe('f1120.m1_2');
    expect(resolveTaxLine('penalties_nondeductible', 'f1120', 2025)?.code).toBe('f1120.m1_5');
    expect(resolveTaxLine('penalties_nondeductible', 'f1120s', 2025)?.code).toBe('f1120s.k16c');
    expect(resolveTaxLine('penalties_nondeductible', 'f1065', 2025)?.code).toBe('f1065.k18c');
    expect(resolveTaxLine('penalties_nondeductible', 'sch_c', 2025)?.code).toBe('sch_c.nd');
  });

  it('routes income, deduction and balance sheet categories to matching sections', () => {
    for (const form of TAX_RETURN_FORMS) {
      expect(resolveTaxLine('gross_receipts', form, 2025)?.section).toBe('income');
      expect(resolveTaxLine('balance_sheet', form, 2025)?.section).toBe('balance_sheet');
      expect(resolveTaxLine('bs_cash', form, 2025)?.section).toBe('balance_sheet');
    }
    for (const form of ['sch_c', 'f1065', 'f1120s', 'f1120'] as const) {
      expect(resolveTaxLine('advertising', form, 2025)?.section).toMatch(/^(deduction|other_deduction)$/);
      expect(resolveTaxLine('interest_income', form, 2025)?.section).toBe('other_income');
    }
  });

  it('maps balance sheet categories to Schedule L lines', () => {
    expect(resolveTaxLine('bs_cash', 'f1120s', 2025)?.code).toBe('f1120s.l1');
    expect(resolveTaxLine('bs_receivables', 'f1120', 2025)?.code).toBe('f1120.l2a');
    expect(resolveTaxLine('bs_fixed_assets', 'f1065', 2025)?.code).toBe('f1065.l9a');
    expect(resolveTaxLine('bs_fixed_assets', 'f1120s', 2025)?.code).toBe('f1120s.l10a');
    expect(resolveTaxLine('bs_payables', 'f1065', 2025)?.code).toBe('f1065.l15');
    expect(resolveTaxLine('bs_payables', 'f1120', 2025)?.code).toBe('f1120.l16');
    expect(resolveTaxLine('bs_retained_earnings', 'f1120s', 2025)?.code).toBe('f1120s.l24');
    expect(resolveTaxLine('bs_retained_earnings', 'f1120', 2025)?.code).toBe('f1120.l25');
    expect(resolveTaxLine('bs_capital', 'f1065', 2025)?.code).toBe('f1065.l21');
    expect(resolveTaxLine('bs_cash', 'sch_c', 2025)?.code).toBe('sch_c.bs');
    expect(resolveTaxLine('bs_cash', 'f990', 2025)?.code).toBe('f990.x');
  });

  it('returns undefined for a category it does not know', () => {
    expect(resolveTaxLine('sch_c.8', 'sch_c', 2025)).toBeUndefined();
    expect(resolveTaxLine('', 'sch_c', 2025)).toBeUndefined();
    expect(resolveTaxLine('nonsense', 'f1120', 2025)).toBeUndefined();
  });
});

describe('meals', () => {
  it('is 50% deductible; everything else is fully deductible', () => {
    expect(getDeductiblePercent('meals')).toBe(50);
    expect(getDeductiblePercent('advertising')).toBe(100);
    expect(getDeductiblePercent('unknown')).toBe(100);
  });

  it('sends the nondeductible half to Schedule K or M-1', () => {
    expect(resolveNondeductibleLine('meals', 'f1065', 2025)?.code).toBe('f1065.k18c');
    expect(resolveNondeductibleLine('meals', 'f1120s', 2025)?.code).toBe('f1120s.k16c');
    expect(resolveNondeductibleLine('meals', 'f1120', 2025)?.code).toBe('f1120.m1_5c');
    // Schedule C and Form 990 report only the deductible amount.
    expect(resolveNondeductibleLine('meals', 'sch_c', 2025)).toBeUndefined();
    expect(resolveNondeductibleLine('meals', 'f990', 2025)).toBeUndefined();
    expect(resolveNondeductibleLine('advertising', 'f1120', 2025)).toBeUndefined();
  });
});
