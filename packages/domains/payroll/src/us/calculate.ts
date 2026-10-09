/**
 * US payslip calculation: gross pay, overtime, pre-tax benefits, federal
 * income tax withholding, FICA, FUTA, and the work state's taxes through its
 * state module. Pure: no clock, no randomness, no I/O.
 *
 * Methods chosen where the rules leave a choice (all documented in the
 * report and the code next to them):
 * - Salary per period: the compensation is annualized (year × 1, month × 12,
 *   week × 52, hour × hours per week × 52) and divided by the period's
 *   `periodsPerYear`. A weekly salary on a weekly/biweekly schedule and a
 *   monthly salary on a monthly/semimonthly schedule are paid as is (× 1, × 2,
 *   ÷ 2), so no rounding drift appears.
 * - Partial first/last period of a salaried employee: prorated by weekdays
 *   (Monday–Friday) employed in the period over weekdays in the period, with
 *   a `partial_period` warning.
 * - Hourly rate of a salaried employee (unpaid leave, overtime): annual
 *   salary ÷ (hours per week × 52), 40 hours when unknown.
 * - Federal income tax: Pub 15-T percentage method (Worksheet 1A) on regular
 *   wages; bonuses and commissions as supplemental wages identified
 *   separately (Pub 15 section 7): 22% flat, 37% on the part of the year's
 *   supplemental wages above $1 million, aggregate method when nothing was
 *   withheld from regular wages yet this year. Tips and overtime are treated
 *   as regular wages (Pub 15 allows either). Step 4(c) extra withholding is
 *   added only on payslips with regular wages.
 * - FICA rounding: per payslip, half away from zero, trued up to the
 *   year-to-date total when that differs by at most one cent, so a year's
 *   W-2 box 4 equals 6.2% of boxes 3 + 7 rounded.
 * - The Social Security wage base is applied to wages first, then tips.
 * - Pre-tax deductions reduce regular wages first; whatever regular wages
 *   cannot absorb reduces supplemental wages.
 * - Cash tips are wages for every tax and part of gross, but the employee
 *   already has them: a "tips already received" line takes them back out
 *   of net pay, and they are not an employer cost.
 */

import { percentOf, roundHalfAwayFromZero, type Cents } from '../money';
import { addDays, ageOn, weekdaysBetween } from '../periods';
import type {
  CompensationInput,
  PayrollIssue,
  PayslipLine,
  PayslipResult,
  UsFilingData,
  UsPayslipInput,
} from '../types';
import { federalRules, futaCreditReductionPercent, type FederalRules } from './federal-rules';
import { computeOvertime, workweekStart, type HoursEntry, type OvertimeLine } from './overtime';
import { stateModule as defaultStateModule } from './states';
import type { StateCalcInput, StateModule } from './states/types';
import { effectiveW4, nraAdditionCents, supplementalWithholding, worksheet1A } from './withholding';
import { US_YTD } from './ytd';

export interface UsEngineDeps {
  /** The state module for a two-letter code; injected in tests. */
  stateModule: (code: string) => StateModule | undefined;
}

const FICA_BASES = ['us.fit_wages', 'us.ss_wages', 'us.medicare_wages', 'us.futa_wages'];
const TIP_BASES = ['us.fit_wages', 'us.ss_tips', 'us.medicare_wages', 'us.futa_wages'];

/** Every code the US engine understands (anything else on a US payslip is `unsupported_component`). */
const US_CODES = new Set([
  'hours.regular',
  'hours.overtime',
  'hours.unpaid_leave',
  'hours.paid_leave',
  'bonus',
  'commission',
  'allowance.taxable',
  'reimbursement',
  'deduction.net',
  'advance',
  'us.tips_cash',
  'us.401k',
  'us.roth_401k',
  'us.401k_employer_match',
  'us.section125_health',
  'us.employer_health',
  'us.hsa',
  'us.dependent_care',
]);

/** A run input or a recurring component, in one shape. */
interface Item {
  code: string;
  label: string | null;
  quantity: number | null;
  rate: number | null;
  amountCents: Cents | null;
  workDate: string | null;
  params: Record<string, number | string | boolean | null>;
}

function itemsOf(input: UsPayslipInput): Item[] {
  const fromComponents: Item[] = input.components.map((c) => ({
    code: c.code,
    label: c.label ?? null,
    quantity: null,
    rate: null,
    amountCents: c.amountCents,
    workDate: null,
    params: c.params ?? {},
  }));
  const fromInputs: Item[] = input.inputs.map((i) => ({
    code: i.code,
    label: i.label ?? null,
    quantity: i.quantity,
    rate: i.rate,
    amountCents: i.amountCents,
    workDate: i.workDate,
    params: {},
  }));
  return [...fromComponents, ...fromInputs];
}

function num(v: number | string | boolean | null | undefined): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Annual pay in cents (fractional allowed). */
function annualCents(comp: CompensationInput): number {
  const amount = comp.amount * 100;
  switch (comp.period) {
    case 'year':
      return amount;
    case 'month':
      return amount * 12;
    case 'week':
      return amount * 52;
    case 'hour':
      return amount * (comp.hoursPerWeek ?? 40) * 52;
  }
}

