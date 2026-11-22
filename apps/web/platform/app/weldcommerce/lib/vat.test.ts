import { describe, expect, it } from 'vitest';
import { isVatCategory, rateText, vatCategoryLabel, vatTreatmentText } from './vat';

describe('vatCategoryLabel', () => {
  it('words every category, and shows an unknown one as it came', () => {
    expect(vatCategoryLabel('standard')).toBe('Standard rate');
    expect(vatCategoryLabel('reduced')).toBe('Reduced rate');
    expect(vatCategoryLabel('super_reduced')).toBe('Super-reduced rate');
    expect(vatCategoryLabel('zero')).toBe('Zero rate (0%)');
    expect(vatCategoryLabel('exempt')).toBe('Exempt (0%)');
    expect(vatCategoryLabel('luxury')).toBe('luxury');
    expect(vatCategoryLabel(null)).toBe('—');
  });

  it('knows the categories the API takes', () => {
    expect(isVatCategory('super_reduced')).toBe(true);
    expect(isVatCategory('luxury')).toBe(false);
    expect(isVatCategory(null)).toBe(false);
  });
});

describe('rateText', () => {
  it('prints a rate before a percent sign without trailing zeros', () => {
    expect(rateText('21.00')).toBe('21');
    expect(rateText('5.50')).toBe('5.5');
    expect(rateText('0.00')).toBe('0');
    expect(rateText(null)).toBe('—');
  });
});

describe('vatTreatmentText', () => {
  it('words each treatment, with the destination where it matters', () => {
    expect(vatTreatmentText('oss', 'DE')).toMatch(/One-Stop Shop.*rate of DE/);
    expect(vatTreatmentText('reverse_charge', 'DE')).toMatch(/Reverse charge/);
    expect(vatTreatmentText('domestic', 'NL')).toMatch(/Domestic/);
    expect(vatTreatmentText('outside_eu', 'US')).toMatch(/outside the EU/);
    expect(vatTreatmentText('imported', null)).toMatch(/store/);
  });

  it('is null when no VAT was calculated', () => {
    expect(vatTreatmentText(null, null)).toBeNull();
  });
});
