/**
 * US payroll engine. Placeholder until the engine lands: every calculation
 * reports `unsupported_tax_year`.
 */

import type { PayslipResult, UsPayslipInput } from '../types';

export function calculateUsPayslip(input: UsPayslipInput): PayslipResult {
  return {
    lines: [],
    grossCents: 0,
    taxableWageCents: 0,
    employeeTaxesCents: 0,
    employeeDeductionsCents: 0,
    reimbursementsCents: 0,
    netCents: 0,
    employerTaxesCents: 0,
    employerCostCents: 0,
    ytd: { ...input.ytd },
    filingData: {
      kind: 'us',
      federal: {
        fitWages: 0, federalIncomeTax: 0, ssWages: 0, ssTaxEmployee: 0, ssTaxEmployer: 0,
        medicareWages: 0, medicareTaxEmployee: 0, medicareTaxEmployer: 0, additionalMedicareWages: 0,
        additionalMedicareTax: 0, futaGrossWages: 0, futaWages: 0, futaTax: 0, ssTips: 0, box12: {}, dependentCare: 0,
      },
      states: {},
      qualifiedOvertimePremium: 0,
      hoursWorked: 0,
    },
    issues: [{ severity: 'error', code: 'unsupported_tax_year', params: { year: input.period.taxYear } }],
    ruleSet: 'us-none',
  };
}
