import { describe, expect, it } from 'vitest';
import { STATE_CERTIFICATE_LABELS } from './certificate-labels';
import { SUPPORTED_STATES, stateIncomeTaxLabelKey, stateModule, stateSuiEmployeeLabelKey, stateSuiEmployerLabelKey } from './index';
import { STATE_EMPLOYER_RATE_LABELS, STATE_PAYSLIP_LABELS, STATE_SUI_RATE_NOTES } from './labels';
import { stateInput } from './test-input';

describe('state module registry', () => {
  it('covers the 19 v1 states, sorted', () => {
    expect(SUPPORTED_STATES).toEqual(['AK', 'AZ', 'CA', 'CO', 'FL', 'GA', 'IL', 'MA', 'NC', 'NH', 'NJ', 'NV', 'NY', 'PA', 'SD', 'TN', 'TX', 'WA', 'WY']);
    expect(stateModule('ca')?.code).toBe('CA');
    expect(stateModule('OH')).toBeUndefined();
    expect(stateModule(null)).toBeUndefined();
  });

  it('has a module whose code, rule set and income-tax flag line up', () => {
    const withTax = ['AZ', 'CA', 'CO', 'GA', 'IL', 'MA', 'NC', 'NJ', 'NY', 'PA'];
    for (const code of SUPPORTED_STATES) {
      const module = stateModule(code)!;
      expect(module.code).toBe(code);
      expect(module.supportedYears).toEqual([2026]);
      expect(module.hasIncomeTax).toBe(withTax.includes(code));
      const r = module.calculate(stateInput(code, { regularWagesCents: 100000, periodsPerYear: 26, suiRatePercent: 1 }));
      expect(r.ruleSet).toBe(`us-${code.toLowerCase()}-2026.${code === 'GA' ? 2 : 1}`);
    }
  });

  it('labels every payslip line a module can produce, in English and Dutch', () => {
    for (const code of SUPPORTED_STATES) {
      const module = stateModule(code)!;
      const r = module.calculate(
        stateInput(code, { regularWagesCents: 500000, supplementalWagesCents: 10000, periodsPerYear: 26, suiRatePercent: 1, employeeCountEstimate: 100 }),
      );
      const keys = [stateSuiEmployerLabelKey(code), ...r.programs.map((p) => p.labelKey)];
      if (module.hasIncomeTax) keys.push(stateIncomeTaxLabelKey(code));
      if (r.sui.employeeCents > 0) keys.push(stateSuiEmployeeLabelKey(code));
      for (const key of keys) {
        expect(STATE_PAYSLIP_LABELS[key], `${code}: ${key}`).toBeDefined();
        expect(STATE_PAYSLIP_LABELS[key].en.length).toBeGreaterThan(0);
        expect(STATE_PAYSLIP_LABELS[key].nl.length).toBeGreaterThan(0);
      }
    }
    expect(STATE_PAYSLIP_LABELS['us.state_income_tax.CA']).toEqual({ en: 'California income tax', nl: 'Inkomstenbelasting Californië' });
  });

  it('labels every certificate field, select option and form', () => {
    for (const code of SUPPORTED_STATES) {
      const certificate = stateModule(code)!.certificate;
      if (!certificate) continue;
      expect(STATE_CERTIFICATE_LABELS[`${code}.form`], `${code}.form`).toBeDefined();
      for (const field of certificate.fields) {
        expect(field.labelKey).toBe(`${code}.${field.key}`);
        expect(STATE_CERTIFICATE_LABELS[field.labelKey], field.labelKey).toBeDefined();
        for (const option of field.options ?? []) {
          expect(STATE_CERTIFICATE_LABELS[`${field.labelKey}.${option}`], `${field.labelKey}.${option}`).toBeDefined();
        }
      }
      if (certificate.filingStatuses) {
        const statusField = certificate.fields.find((f) => f.key === 'filingStatus');
        expect(statusField?.options).toEqual(certificate.filingStatuses);
      }
    }
  });

  it('labels every employer rate code and explains every state’s SUI rate field', () => {
    for (const code of SUPPORTED_STATES) {
      const module = stateModule(code)!;
      expect(STATE_SUI_RATE_NOTES[code], code).toBeDefined();
      for (const rate of module.employerRateCodes ?? []) {
        expect(rate.labelKey).toBe(`employer_rate.${rate.code}`);
        expect(STATE_EMPLOYER_RATE_LABELS[rate.labelKey], rate.labelKey).toBeDefined();
      }
    }
    expect(stateModule('CA')!.employerRateCodes).toEqual([{ code: 'ca_ett', labelKey: 'employer_rate.ca_ett', defaultPercent: 0.1 }]);
    expect(stateModule('TX')!.employerRateCodes).toBeUndefined();
  });

  it('Wyoming, like Washington, needs the rate from the employer’s notice: no single new-employer rate exists', () => {
    const r = stateModule('WY')!.calculate(stateInput('WY', { regularWagesCents: 500000, periodsPerYear: 12, suiRatePercent: null }));
    expect(r.issues).toContainEqual({ severity: 'error', code: 'employer_incomplete', params: { state: 'WY', field: 'suiRate' } });
    const rated = stateModule('WY')!.calculate(stateInput('WY', { regularWagesCents: 500000, periodsPerYear: 12, suiRatePercent: 1.5, ytd: { 'us.state.WY.sui_wages': 3000000 } }));
    expect(rated.sui).toMatchObject({ taxableWagesCents: 380000, employerCents: 5700 });
  });
});