/** Hourly rate in cents (fractional allowed); null without compensation. */
function hourlyRateCents(comp: CompensationInput | null): number | null {
  if (!comp || !Number.isFinite(comp.amount)) return null;
  if (comp.period === 'hour') return comp.amount * 100;
  const hours = comp.hoursPerWeek && comp.hoursPerWeek > 0 ? comp.hoursPerWeek : 40;
  return annualCents(comp) / (hours * 52);
}

function salaryPerPeriodCents(comp: CompensationInput, input: UsPayslipInput): number {
  const f = input.period.frequency;
  const amount = comp.amount * 100;
  if (comp.period === 'week' && f === 'weekly') return amount;
  if (comp.period === 'week' && f === 'biweekly') return amount * 2;
  if (comp.period === 'month' && f === 'monthly') return amount;
  if (comp.period === 'month' && f === 'semimonthly') return amount / 2;
  return annualCents(comp) / input.period.periodsPerYear;
}

/** Share of the period the employee was employed, by weekdays; null when fully employed. */
function employmentFactor(input: UsPayslipInput): { factor: number; worked: number; total: number } | null {
  const { start, end } = input.period;
  const from = input.employee.startDate && input.employee.startDate > start ? input.employee.startDate : start;
  const to = input.employee.endDate && input.employee.endDate < end ? input.employee.endDate : end;
  if (from === start && to === end) return null;
  const total = weekdaysBetween(start, end);
  const worked = from > to ? 0 : weekdaysBetween(from, to);
  return { factor: total > 0 ? worked / total : 0, worked, total };
}

/** §402(g) limit for the employee: base plus the catch-up for their age on 31 December. */
function electiveDeferralLimit(rules: FederalRules, input: UsPayslipInput): Cents {
  const base = rules.retirement.electiveDeferralCents;
  const dob = input.employee.dateOfBirth;
  if (!dob) return base;
  const age = ageOn(dob, `${input.period.taxYear}-12-31`);
  if (age >= 60 && age <= 63) return base + rules.retirement.catchUp60To63Cents;
  if (age >= 50) return base + rules.retirement.catchUp50Cents;
  return base;
}

/**
 * Tax on `thisCents` of a base at `ratePercent`, trued up to the year's
 * running total when that differs by at most a cent (see the header).
 */
function cumulativeTax(thisCents: Cents, ytdBaseCents: Cents, ytdTaxCents: Cents, ratePercent: number): Cents {
  if (thisCents <= 0) return 0;
  const simple = percentOf(thisCents, ratePercent);
  const cumulative = percentOf(ytdBaseCents + thisCents, ratePercent) - ytdTaxCents;
  return Math.abs(cumulative - simple) <= 1 && cumulative >= 0 ? cumulative : simple;
}

function emptyFiling(): UsFilingData {
  return {
    kind: 'us',
    federal: {
      fitWages: 0,
      federalIncomeTax: 0,
      ssWages: 0,
      ssTaxEmployee: 0,
      ssTaxEmployer: 0,
      medicareWages: 0,
      medicareTaxEmployee: 0,
      medicareTaxEmployer: 0,
      additionalMedicareWages: 0,
      additionalMedicareTax: 0,
      futaGrossWages: 0,
      futaWages: 0,
      futaTax: 0,
      ssTips: 0,
      box12: {},
      dependentCare: 0,
    },
    states: {},
    qualifiedOvertimePremium: 0,
    hoursWorked: 0,
  };
}

function blockedResult(input: UsPayslipInput, issues: PayrollIssue[], ruleSet: string): PayslipResult {
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
    filingData: emptyFiling(),
    issues,
    ruleSet,
  };
}

