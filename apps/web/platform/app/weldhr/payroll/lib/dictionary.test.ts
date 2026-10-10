/**
 * The payroll dictionaries: English and Dutch have the same keys and
 * placeholders, and every component and issue code of the payroll engines has a
 * label, so a code added to @weldsuite/payroll-domain without a string fails here
 * instead of showing a raw key in the UI.
 */

import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { ISSUE_CODES, PAY_COMPONENTS } from '@weldsuite/payroll-domain/components';

function leaves(value: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      for (const [path, text] of leaves(child, prefix ? `${prefix}.${key}` : key)) out.set(path, text);
    }
  } else {
    out.set(prefix, String(value));
  }
  return out;
}

function placeholders(text: string): string {
  return [...text.matchAll(/\{(\w+)\}/g)]
    .map((match) => match[1])
    .sort()
    .join(',');
}

const english = leaves(en.weldhr.payroll);
const dutch = leaves(nl.weldhr.payroll);

describe('weldhr.payroll dictionaries', () => {
  it('has the same keys in English and Dutch', () => {
    expect([...dutch.keys()].sort()).toEqual([...english.keys()].sort());
  });

  it('uses the same placeholders in both languages', () => {
    const mismatches = [...english].filter(([key, text]) => placeholders(text) !== placeholders(dutch.get(key) ?? '')).map(([key]) => key);
    expect(mismatches).toEqual([]);
  });

  it('labels every pay component of the engines', () => {
    const missing = PAY_COMPONENTS.map((component) => component.labelKey).filter((labelKey) => !english.has(`components.${labelKey}`));
    expect(missing).toEqual([]);
  });

  it('describes every parameter of the pay components', () => {
    const keys = new Set(PAY_COMPONENTS.flatMap((component) => (component.params ?? []).map((param) => param.key)));
    expect([...keys].filter((key) => !english.has(`params.${key}`))).toEqual([]);
  });

  it('describes every issue code of the engines', () => {
    const codes = [
      ...ISSUE_CODES,
      // Raised by the engines and the payment-file builder; not (yet) in ISSUE_CODES.
      'provisional_rules',
      'residence_state_differs',
      'local_tax_not_supported',
      'employer_incomplete',
      'invalid_routing_number',
      'invalid_account_number',
      'invalid_amount',
      'sick_pay_below_statutory',
      'expat_salary_norm',
      'awf_revision_required',
      'dga_usual_salary',
      // The loonaangifte builder.
      'correction_saldo_unknown',
      'duplicate_correction_period',
      'invalid_correction_period',
      'invalid_bsn',
      'invalid_loonheffingennummer',
      'invalid_period',
      'missing_address',
      'missing_income_relationship_number',
      'missing_personnel_number',
      'missing_software_relation_number',
      'too_many_corrections',
      'end_reason_defaulted',
      'nationality_unknown',
      'invalid_postal_code',
    ];
    expect(codes.filter((code) => !english.has(`issues.${code}`))).toEqual([]);
  });
});
