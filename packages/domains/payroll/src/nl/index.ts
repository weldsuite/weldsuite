/**
 * Dutch payroll engine: gross to net (`calculateNlPayslip`), the rules per tax
 * year, the year-to-date accumulators hr-api reads back, and the wage-tax
 * arithmetic. Filing (loonaangifte), the jaaropgaaf and Digipoort live in
 * their own modules (`./loonaangifte`, `./annual-statement`, `./digipoort`).
 */

export { calculateNlPayslip, nlAowDate, nlAgeColumn } from './calculate';
export { nlRulesForYear, supportedNlTaxYears, type NlRuleSet } from './rules';
export { NL_YTD_KEYS, nlAnnualWageForSpecialRewards, nlHolidayAllowanceBalance, ytdValue, type NlYtdKey } from './ytd';
export { periodWageTax, specialRewardPercent, specialRewardTax, anonymousTax, PERIOD_FACTOR, type NlAgeColumn } from './wage-tax';
export { NL_PAYSLIP_LABELS } from './labels';
