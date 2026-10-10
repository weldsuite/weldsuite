/**
 * Payslip line labels of the US federal engine, keyed by `PayslipLine.labelKey`.
 * State lines (state income tax programs, SDI, PFML…) carry the state
 * modules' own keys; `usPayslipLabels()` merges both.
 */

import { STATE_PAYSLIP_LABELS } from './states/labels';

export const US_PAYSLIP_LABELS: Record<string, { en: string; nl: string }> = {
  // Earnings
  'us.salary': { en: 'Salary', nl: 'Salaris' },
  'us.regular_hours': { en: 'Regular hours', nl: 'Gewerkte uren' },
  'us.overtime_premium': { en: 'Overtime premium (half-time)', nl: 'Overwerktoeslag (half uurloon)' },
  'us.double_time_premium': { en: 'Double-time premium', nl: 'Toeslag dubbel uurloon' },
  'us.overtime': { en: 'Overtime (1.5×)', nl: 'Overwerk (1,5×)' },
  'us.double_time': { en: 'Double time (2×)', nl: 'Dubbel uurloon (2×)' },
  'us.overtime_manual': { en: 'Overtime', nl: 'Overwerk' },
  'us.paid_leave': { en: 'Paid leave', nl: 'Betaald verlof' },
  'us.unpaid_leave': { en: 'Unpaid leave', nl: 'Onbetaald verlof' },
  'us.bonus': { en: 'Bonus', nl: 'Bonus' },
  'us.commission': { en: 'Commission', nl: 'Commissie' },
  'us.allowance_taxable': { en: 'Taxable allowance', nl: 'Belaste vergoeding' },
  'us.tips_cash': { en: 'Cash tips reported', nl: 'Opgegeven contante fooien' },
  'us.tips_received': { en: 'Cash tips already received', nl: 'Al ontvangen contante fooien' },
  // Employee taxes
  'us.federal_income_tax': { en: 'Federal income tax', nl: 'Federale inkomstenbelasting' },
  'us.social_security': { en: 'Social Security', nl: 'Social Security' },
  'us.medicare': { en: 'Medicare', nl: 'Medicare' },
  'us.additional_medicare': { en: 'Additional Medicare tax', nl: 'Aanvullende Medicare-belasting' },
  'us.state_income_tax': { en: 'State income tax', nl: 'Inkomstenbelasting van de staat' },
  'us.sui_employee': { en: 'State unemployment insurance', nl: 'Werkloosheidsverzekering van de staat' },
  // Deductions
  'us.401k': { en: '401(k) deferral (pre-tax)', nl: '401(k)-inleg (voor belasting)' },
  'us.roth_401k': { en: 'Roth 401(k) deferral', nl: 'Roth 401(k)-inleg' },
  'us.section125_health': { en: 'Health insurance premium (pre-tax)', nl: 'Premie zorgverzekering (voor belasting)' },
  'us.hsa': { en: 'HSA contribution (pre-tax)', nl: 'HSA-inleg (voor belasting)' },
  'us.dependent_care': { en: 'Dependent care FSA (pre-tax)', nl: 'Kinderopvang-FSA (voor belasting)' },
  'us.deduction_net': { en: 'Deduction', nl: 'Inhouding' },
  // Reimbursements
  'us.reimbursement': { en: 'Expense reimbursement', nl: 'Onkostenvergoeding' },
  'us.advance': { en: 'Advance', nl: 'Voorschot' },
  // Employer
  'us.social_security_employer': { en: 'Social Security (employer)', nl: 'Social Security (werkgever)' },
  'us.medicare_employer': { en: 'Medicare (employer)', nl: 'Medicare (werkgever)' },
  'us.futa': { en: 'Federal unemployment tax (FUTA)', nl: 'Federale werkloosheidsbelasting (FUTA)' },
  'us.sui_employer': { en: 'State unemployment insurance (employer)', nl: 'Werkloosheidsverzekering van de staat (werkgever)' },
  'us.401k_employer_match': { en: '401(k) employer match', nl: '401(k)-bijdrage werkgever' },
  'us.employer_health': { en: 'Health insurance (employer share)', nl: 'Zorgverzekering (deel werkgever)' },
  // Info
  'us.qualified_overtime': { en: 'Qualified overtime compensation (W-2 box 12, code TT)', nl: 'Gekwalificeerde overwerkvergoeding (W-2 box 12, code TT)' },
};

/** Federal and state payslip labels together (state modules' keys first, federal keys win on a clash). */
export function usPayslipLabels(): Record<string, { en: string; nl: string }> {
  return { ...STATE_PAYSLIP_LABELS, ...US_PAYSLIP_LABELS };
}
