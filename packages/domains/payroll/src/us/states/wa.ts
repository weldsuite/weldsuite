/**
 * Washington: no wage income tax. UI with the employment administration
 * fund, Paid Family and Medical Leave, and WA Cares.
 *
 * Sources (fetched 9 October 2026):
 * - ESD, "Paid Family & Medical Leave premium rate increases to 1.13% in
 *   2026", https://esd.wa.gov/about-us/news-release/2025/paid-family-medical-leave-premium-rate-increases-113-2026,
 *   and https://paidleave.wa.gov/employer-roles-responsibilities/: 1.13% of
 *   gross wages excluding tips, up to the Social Security wage base
 *   ($184,500); employees pay 71.43%, employers 28.57%; employers ESD
 *   classifies as having fewer than 50 employees owe no employer share (unless
 *   they took a small business assistance grant) but still collect the
 *   employee share.
 * - WA Cares Fund, https://wacaresfund.wa.gov/exemptions and the employer
 *   toolkit (updated 18 August 2026): 0.58% of gross wages excluding tips, no
 *   wage cap, employee only; an employee with an ESD exemption approval letter
 *   given to the employer is not charged (from the effective date on the letter).
 * - ESD, "2026 tax rates for employers",
 *   https://esd.wa.gov/media/pdf/4819/2026-unemployment-tax-rates-employerspdf/download:
 *   the total rate is the UI rate (experience + social cost) plus the
 *   employment administration fund (EAF, 0.03%); and the taxable wage base
 *   page, https://esd.wa.gov/employer-requirements/unemployment-taxes/how-we-determine-tax-rates/taxable-wage-base:
 *   $78,200 in 2026. New employers get 115% of their industry's average rate
 *   (no single statewide rate), so a missing rate is an error here.
 *   The notice's total rate also includes the EAF (RCW 50.24.014: 0.03% for
 *   rate classes 1–19 and 21–39; 0.02% for classes 20 and 40 and for new
 *   employers). Here `suiRatePercent` is the UI rate without the EAF, which
 *   is its own line (`extraRates.wa_eaf`, default 0.03%). No solvency
 *   surcharge applies in 2026 (ESD UI trust fund forecast, March 2026).
 *
 * Not verified: which pre-tax items count as Paid Leave / WA Cares wages.
 * ESD says "gross wages" (RCW 50A.05.010) and excludes payments into
 * retirement plans without saying whether employee 401(k) deferrals are
 * meant. The module uses gross wages and flags `provisional_rules` when a
 * payslip has pre-tax deductions.
 */

import { NO_EXCLUSIONS, certBoolean, computeProgram, computeSharedProgram, d, rateCode, taxableWages } from './common';
import { noIncomeTaxModule } from './no-income-tax';
import type { PayrollIssue } from '../../types';

const STATE = 'WA';
const PFML_RATE_PERCENT = 1.13;
const PFML_EMPLOYEE_SHARE = 0.7143;
const PFML_SMALL_EMPLOYER_LIMIT = 50;
const PFML_WAGE_BASE = d(184500);
const WA_CARES_RATE_PERCENT = 0.58;

export const WA_MODULE = noIncomeTaxModule({
  code: STATE,
  name: 'Washington',
  employerRateCodes: [rateCode('wa_eaf', 0.03), rateCode('wa_pfml_employee', 0.807159)],
  ruleSet: 'us-wa-2026.1',
  sui: () => ({
    wageBaseCents: d(78200),
    newEmployerRatePercent: null,
    surcharges: [{ code: 'wa_eaf', labelKey: 'us.state_program.wa_eaf', rateKey: 'wa_eaf', defaultRatePercent: 0.03 }],
  }),
  provisional: (input) => {
    const p = input.pretax;
    return p.retirement401kCents + p.section125Cents + p.hsaCents + p.dependentCareCents > 0 ? ['Paid Leave and WA Cares wages of pre-tax deductions'] : [];
  },
  programs: (input, ytd) => {
    const issues: PayrollIssue[] = [];
    const wages = taxableWages(input, NO_EXCLUSIONS).total;
    const headcount = input.employeeCountEstimate;
    if (headcount === null) issues.push({ severity: 'warning', code: 'employer_incomplete', params: { state: STATE, field: 'employeeCountEstimate' } });
    const employerOwes = headcount === null || headcount >= PFML_SMALL_EMPLOYER_LIMIT;
    // Employee: wages × 1.13% × 71.43%, rounded; employer: the total premium minus that (toolkit v25.1 p. 18–21).
    // The employer may pay (part of) the employee share itself: `extraRates.wa_pfml_employee` (percent).
    const pfml = computeSharedProgram(
      input,
      STATE,
      {
        code: 'wa_pfml',
        labelKey: 'us.state_program.wa_pfml',
        wagesCents: wages,
        wageBaseCents: PFML_WAGE_BASE,
        totalRatePercent: PFML_RATE_PERCENT,
        employeeMaxRatePercent: PFML_RATE_PERCENT * PFML_EMPLOYEE_SHARE,
        employeeRatePercent: input.extraRates.wa_pfml_employee,
        employerOwesShare: employerOwes,
      },
      ytd,
    );
    const cares = computeProgram(
      input,
      STATE,
      {
        code: 'wa_cares',
        labelKey: 'us.state_program.wa_cares',
        wagesCents: certBoolean(input, 'wa_cares_exempt') ? 0 : wages,
        wageBaseCents: null,
        employeeRatePercent: WA_CARES_RATE_PERCENT,
        employerRatePercent: 0,
      },
      ytd,
    );
    return { programs: [pfml, cares], issues };
  },
  certificate: {
    formName: 'WA Cares exemption',
    usesAllowances: false,
    fields: [{ key: 'wa_cares_exempt', type: 'boolean', labelKey: 'WA.wa_cares_exempt' }],
  },
});
