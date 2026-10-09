/**
 * Dutch payroll engine. Placeholder until the engine lands: every
 * calculation reports `unsupported_tax_year`.
 */

import type { NlPayslipInput, PayslipResult } from '../types';

export function calculateNlPayslip(input: NlPayslipInput): PayslipResult {
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
      kind: 'nl',
      tableCode: '010',
      applyLoonheffingskorting: input.nl.applyLoonheffingskorting,
      anonymous: input.nl.anonymous,
      insured: { ww: input.nl.insuredWw, zw: input.nl.insuredZw, wao: input.nl.insuredWao },
      awfRate: 'high',
      aofRate: 'high',
      zvw: 'employer_levy',
      contract: { written: input.nl.writtenContract, indefinite: input.nl.indefiniteContract, onCall: input.nl.onCall },
      amounts: {
        loonLbPh: 0, loonSv: 0, premieloonAwf: 0, premieloonAof: 0, premieloonWhk: 0, loonZvw: 0,
        loonTabelBijzondereBeloningen: 0, wageTax: 0, labourCredit: 0, awfPremium: 0, aofPremium: 0,
        wkoPremium: 0, whkPremium: 0, zvwEmployerLevy: 0, zvwWithheld: 0, holidayAllowancePaid: 0,
        holidayAllowanceAccrued: 0, companyCarValue: 0, companyCarEmployeeContribution: 0,
        pensionEmployee: 0, taxFreeAllowances: 0,
      },
      hoursPaid: 0,
      svDays: 0,
    },
    issues: [{ severity: 'error', code: 'unsupported_tax_year', params: { year: input.period.taxYear } }],
    ruleSet: 'nl-none',
  };
}
