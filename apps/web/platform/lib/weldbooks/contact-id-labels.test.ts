import { describe, expect, it } from 'vitest';
import { contactIdLabels } from './contact-id-labels';

const tt = {
  taxId: { vat_number: 'VAT number', gstin: 'GSTIN', cnpj: 'CNPJ', ein: 'EIN', tax_id: 'Tax ID' },
  registrationId: {
    kvk: 'Chamber of Commerce (KvK) number',
    kbo: 'Enterprise number (KBO/BCE)',
    pan: 'PAN',
    company_number: 'Company registration number',
    state_id: 'State registration number',
    ie: 'State registration (IE)',
  },
};
const entity = { taxId: 'VAT number', registrationId: 'Chamber of Commerce (KvK) number' };

describe('contactIdLabels', () => {
  it('names the KvK number for NL only', () => {
    expect(contactIdLabels('NL', tt, entity).registrationId).toBe('Chamber of Commerce (KvK) number');
    expect(contactIdLabels('BE', tt, entity).registrationId).not.toMatch(/KvK/);
    expect(contactIdLabels('DE', tt, entity).registrationId).not.toMatch(/KvK/);
  });

  it('Belgium: enterprise number (KBO/BCE); other EU: company registration number', () => {
    expect(contactIdLabels('BE', tt, entity)).toEqual({ taxId: 'VAT number', registrationId: 'Enterprise number (KBO/BCE)' });
    expect(contactIdLabels('FR', tt, entity)).toEqual({ taxId: 'VAT number', registrationId: 'Company registration number' });
    expect(contactIdLabels('de', tt, entity).registrationId).toBe('Company registration number');
  });

  it('US: Tax ID and no registration field; India: GSTIN and PAN', () => {
    expect(contactIdLabels('US', tt, entity)).toEqual({ taxId: 'Tax ID', registrationId: null });
    expect(contactIdLabels('IN', tt, entity)).toEqual({ taxId: 'GSTIN', registrationId: 'PAN' });
  });

  it('Brazil: CNPJ and the state registration (IE)', () => {
    expect(contactIdLabels('BR', tt, entity)).toEqual({ taxId: 'CNPJ', registrationId: 'State registration (IE)' });
  });

  it("falls back to the entity's own words without a country", () => {
    expect(contactIdLabels('', tt, entity)).toEqual(entity);
    expect(contactIdLabels(null, tt, entity)).toEqual(entity);
    expect(contactIdLabels('Belgium', tt, entity)).toEqual(entity);
  });
});
