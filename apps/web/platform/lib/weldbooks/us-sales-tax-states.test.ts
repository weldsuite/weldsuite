import { describe, expect, it } from 'vitest';
import {
  US_STATES as DOMAIN_STATES,
  getCertificateRules as domainCertificateRules,
  salesTaxStates as domainSalesTaxStates,
} from '../../../../../packages/domains/books/src/jurisdictions/us/states';
import {
  allUsStates,
  certificateRuleApplies,
  certificateRulesOf,
  defaultAgencyName,
  defaultDueDayNumber,
  getSalesTaxState,
  salesTaxStateName,
  salesTaxStates,
} from './us-sales-tax-states';

describe('us-sales-tax-states mirror of the books domain', () => {
  it('lists the same states with the same facts', () => {
    expect(allUsStates()).toHaveLength(DOMAIN_STATES.length);
    for (const domain of DOMAIN_STATES) {
      const mirror = getSalesTaxState(domain.code);
      expect(mirror, domain.code).toBeDefined();
      expect(mirror).toMatchObject({
        name: domain.name,
        hasStateSalesTax: domain.hasStateSalesTax,
        hasLocalSalesTax: domain.hasLocalSalesTax,
        intrastateSourcing: domain.intrastateSourcing,
        sst: domain.sst,
        agencyName: domain.agencyName,
        portalUrl: domain.portalUrl,
        cashBasisAllowed: domain.cashBasisAllowed,
        defaultDueDay: domain.defaultDueDay,
      });
      expect(mirror?.vendorDiscount?.percent, domain.code).toBe(domain.vendorDiscount?.percent);
      expect(mirror?.vendorDiscount?.capPerReturn, domain.code).toBe(domain.vendorDiscount?.capPerReturn);
      expect(mirror?.specialPrograms, domain.code).toEqual(domain.specialPrograms);
      expect(mirror?.taxName, domain.code).toBe(domain.taxName);
    }
  });

  it('offers the same states to register in', () => {
    expect(salesTaxStates().map((s) => s.code)).toEqual(domainSalesTaxStates().map((s) => s.code));
  });

  it('applies the same certificate expiry rules', () => {
    for (const domain of DOMAIN_STATES) {
      const mirror = certificateRulesOf(domain.code);
      const expected = domainCertificateRules(domain.code);
      expect(mirror.map((r) => r.expiry), domain.code).toEqual(expected.map((r) => r.expiry));
      expect(mirror.map((r) => r.forms), domain.code).toEqual(expected.map((r) => r.forms));
      expect(mirror.map((r) => r.reasons), domain.code).toEqual(expected.map((r) => r.reasons));
      expect(mirror.map((r) => Boolean(r.blanketOnly)), domain.code).toEqual(expected.map((r) => Boolean(r.blanketOnly)));
    }
  });
});

describe('state helpers', () => {
  it('looks a state up by any case and names unknown codes as they are', () => {
    expect(getSalesTaxState('tx')?.name).toBe('Texas');
    expect(salesTaxStateName('TX')).toBe('Texas');
    expect(salesTaxStateName('ZZ')).toBe('ZZ');
    expect(salesTaxStateName(null)).toBe('');
  });

  it('leaves out the states with no sales tax at all', () => {
    const codes = salesTaxStates().map((s) => s.code);
    expect(codes).toContain('TX');
    expect(codes).toContain('AK');
    expect(codes).not.toContain('OR');
    expect(codes).not.toContain('MT');
  });

  it('turns a "last day" due day into 31 and names a default agency', () => {
    expect(defaultDueDayNumber(getSalesTaxState('CA')!)).toBe(31);
    expect(defaultDueDayNumber(getSalesTaxState('TX')!)).toBe(20);
    expect(defaultAgencyName(getSalesTaxState('TX')!)).toBe('Texas Comptroller of Public Accounts');
  });

  it('knows which certificate rule covers which certificate', () => {
    const florida = certificateRulesOf('FL')[0];
    expect(certificateRuleApplies(florida, { reason: 'resale', form: 'state_form', blanket: true })).toBe(true);
    expect(certificateRuleApplies(florida, { reason: 'nonprofit', form: 'state_form', blanket: true })).toBe(false);
    const sst = certificateRulesOf('OH').at(-1)!;
    expect(certificateRuleApplies(sst, { reason: 'resale', form: 'sst_f0003', blanket: true })).toBe(true);
    expect(certificateRuleApplies(sst, { reason: 'resale', form: 'sst_f0003', blanket: false })).toBe(false);
  });
});
