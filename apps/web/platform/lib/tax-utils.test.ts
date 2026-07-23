import { describe, it, expect } from 'vitest';
import { getTaxTypes } from './tax-utils';

describe('getTaxTypes', () => {
  it('returns the full list of supported tax types', () => {
    const types = getTaxTypes();
    expect(types).toHaveLength(8);
    expect(types.map((t) => t.value)).toEqual([
      'SALES_TAX',
      'VAT',
      'GST',
      'INCOME_TAX',
      'PAYROLL_TAX',
      'PROPERTY_TAX',
      'EXCISE_TAX',
      'OTHER',
    ]);
  });

  it('every entry has value + label + description', () => {
    for (const t of getTaxTypes()) {
      expect(t.value).toMatch(/^[A-Z_]+$/);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });
});
