/**
 * US payroll engine: federal calculation (calculate.ts), the per-year federal
 * rules (federal-2026.ts), state modules (states/), labels, and the filings
 * built from final payslips (forms.ts).
 */

export { calculateUsPayslip, calculateUsPayslipWith, workweekEnd, type UsEngineDeps } from './calculate';
export { federalRules, futaCreditReductionPercent, SUPPORTED_FEDERAL_YEARS, FUTA_CREDIT_REDUCTION, type FederalRules } from './federal-rules';
export { US_PAYSLIP_LABELS, usPayslipLabels } from './labels';
export { US_YTD, US_YTD_KEYS, US_OT_CARRY_PREFIX } from './ytd';
export { workweekStart } from './overtime';