const OVERTIME_LABELS: Record<OvertimeLine['kind'], string> = {
  overtime_premium: 'us.overtime_premium',
  double_time_premium: 'us.double_time_premium',
  overtime: 'us.overtime',
  double_time: 'us.double_time',
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function calculateUsPayslipWith(input: UsPayslipInput, deps: UsEngineDeps): PayslipResult {
  const issues: PayrollIssue[] = [];
  const { period } = input;
  const rules = federalRules(period.taxYear);
  if (!rules) {
    return blockedResult(input, [{ severity: 'error', code: 'unsupported_tax_year', params: { year: period.taxYear } }], 'us-none');
  }
  if (period.frequency === 'four_weekly') {
    return blockedResult(input, [{ severity: 'error', code: 'unsupported_frequency', params: { frequency: period.frequency } }], rules.ruleSet);
  }
  if (rules.provisional) {
    issues.push({ severity: 'warning', code: 'provisional_rules', params: { items: rules.provisionalItems.join(', ') } });
  }

  const lines: PayslipLine[] = [];
  const ytd: Record<string, Cents> = { ...input.ytd };
  const ytdOf = (key: string): Cents => input.ytd[key] ?? 0;
  const addYtd = (key: string, cents: Cents): void => {
    if (cents !== 0) ytd[key] = (ytd[key] ?? 0) + cents;
  };

  const comp = input.compensation;
  const salaried = comp?.payType === 'salary';
  const nonexempt = input.us.flsaStatus === 'nonexempt';
  const workState = input.us.workState ? input.us.workState.toUpperCase() : null;
  const california = workState === 'CA';
  const baseRate = hourlyRateCents(comp);
  const items = itemsOf(input);

  // ---- Earnings -------------------------------------------------------------
  let salaryCents = 0;
  let hourlyCents = 0;
  let overtimeCents = 0;
  let manualOvertimeCents = 0;
  let paidLeaveCents = 0;
  let unpaidLeaveCents = 0;
  let allowanceCents = 0;
  let bonusCents = 0;
  let commissionCents = 0;
  let tipsCents = 0;
  let reimbursementCents = 0;
  let advanceCents = 0;
  let deductionNetCents = 0;
  let hoursWorked = 0;

  if (!comp && items.some((i) => i.code === 'hours.regular' && i.rate === null && i.amountCents === null)) {
    issues.push({ severity: 'error', code: 'missing_compensation' });
  }

  if (salaried && comp) {
    const partial = employmentFactor(input);
    const full = salaryPerPeriodCents(comp, input);
    salaryCents = roundHalfAwayFromZero(partial ? full * partial.factor : full);
    if (partial) {
      issues.push({ severity: 'warning', code: 'partial_period', params: { workedDays: partial.worked, periodDays: partial.total } });
    }
    if (salaryCents > 0) {
      lines.push({ code: 'us.salary', section: 'earning', labelKey: 'us.salary', amountCents: salaryCents, bases: FICA_BASES, jurisdiction: 'federal' });
    }
  }

  // Regular hours: paid for hourly employees (grouped by rate); hours worked for everyone.
  const hourlyByRate = new Map<number, { hours: number; cents: Cents; label: string | null }>();
  const overtimeEntries: HoursEntry[] = [];
  const singleWorkweek = period.frequency === 'weekly' && workweekStart(period.start, input.employer.workweekStartDay) === period.start;
  const datedOrNull = (date: string | null): string | null => date ?? (singleWorkweek ? period.start : null);
  const salariedRegularRate = salaried && comp ? annualCents(comp) / 52 / (california ? 40 : comp.hoursPerWeek && comp.hoursPerWeek > 0 ? comp.hoursPerWeek : 40) : null;

  for (const item of items) {
    if (!US_CODES.has(item.code)) {
      issues.push({ severity: 'error', code: 'unsupported_component', params: { code: item.code } });
      continue;
    }
    const qty = item.quantity ?? 0;
    switch (item.code) {
      case 'hours.regular': {
        hoursWorked += qty;
        const rateCents = item.rate !== null ? item.rate * 100 : salaried ? salariedRegularRate : baseRate;
        const date = datedOrNull(item.workDate);
        if (nonexempt && date && qty > 0 && rateCents !== null) {
          overtimeEntries.push({ date, hours: qty, rateCents, multiplier: null });
        }
        if (salaried) break;
        if (rateCents === null && item.amountCents === null) break;
        const cents = item.amountCents ?? roundHalfAwayFromZero(qty * (rateCents as number));
        const key = rateCents ?? -1;
        const group = hourlyByRate.get(key) ?? { hours: 0, cents: 0, label: item.label };
        group.hours += qty;
        group.cents += cents;
        hourlyByRate.set(key, group);
        hourlyCents += cents;
        break;
      }
      case 'hours.overtime': {
        // Manual overtime: `rate` is the multiplier in percent (150 = time and a half).
        hoursWorked += qty;
        const multiplier = (item.rate ?? 150) / 100;
        const rateCents = salaried ? salariedRegularRate : baseRate;
        const cents = item.amountCents ?? (rateCents !== null ? roundHalfAwayFromZero(qty * rateCents * multiplier) : 0);
        const date = datedOrNull(item.workDate);
        if (nonexempt && date && qty > 0 && rateCents !== null) {
          overtimeEntries.push({ date, hours: qty, rateCents, multiplier });
        }
        manualOvertimeCents += cents;
        lines.push({
          code: 'hours.overtime',
          section: 'earning',
          labelKey: 'us.overtime_manual',
          label: item.label,
          quantity: qty || null,
          rate: rateCents !== null ? round2((rateCents * multiplier) / 100) : null,
          amountCents: cents,
          bases: FICA_BASES,
          jurisdiction: 'federal',
        });
        break;
      }
      case 'hours.paid_leave': {
        const rateCents = item.rate !== null ? item.rate * 100 : baseRate;
        // A salaried employee's salary continues during paid leave: the hours are information only.
        const cents = salaried ? (item.amountCents ?? 0) : (item.amountCents ?? (rateCents !== null ? roundHalfAwayFromZero(qty * rateCents) : 0));
        paidLeaveCents += cents;
        lines.push({
          code: 'hours.paid_leave',
          section: cents !== 0 ? 'earning' : 'info',
          labelKey: 'us.paid_leave',
          label: item.label,
          quantity: qty || null,
          rate: !salaried && rateCents !== null ? round2(rateCents / 100) : null,
          amountCents: cents,
          bases: cents !== 0 ? FICA_BASES : undefined,
          jurisdiction: 'federal',
        });
        break;
      }
      case 'hours.unpaid_leave': {
        // Salaried: deducted from the salary at the hourly equivalent. Hourly: unworked hours are simply not paid.
        const rateCents = item.rate !== null ? item.rate * 100 : baseRate;
        const cents = salaried ? Math.min(salaryCents - unpaidLeaveCents, item.amountCents ?? (rateCents !== null ? roundHalfAwayFromZero(qty * rateCents) : 0)) : 0;
        unpaidLeaveCents += Math.max(0, cents);
        lines.push({
          code: 'hours.unpaid_leave',
          section: cents > 0 ? 'earning' : 'info',
          labelKey: 'us.unpaid_leave',
          label: item.label,
          quantity: qty || null,
          rate: salaried && rateCents !== null ? round2(rateCents / 100) : null,
          amountCents: cents > 0 ? -cents : 0,
          bases: cents > 0 ? FICA_BASES : undefined,
          jurisdiction: 'federal',
        });
        break;
      }
      case 'bonus':
      case 'commission':
      case 'allowance.taxable': {
        const cents = item.amountCents ?? 0;
        if (cents === 0) break;
        if (item.code === 'bonus') bonusCents += cents;
        else if (item.code === 'commission') commissionCents += cents;
        else allowanceCents += cents;
        const labelKey = item.code === 'bonus' ? 'us.bonus' : item.code === 'commission' ? 'us.commission' : 'us.allowance_taxable';
        lines.push({ code: item.code, section: 'earning', labelKey, label: item.label, amountCents: cents, bases: FICA_BASES, jurisdiction: 'federal' });
        break;
      }
      case 'us.tips_cash': {
        const cents = item.amountCents ?? 0;
        if (cents === 0) break;
        tipsCents += cents;
        lines.push({ code: 'us.tips_cash', section: 'earning', labelKey: 'us.tips_cash', label: item.label, amountCents: cents, bases: TIP_BASES, jurisdiction: 'federal' });
        break;
      }
      case 'reimbursement':
      case 'advance': {
        const cents = item.amountCents ?? 0;
        if (cents === 0) break;
        if (item.code === 'reimbursement') reimbursementCents += cents;
        else advanceCents += cents;
        lines.push({ code: item.code, section: 'reimbursement', labelKey: `us.${item.code}`, label: item.label, amountCents: cents });
        break;
      }
      case 'deduction.net': {
        const cents = Math.abs(item.amountCents ?? 0);
        if (cents === 0) break;
        deductionNetCents += cents;
        lines.push({ code: 'deduction.net', section: 'deduction', labelKey: 'us.deduction_net', label: item.label, amountCents: -cents });
        break;
      }
      default:
        // Benefits and employer items are handled below.
        break;
    }
  }

  for (const [rateKey, group] of [...hourlyByRate.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push({
      code: 'hours.regular',
      section: 'earning',
      labelKey: 'us.regular_hours',
      label: group.label,
      quantity: round2(group.hours),
      rate: rateKey >= 0 ? round2(rateKey / 100) : null,
      amountCents: group.cents,
      bases: FICA_BASES,
      jurisdiction: 'federal',
    });
  }
  if (comp?.payType === 'hourly' && hourlyCents === 0 && manualOvertimeCents === 0 && paidLeaveCents === 0) {
    issues.push({ severity: 'warning', code: 'no_hours' });
  }

  // FLSA / California overtime for non-exempt employees.
  let qualifiedOvertimeCents = 0;
  if (nonexempt) {
    const ot = computeOvertime({
      entries: overtimeEntries,
      periodStart: period.start,
      periodEnd: period.end,
      workweekStartDay: input.employer.workweekStartDay,
      california,
      salariedRegularRateCents: salaried ? salariedRegularRate : null,
      ytd: input.ytd,
    });
    // One line per kind and rate: workweeks paid at the same regular rate are shown together.
    const merged = new Map<string, PayslipLine>();
    for (const l of ot.lines) {
      overtimeCents += l.amountCents;
      const rateShown = l.rate !== null ? round2(l.rate) : null;
      const key = `${l.kind}|${rateShown ?? ''}`;
      const prev = merged.get(key);
      if (prev) {
        prev.amountCents += l.amountCents;
        prev.quantity = prev.quantity !== null && prev.quantity !== undefined && l.hours !== null ? round2(prev.quantity + l.hours) : null;
        continue;
      }
      merged.set(key, {
        code: 'hours.overtime',
        section: 'earning',
        labelKey: OVERTIME_LABELS[l.kind],
        quantity: l.hours,
        rate: rateShown,
        amountCents: l.amountCents,
        bases: FICA_BASES,
        jurisdiction: california && (l.kind === 'double_time' || l.kind === 'double_time_premium') ? 'CA' : 'federal',
      });
    }
    lines.push(...merged.values());
    qualifiedOvertimeCents = ot.qualifiedOvertimeCents;
    for (const key of ot.settledCarryKeys) delete ytd[key];
    for (const [key, value] of Object.entries(ot.carryOut)) ytd[key] = value;
  }

  const supplementalCents = bonusCents + commissionCents;
  const grossCents =
    salaryCents - unpaidLeaveCents + hourlyCents + overtimeCents + manualOvertimeCents + paidLeaveCents + allowanceCents + supplementalCents + tipsCents;
  const regularGrossCents = grossCents - supplementalCents;
  const wagesExTipsCents = grossCents - tipsCents;

  // ---- Pre-tax and employer benefits --------------------------------------
  const sumAmount = (code: string): Cents => items.filter((i) => i.code === code).reduce((s, i) => s + Math.max(0, i.amountCents ?? 0), 0);
  const percentParam = (code: string, key: string): number | null => {
    for (const i of items) if (i.code === code && i.amountCents === null) return num(i.params[key]);
    return null;
  };
  const requested = (code: string): Cents => {
    const fixed = sumAmount(code);
    const pct = percentParam(code, 'percent');
    return fixed + (pct !== null ? percentOf(wagesExTipsCents, pct) : 0);
  };

  // §402(g): pre-tax and Roth deferrals share one annual limit; pre-tax is applied first.
  const deferralRoom = Math.max(0, electiveDeferralLimit(rules, input) - ytdOf(US_YTD.k401) - ytdOf(US_YTD.roth401k));
  const k401Cents = Math.min(requested('us.401k'), deferralRoom, Math.max(0, wagesExTipsCents));
  const roth401kCents = Math.min(requested('us.roth_401k'), deferralRoom - k401Cents, Math.max(0, wagesExTipsCents - k401Cents));
  const section125Cents = sumAmount('us.section125_health');
  const hsaCents = sumAmount('us.hsa');
  const dependentCareCents = sumAmount('us.dependent_care');
  const ytdDependentCare = ytdOf(US_YTD.dependentCare);
  const dependentCareExcludedCents =
    Math.min(ytdDependentCare + dependentCareCents, rules.dependentCareExclusionCents) - Math.min(ytdDependentCare, rules.dependentCareExclusionCents);

  const deferralTotal = k401Cents + roth401kCents;
  let employerMatchCents = sumAmount('us.401k_employer_match');
  const matchPercent = percentParam('us.401k_employer_match', 'match_percent');
  if (matchPercent !== null) {
    const limitPercent = percentParam('us.401k_employer_match', 'match_limit_percent');
    const matchedDeferral = limitPercent !== null ? Math.min(deferralTotal, percentOf(wagesExTipsCents, limitPercent)) : deferralTotal;
    employerMatchCents += percentOf(matchedDeferral, matchPercent);
  }
  const employerHealthCents = sumAmount('us.employer_health');

  const pushDeduction = (code: string, labelKey: string, cents: Cents, bases: string[]): void => {
    if (cents > 0) lines.push({ code, section: 'deduction', labelKey, amountCents: -cents, bases, jurisdiction: 'federal' });
  };
  pushDeduction('us.401k', 'us.401k', k401Cents, ['us.fit_wages']);
  pushDeduction('us.roth_401k', 'us.roth_401k', roth401kCents, []);
  pushDeduction('us.section125_health', 'us.section125_health', section125Cents, FICA_BASES);
  pushDeduction('us.hsa', 'us.hsa', hsaCents, FICA_BASES);
  pushDeduction('us.dependent_care', 'us.dependent_care', dependentCareCents, dependentCareExcludedCents > 0 ? FICA_BASES : []);

  // ---- Wage bases -----------------------------------------------------------
  const pretaxFit = k401Cents + section125Cents + hsaCents + dependentCareExcludedCents;
  const pretaxFica = section125Cents + hsaCents + dependentCareExcludedCents;
  const fitWagesCents = Math.max(0, grossCents - pretaxFit);
  const regularFitCents = Math.max(0, regularGrossCents - pretaxFit);
  const supplementalFitCents = Math.max(0, supplementalCents - Math.max(0, pretaxFit - regularGrossCents));
  const ssWagesSubject = Math.max(0, wagesExTipsCents - pretaxFica);
  const tipsSubject = Math.max(0, tipsCents - Math.max(0, pretaxFica - wagesExTipsCents));
  const ficaSubject = ssWagesSubject + tipsSubject;

  // ---- Federal income tax ---------------------------------------------------
  const w4 = effectiveW4(input.us.w4);
  if (!input.us.w4) issues.push({ severity: 'warning', code: 'w4_missing_default_single' });
  let fitRegularCents = 0;
  let fitSupplementalCents = 0;
  if (!input.us.statutoryEmployee) {
    const nra = nraAdditionCents(rules, w4, period.periodsPerYear);
    if (!w4.exempt && regularFitCents > 0) {
      fitRegularCents = worksheet1A(rules, w4, regularFitCents + nra, period.periodsPerYear).withholdingCents;
    }
    const supp = supplementalWithholding({
      rules,
      w4,
      supplementalCents: supplementalFitCents,
      ytdSupplementalCents: ytdOf(US_YTD.supplementalWages),
      regularWagesCents: regularFitCents,
      nraAdditionCents: nra,
      periodsPerYear: period.periodsPerYear,
      regularWithheldThisYearCents: ytdOf(US_YTD.fitRegular) + fitRegularCents,
    });
    fitSupplementalCents = supp.flatCents + supp.mandatoryCents + supp.aggregateCents;
  }
  const fitCents = fitRegularCents + fitSupplementalCents;
  if (fitCents > 0) {
    lines.push({ code: 'us.fit', section: 'tax', labelKey: 'us.federal_income_tax', amountCents: -fitCents, jurisdiction: 'federal' });
  }

  // ---- FICA -----------------------------------------------------------------
  let ssWagesCents = 0;
  let ssTipsCents = 0;
  let ssEmployeeCents = 0;
  let ssEmployerCents = 0;
  let medicareWagesCents = 0;
  let medicareEmployeeCents = 0;
  let medicareEmployerCents = 0;
  let additionalMedicareWagesCents = 0;
  let additionalMedicareCents = 0;
  if (!input.us.exemptFica) {
    const base = rules.socialSecurity.wageBaseCents;
    const ytdSsBase = ytdOf(US_YTD.ssWages) + ytdOf(US_YTD.ssTips);
    const room = Math.max(0, base - ytdSsBase);
    ssWagesCents = Math.min(ssWagesSubject, room);
    ssTipsCents = Math.min(tipsSubject, room - ssWagesCents);
    const ssTaxed = ssWagesCents + ssTipsCents;
    if (ytdSsBase < base && ytdSsBase + ssTaxed >= base && ssTaxed > 0) {
      issues.push({ severity: 'warning', code: 'ss_wage_base_reached', params: { wageBaseCents: base } });
    }
    ssEmployeeCents = cumulativeTax(ssTaxed, ytdSsBase, ytdOf(US_YTD.ssEmployee), rules.socialSecurity.ratePercent);
    ssEmployerCents = cumulativeTax(ssTaxed, ytdSsBase, ytdOf(US_YTD.ssEmployer), rules.socialSecurity.ratePercent);

    medicareWagesCents = ficaSubject;
    const ytdMedicare = ytdOf(US_YTD.medicareWages);
    medicareEmployeeCents = cumulativeTax(medicareWagesCents, ytdMedicare, ytdOf(US_YTD.medicareEmployee), rules.medicare.ratePercent);
    medicareEmployerCents = cumulativeTax(medicareWagesCents, ytdMedicare, ytdOf(US_YTD.medicareEmployer), rules.medicare.ratePercent);

    const threshold = rules.medicare.additionalThresholdCents;
    additionalMedicareWagesCents = Math.max(0, Math.min(medicareWagesCents, ytdMedicare + medicareWagesCents - threshold));
    if (additionalMedicareWagesCents > 0) {
      additionalMedicareCents = cumulativeTax(
        additionalMedicareWagesCents,
        ytdOf(US_YTD.additionalMedicareWages),
        ytdOf(US_YTD.additionalMedicare),
        rules.medicare.additionalRatePercent,
      );
      if (ytdMedicare <= threshold) {
        issues.push({ severity: 'warning', code: 'additional_medicare_started', params: { thresholdCents: threshold } });
      }
    }
  }
  const pushTax = (code: string, labelKey: string, cents: Cents, section: 'tax' | 'employer', jurisdiction: string): void => {
    if (cents !== 0) lines.push({ code, section, labelKey, amountCents: section === 'tax' ? -cents : cents, jurisdiction });
  };
  pushTax('us.ss', 'us.social_security', ssEmployeeCents, 'tax', 'federal');
  pushTax('us.medicare', 'us.medicare', medicareEmployeeCents, 'tax', 'federal');
  pushTax('us.addl_medicare', 'us.additional_medicare', additionalMedicareCents, 'tax', 'federal');

  // ---- FUTA -----------------------------------------------------------------
  const futaGrossCents = Math.max(0, grossCents);
  const futaExemptCents = input.us.exemptFuta ? futaGrossCents : Math.min(futaGrossCents, pretaxFica);
  const futaSubject = futaGrossCents - futaExemptCents;
  const futaWagesCents = Math.min(futaSubject, Math.max(0, rules.futa.wageBaseCents - ytdOf(US_YTD.futaWages)));
  const creditReduction = futaCreditReductionPercent(period.taxYear, workState);
  const futaNetCents = percentOf(futaWagesCents, rules.futa.grossRatePercent - rules.futa.maxCreditPercent);
  const futaCreditReductionCents = percentOf(futaWagesCents, creditReduction);
  const futaCents = futaNetCents + futaCreditReductionCents;
  if (futaWagesCents > 0 && workState && creditReduction === 0 && rules.futa.creditReductionPending.includes(workState)) {
    issues.push({ severity: 'warning', code: 'provisional_rules', params: { item: 'futa_credit_reduction', state: workState } });
  }

  pushTax('us.ss_employer', 'us.social_security_employer', ssEmployerCents, 'employer', 'federal');
  pushTax('us.medicare_employer', 'us.medicare_employer', medicareEmployerCents, 'employer', 'federal');
  pushTax('us.futa', 'us.futa', futaCents, 'employer', 'federal');

  // ---- State ----------------------------------------------------------------
  const filing = emptyFiling();
  let stateEmployeeTaxCents = 0;
  let stateEmployerTaxCents = 0;
  let ruleSet = rules.ruleSet;
  if (!workState) {
    issues.push({ severity: 'error', code: 'missing_work_state' });
  } else {
    const mod = deps.stateModule(workState);
    if (!mod) {
      issues.push({ severity: 'error', code: 'unsupported_state', params: { state: workState } });
    } else {
      const stateInput: StateCalcInput = {
        state: workState,
        taxYear: period.taxYear,
        payDate: period.payDate,
        periodStart: period.start,
        periodEnd: period.end,
        periodsPerYear: period.periodsPerYear,
        regularWagesCents: regularGrossCents,
        supplementalWagesCents: supplementalCents,
        pretax: {
          retirement401kCents: k401Cents,
          section125Cents,
          hsaCents,
          dependentCareCents: dependentCareExcludedCents,
        },
        certificate: input.us.stateCertificates[workState] ?? null,
        federalW4: input.us.w4,
        suiRatePercent: input.employer.suiRatePercent[workState] ?? null,
        extraRates: input.employer.extraRates[workState] ?? {},
        employeeCountEstimate: input.employer.employeeCountEstimate,
        ytd: input.ytd,
        residenceState: input.us.residenceState,
        exemptFromSui: input.us.exemptSui ?? input.us.exemptFuta,
      };
      const res = mod.calculate(stateInput);
      issues.push(...res.issues);
      ruleSet = `${rules.ruleSet}/${res.ruleSet}`;
      pushTax('us.state_income_tax', 'us.state_income_tax', res.incomeTaxCents, 'tax', workState);
      pushTax('us.sui_employee', 'us.sui_employee', res.sui.employeeCents, 'tax', workState);
      pushTax('us.sui_employer', 'us.sui_employer', res.sui.employerCents, 'employer', workState);
      const programs: Record<string, { wages: Cents; employee: Cents; employer: Cents }> = {};
      for (const p of res.programs) {
        if (p.employeeCents !== 0) {
          lines.push({ code: `us.state_program.${p.code}`, section: 'tax', labelKey: p.labelKey, amountCents: -p.employeeCents, jurisdiction: workState });
        }
        if (p.employerCents !== 0) {
          lines.push({ code: `us.state_program.${p.code}`, section: 'employer', labelKey: p.labelKey, amountCents: p.employerCents, jurisdiction: workState });
        }
        const prev = programs[p.code] ?? { wages: 0, employee: 0, employer: 0 };
        programs[p.code] = { wages: prev.wages + p.wagesCents, employee: prev.employee + p.employeeCents, employer: prev.employer + p.employerCents };
        stateEmployeeTaxCents += p.employeeCents;
        stateEmployerTaxCents += p.employerCents;
      }
      stateEmployeeTaxCents += res.incomeTaxCents + res.sui.employeeCents;
      stateEmployerTaxCents += res.sui.employerCents;
      filing.states[workState] = {
        stateWages: res.stateWagesCents,
        stateIncomeTax: res.incomeTaxCents,
        suiWages: res.sui.taxableWagesCents,
        suiGrossWages: res.sui.grossWagesCents,
        suiEmployerTax: res.sui.employerCents,
        suiEmployeeTax: res.sui.employeeCents,
        programs,
      };
      for (const [key, value] of Object.entries(res.ytdUpdates)) ytd[key] = value;
    }
  }

  // ---- Employer contributions, tips offset, info ----------------------------
  if (employerMatchCents > 0) {
    lines.push({ code: 'us.401k_employer_match', section: 'employer', labelKey: 'us.401k_employer_match', amountCents: employerMatchCents });
  }
  if (employerHealthCents > 0) {
    lines.push({ code: 'us.employer_health', section: 'employer', labelKey: 'us.employer_health', amountCents: employerHealthCents });
  }
  if (tipsCents > 0) {
    lines.push({ code: 'us.tips_cash', section: 'deduction', labelKey: 'us.tips_received', amountCents: -tipsCents });
  }
  if (qualifiedOvertimeCents > 0) {
    lines.push({ code: 'us.qualified_overtime', section: 'info', labelKey: 'us.qualified_overtime', amountCents: qualifiedOvertimeCents, jurisdiction: 'federal' });
  }

  // ---- Totals ---------------------------------------------------------------
  const employeeTaxesCents = fitCents + ssEmployeeCents + medicareEmployeeCents + additionalMedicareCents + stateEmployeeTaxCents;
  const employeeDeductionsCents =
    k401Cents + roth401kCents + section125Cents + hsaCents + dependentCareCents + deductionNetCents + tipsCents;
  const reimbursementsCents = reimbursementCents + advanceCents;
  const netCents = grossCents - employeeTaxesCents - employeeDeductionsCents + reimbursementsCents;
  const employerTaxesCents = ssEmployerCents + medicareEmployerCents + futaCents + stateEmployerTaxCents;
  const employerCostCents = grossCents - tipsCents + employerTaxesCents + employerMatchCents + employerHealthCents + reimbursementsCents;

  if (netCents < 0) issues.push({ severity: 'error', code: 'negative_net_pay', params: { netCents } });
  else if (netCents === 0 && grossCents > 0) issues.push({ severity: 'warning', code: 'net_pay_zero' });

  // ---- Accumulators -----------------------------------------------------------
  addYtd(US_YTD.gross, grossCents);
  addYtd(US_YTD.fitWages, fitWagesCents);
  addYtd(US_YTD.fit, fitCents);
  addYtd(US_YTD.fitRegular, fitRegularCents);
  addYtd(US_YTD.supplementalWages, supplementalFitCents);
  addYtd(US_YTD.ssWages, ssWagesCents);
  addYtd(US_YTD.ssTips, ssTipsCents);
  addYtd(US_YTD.ssEmployee, ssEmployeeCents);
  addYtd(US_YTD.ssEmployer, ssEmployerCents);
  addYtd(US_YTD.medicareWages, medicareWagesCents);
  addYtd(US_YTD.medicareEmployee, medicareEmployeeCents);
  addYtd(US_YTD.medicareEmployer, medicareEmployerCents);
  addYtd(US_YTD.additionalMedicareWages, additionalMedicareWagesCents);
  addYtd(US_YTD.additionalMedicare, additionalMedicareCents);
  addYtd(US_YTD.futaWages, futaWagesCents);
  addYtd(US_YTD.futa, futaCents);
  addYtd(US_YTD.futaGrossWages, futaGrossCents);
  addYtd(US_YTD.futaExemptWages, futaExemptCents);
  addYtd(US_YTD.k401, k401Cents);
  addYtd(US_YTD.roth401k, roth401kCents);
  addYtd(US_YTD.section125, section125Cents);
  addYtd(US_YTD.hsa, hsaCents);
  addYtd(US_YTD.dependentCare, dependentCareCents);
  addYtd(US_YTD.employer401k, employerMatchCents);
  addYtd(US_YTD.employerHealth, employerHealthCents);
  addYtd(US_YTD.tips, tipsCents);
  addYtd(US_YTD.qualifiedOvertime, qualifiedOvertimeCents);
  addYtd(US_YTD.net, netCents);

  // ---- Filing data ------------------------------------------------------------
  const box12: Record<string, Cents> = {};
  const setBox = (code: string, cents: Cents): void => {
    if (cents > 0) box12[code] = cents;
  };
  setBox('D', k401Cents);
  setBox('AA', roth401kCents);
  setBox('W', hsaCents);
  // Code DD is the cost of coverage, employer and employee parts together (W-2 instructions, code DD).
  setBox('DD', employerHealthCents + section125Cents);
  setBox('TT', qualifiedOvertimeCents);
  setBox('TP', tipsCents);
  filing.federal = {
    fitWages: fitWagesCents,
    federalIncomeTax: fitCents,
    ssWages: ssWagesCents,
    ssTaxEmployee: ssEmployeeCents,
    ssTaxEmployer: ssEmployerCents,
    medicareWages: medicareWagesCents,
    medicareTaxEmployee: medicareEmployeeCents,
    medicareTaxEmployer: medicareEmployerCents,
    additionalMedicareWages: additionalMedicareWagesCents,
    additionalMedicareTax: additionalMedicareCents,
    futaGrossWages: futaGrossCents,
    futaWages: futaWagesCents,
    futaTax: futaCents,
    ssTips: ssTipsCents,
    box12,
    dependentCare: dependentCareCents,
    futaExemptWages: futaExemptCents,
    futaState: workState,
    futaCreditReduction: futaCreditReductionCents,
    supplementalWages: supplementalCents,
    statutoryEmployee: input.us.statutoryEmployee,
    retirementPlan: input.us.retirementPlan,
  };
  filing.qualifiedOvertimePremium = qualifiedOvertimeCents;
  filing.hoursWorked = round2(hoursWorked);

  return {
    lines,
    grossCents,
    taxableWageCents: fitWagesCents,
    employeeTaxesCents,
    employeeDeductionsCents,
    reimbursementsCents,
    netCents,
    employerTaxesCents,
    employerCostCents,
    ytd,
    filingData: filing,
    issues,
    ruleSet,
  };
}

/** The US engine with the real state modules. */
export function calculateUsPayslip(input: UsPayslipInput): PayslipResult {
  return calculateUsPayslipWith(input, { stateModule: (code) => defaultStateModule(code) });
}

/** Last day of the FLSA workweek containing `date` (exported for hr-api's run preparation). */
export function workweekEnd(date: string, workweekStartDay: number): string {
  return addDays(workweekStart(date, workweekStartDay), 6);
}
