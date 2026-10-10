/**
 * The Dutch payslip: gross to net for one employee and one monthly period.
 *
 * Scope (v1, docs/plans/weldhr-payroll.md "Build"): employers without a CAO,
 * insured (non-sector-fund) pension, DGA payroll, monthly pay, white table and
 * special-reward table (green special-reward table only for the
 * transitievergoeding), holiday allowance, company car, travel and home-working
 * allowances, 30% ruling. The rules per year are in `rules-<year>.ts`; the
 * wage-tax arithmetic is in `wage-tax.ts` and reproduces the official tables.
 *
 * How the wage bases are built: every line names the bases it counts in
 * (`bases`), and each base is the sum of the amounts of its lines. Since 2013
 * the wage for wage tax, employee insurances and Zvw is the same ("uniform
 * loonbegrip", Handboek Loonheffingen 2026 [HB] §4.1, loonstaat columns
 * 3 + 4 + 5 − 7, HB §11.2.7–11.2.9) except for loon uit vroegere
 * dienstbetrekking (the transitievergoeding: no SV wage) and tax-free
 * (eindheffing) parts, which are in no base.
 *
 * Choices where the rules allow more than one method (documented in the
 * report and the tests):
 * - Salary conversion to a month uses the Handboek's factors (HB §29.10:
 *   a year is 12 months, 52 weeks; hours × contract hours per week × 52/12).
 * - A partial first or last month is prorated by working days (Mon–Fri) in
 *   employment over working days in the month, as in HB §5.1.1 ("rekent voor
 *   maart het maandloon om naar het aantal gewerkte dagen"). For a full-timer
 *   that month is a day-table period: the tax is n × the day-table tax on the
 *   wage per day, and the premium cap is n × the day maximum; for a
 *   part-timer the month stays the period (HB §5.1.1, VCR-notitie §8.1).
 * - Premiums and the Zvw are computed cumulatively (voortschrijdend
 *   cumulatief rekenen, mandatory: HB ch. 6) and rounded down to cents (HB §6.1
 *   step 6 allows rounding in the payer's favour).
 * - Commission is taxed with the special-reward table (allowed for
 *   "achteraf betaalde provisies", HB §9.3.6), like bonus, 13th month,
 *   holiday allowance paid once a year and paid-out leave.
 * - AOW-age columns and the end of employee-insurance premiums apply from
 *   the first day of the month in which the employee reaches the AOW age,
 *   judged at the pay date (HB §9.3.1, §18.21).
 */

import type { Cents } from '../money';
import { roundHalfAwayFromZero, toCents } from '../money';
import { ageOn, daysBetween, weekdaysBetween } from '../periods';
import type {
  ComponentInput,
  NlFilingData,
  NlPayslipInput,
  PayrollIssue,
  PayslipLine,
  PayslipResult,
  RunInput,
} from '../types';
import { nlRulesForYear, type NlRuleSet } from './rules';
import {
  PERIOD_FACTOR,
  anonymousTax,
  periodWageTax,
  specialRewardPercent,
  specialRewardTax,
  type NlAgeColumn,
} from './wage-tax';
import { NL_YTD_KEYS, ytdValue, type NlYtdKey } from './ytd';

const B_LB = 'nl.loon_lb';
const B_SV = 'nl.loon_sv';
const B_ZVW = 'nl.loon_zvw';
const B_BB = 'nl.loon_bb';

/** The codes the Dutch engine handles (components.ts). */
const NL_CODES = new Set([
  'hours.regular',
  'hours.overtime',
  'hours.unpaid_leave',
  'bonus',
  'commission',
  'allowance.taxable',
  'reimbursement',
  'deduction.net',
  'advance',
  'nl.travel_allowance',
  'nl.home_working_allowance',
  'nl.company_car',
  'nl.pension_employee',
  'nl.pension_employer',
  'nl.thirteenth_month',
  'nl.leave_payout',
  'nl.holiday_allowance_payout',
  'nl.sick_pay',
  'nl.transition_payment',
]);

/** A component or run input, normalised. */
interface Item {
  code: string;
  label: string | null;
  quantity: number | null;
  rate: number | null;
  amountCents: Cents | null;
  params: Record<string, number | string | boolean | null>;
}

function fromComponent(c: ComponentInput): Item {
  return { code: c.code, label: c.label ?? null, quantity: null, rate: null, amountCents: c.amountCents, params: c.params ?? {} };
}

function fromInput(i: RunInput): Item {
  return { code: i.code, label: i.label ?? null, quantity: i.quantity, rate: i.rate, amountCents: i.amountCents, params: {} };
}

/** A numeric parameter (numbers may arrive as strings from jsonb). */
function num(params: Item['params'], key: string): number | null {
  const v = params[key];
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const round = roundHalfAwayFromZero;
const sumOf = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** `YYYY-MM-DD` plus whole years and months, clamped to the month's last day. */
function addYearsMonths(iso: string, years: number, months: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const total = (y + years) * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** The date the employee reaches the AOW age of `rules`. */
export function nlAowDate(dateOfBirth: string, rules: NlRuleSet): string {
  return addYearsMonths(dateOfBirth, rules.aowAge.years, rules.aowAge.months);
}

function emptyFiling(input: NlPayslipInput): NlFilingData {
  return {
    kind: 'nl',
    tableCode: '012',
    applyLoonheffingskorting: input.nl.applyLoonheffingskorting,
    anonymous: input.nl.anonymous,
    insured: { ww: input.nl.insuredWw, zw: input.nl.insuredZw, wao: input.nl.insuredWao },
    awfRate: 'high',
    aofRate: input.employer.aofSmallEmployer ? 'low' : 'high',
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
  };
}

function blockedResult(input: NlPayslipInput, issues: PayrollIssue[], ruleSet: string): PayslipResult {
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
    filingData: emptyFiling(input),
    issues,
    ruleSet,
  };
}

export function calculateNlPayslip(input: NlPayslipInput): PayslipResult {
  const { period, employee, employer, nl } = input;
  const issues: PayrollIssue[] = [];
  const rules = nlRulesForYear(period.taxYear);
  if (!rules) {
    return blockedResult(input, [{ severity: 'error', code: 'unsupported_tax_year', params: { year: period.taxYear } }], 'nl-none');
  }
  if (period.frequency !== 'monthly') {
    return blockedResult(input, [{ severity: 'error', code: 'unsupported_frequency', params: { frequency: period.frequency } }], rules.id);
  }
  if (rules.provisional) {
    issues.push({ severity: 'warning', code: 'provisional_rules', params: { ruleSet: rules.id, unverified: rules.unverified.join(', ') } });
  }
  const ytd = input.ytd ?? {};
  if (Object.keys(ytd).length === 0) issues.push({ severity: 'warning', code: 'first_payslip' });

  // ---------------------------------------------------------------- dates
  const empStart = employee.startDate && employee.startDate > period.start ? employee.startDate : period.start;
  const empEnd = employee.endDate && employee.endDate < period.end ? employee.endDate : period.end;
  const employed = empStart <= empEnd;
  const partial = employed && (empStart !== period.start || empEnd !== period.end);
  if (partial) issues.push({ severity: 'warning', code: 'partial_period', params: { from: empStart, to: empEnd } });
  const periodWeekdays = weekdaysBetween(period.start, period.end);
  const employedWeekdays = employed ? weekdaysBetween(empStart, empEnd) : 0;
  const proration = !employed ? 0 : partial ? (periodWeekdays > 0 ? employedWeekdays / periodWeekdays : 0) : 1;
  const calendarFraction = !employed ? 0 : (daysBetween(empStart, empEnd) + 1) / (daysBetween(period.start, period.end) + 1);
  const endsThisPeriod = !!employee.endDate && employee.endDate >= period.start && employee.endDate <= period.end;

  // ----------------------------------------------------------- age, AOW
  const dob = employee.dateOfBirth;
  if (!dob) issues.push({ severity: 'error', code: 'missing_date_of_birth' });
  const aowDate = dob ? nlAowDate(dob, rules) : null;
  const aowMonthStart = aowDate ? `${aowDate.slice(0, 8)}01` : null;
  // HB §9.3.1 / §18.21: the AOW columns, and no employee-insurance premiums, for wage enjoyed
  // on or after the first day of the month in which the AOW age is reached.
  const aowReached = !!aowMonthStart && period.payDate >= aowMonthStart;
  const column: NlAgeColumn = !aowReached ? 'belowAow' : Number(dob!.slice(0, 4)) <= 1945 ? 'aow1945' : 'aow1946';
  const ageAtEnd = dob ? ageOn(dob, period.end) : null;
  const ageAtStart = dob ? ageOn(dob, period.start) : null;

  // ------------------------------------------------------------ insurance
  const isDga = nl.isDga;
  // HB §18.21: from the AOW date WW and WAO end, ZW continues. HB §18.1.1: a DGA is not insured.
  const aowBeforePeriod = !!aowDate && aowDate <= period.start;
  const insured = {
    ww: !isDga && nl.insuredWw && !aowBeforePeriod,
    zw: !isDga && nl.insuredZw,
    wao: !isDga && nl.insuredWao && !aowBeforePeriod,
  };
  // Gegevensspecificaties 2026, Loon SV (condition 1818): 0 when every insurance indicator is N.
  const svApplies = insured.ww || insured.zw || insured.wao;
  const premiumsApply = !isDga && !aowReached;
  const anonymous = nl.anonymous;
  if (anonymous) issues.push({ severity: 'warning', code: 'anonymous_rate' });
  const applyLhk = nl.applyLoonheffingskorting && !anonymous;

  // ----------------------------------------------------------- compensation
  const comp = input.compensation;
  const contractHours = nl.contractHoursPerWeek ?? comp?.hoursPerWeek ?? null;
  const hoursPerWeek = comp?.hoursPerWeek ?? nl.contractHoursPerWeek ?? null;
  const usualDays = nl.usualWorkDaysPerWeek ?? (contractHours !== null && contractHours >= 36 ? 5 : 4);
  const fullTimer = usualDays >= 5;
  const dayTablePeriod = partial && fullTimer && employedWeekdays > 0;

  let monthlySalaryCents: number | null = null; // full month, unprorated (floating cents)
  let hourlyRateCents: number | null = null;
  if (!comp) {
    if (employed) issues.push({ severity: 'error', code: 'missing_compensation' });
  } else {
    const amt = comp.amount * 100;
    const perMonthFromHours = hoursPerWeek ? (hoursPerWeek * 52) / 12 : null;
    if (comp.payType === 'salary') {
      if (comp.period === 'month') monthlySalaryCents = amt;
      else if (comp.period === 'year') monthlySalaryCents = amt / 12;
      else if (comp.period === 'week') monthlySalaryCents = (amt * 52) / 12;
      else if (perMonthFromHours !== null) monthlySalaryCents = amt * perMonthFromHours;
      if (monthlySalaryCents !== null && perMonthFromHours) hourlyRateCents = monthlySalaryCents / perMonthFromHours;
    } else {
      if (comp.period === 'hour') hourlyRateCents = amt;
      else if (hoursPerWeek) {
        hourlyRateCents =
          comp.period === 'week' ? amt / hoursPerWeek : comp.period === 'month' ? (amt * 12) / 52 / hoursPerWeek : amt / 52 / hoursPerWeek;
      }
    }
    if (monthlySalaryCents === null && hourlyRateCents === null) {
      issues.push({ severity: 'error', code: 'missing_compensation', params: { field: 'hoursPerWeek' } });
    }
  }

  // ------------------------------------------------------------- items
  const items: Item[] = [...input.components.map(fromComponent), ...input.inputs.map(fromInput)];
  for (const it of items) {
    if (!NL_CODES.has(it.code)) issues.push({ severity: 'error', code: 'unsupported_component', params: { code: it.code } });
  }
  const itemsOf = (code: string) => items.filter((i) => i.code === code);
  const needHourly = (it: Item): number | null => {
    if (hourlyRateCents === null) {
      issues.push({ severity: 'error', code: 'missing_compensation', params: { field: 'hourlyRate', component: it.code } });
      return null;
    }
    return hourlyRateCents;
  };

  const lines: PayslipLine[] = [];
  const periodBases = svApplies ? [B_LB, B_SV, B_ZVW] : [B_LB, B_ZVW];
  const bbBases = [...periodBases, B_BB];
  const earning = (code: string, labelKey: string, amountCents: Cents, extra: Partial<PayslipLine> = {}, special = false) => {
    if (amountCents === 0 && !extra.quantity) return;
    lines.push({ code, section: 'earning', labelKey, amountCents, bases: special ? bbBases : periodBases, ...extra });
  };

  // Salary / hours.
  let qualifyingWage = 0; // basis for the holiday allowance (Wml art. 15: "loon", excluding one-off rewards)
  let pensionableWage = 0;
  let hoursPaid = 0;
  let overtimeHours = 0;
  let overtimeWage = 0;
  let unpaidHours = 0;
  let incidental: NlFilingData['incidentalIncomeReduction'] = null;

  if (comp && employed) {
    if (comp.payType === 'salary' && monthlySalaryCents !== null) {
      const salary = round(monthlySalaryCents * proration);
      earning('nl.salary', 'nl.salary', salary, { quantity: partial ? Math.round(proration * 10_000) / 10_000 : null });
      qualifyingWage += salary;
      pensionableWage += salary;
      if (contractHours) hoursPaid += ((contractHours * 52) / 12) * proration;
    } else if (comp.payType === 'hourly') {
      for (const it of itemsOf('hours.regular')) {
        const q = it.quantity ?? 0;
        const rate = it.rate !== null ? it.rate * 100 : hourlyRateCents;
        const amount = it.amountCents ?? (rate !== null ? round(q * rate) : 0);
        earning('nl.hours_regular', 'nl.hours_regular', amount, { quantity: q, rate: rate !== null ? rate / 100 : null, label: it.label });
        qualifyingWage += amount;
        pensionableWage += amount;
        hoursPaid += q;
      }
      if (itemsOf('hours.regular').length === 0) issues.push({ severity: 'warning', code: 'no_hours' });
    }
  }

  for (const it of itemsOf('hours.overtime')) {
    const q = it.quantity ?? 0;
    const pct = it.rate ?? 100;
    let amount = it.amountCents;
    if (amount === null) {
      const h = needHourly(it);
      amount = h === null ? 0 : round((q * h * pct) / 100);
    }
    earning('hours.overtime', 'nl.overtime', amount, { quantity: q, rate: pct, label: it.label });
    overtimeHours += q;
    overtimeWage += amount;
    qualifyingWage += amount;
    hoursPaid += q;
  }

  for (const it of itemsOf('hours.unpaid_leave')) {
    const q = it.quantity ?? 0;
    let amount = it.amountCents !== null ? Math.abs(it.amountCents) : null;
    if (amount === null) {
      const h = needHourly(it);
      amount = h === null ? 0 : round(q * h);
    }
    earning('hours.unpaid_leave', 'nl.unpaid_leave', -amount, { quantity: q, label: it.label });
    unpaidHours += q;
    qualifyingWage -= amount;
    pensionableWage -= amount;
    hoursPaid -= q;
    if (amount > 0) incidental = 'O';
  }

  for (const it of itemsOf('nl.sick_pay')) {
    const q = it.quantity ?? 0;
    const pct = it.rate ?? 100;
    // Art. 7:629 BW: at least 70% of the wage during illness (statutory figure; not re-fetched, see report).
    if (pct < 70) issues.push({ severity: 'warning', code: 'sick_pay_below_statutory', params: { percent: pct } });
    if (pct >= 100) continue;
    let reduction = it.amountCents !== null ? Math.abs(it.amountCents) : null;
    if (reduction === null) {
      const h = needHourly(it);
      reduction = h === null ? 0 : round((q * h * (100 - pct)) / 100);
    }
    earning('nl.sick_pay', 'nl.sick_pay_reduction', -reduction, { quantity: q, rate: pct, label: it.label });
    qualifyingWage -= reduction;
    pensionableWage -= reduction;
    if (reduction > 0) incidental = incidental ?? 'Z';
  }

  for (const it of itemsOf('allowance.taxable')) {
    const amount = it.amountCents ?? 0;
    earning('allowance.taxable', 'nl.allowance_taxable', amount, { label: it.label });
    qualifyingWage += amount;
  }

  // Special rewards (HB §9.3.6).
  let bbWhite = 0;
  let specialRewardsPaid = 0;
  for (const [code, labelKey] of [
    ['bonus', 'nl.bonus'],
    ['commission', 'nl.commission'],
    ['nl.thirteenth_month', 'nl.thirteenth_month'],
  ] as const) {
    for (const it of itemsOf(code)) {
      const amount = it.amountCents ?? 0;
      earning(code, labelKey, amount, { label: it.label }, true);
      bbWhite += amount;
      specialRewardsPaid += amount;
      if (code === 'commission') qualifyingWage += amount;
    }
  }
  let leavePayoutHours = 0;
  for (const it of itemsOf('nl.leave_payout')) {
    const q = it.quantity ?? 0;
    let amount = it.amountCents;
    if (amount === null) {
      const rate = it.rate !== null ? it.rate * 100 : needHourly(it);
      amount = rate === null ? 0 : round(q * rate);
    }
    earning('nl.leave_payout', 'nl.leave_payout', amount, { quantity: q || null, label: it.label }, true);
    bbWhite += amount;
    specialRewardsPaid += amount;
    qualifyingWage += amount;
    leavePayoutHours += q;
    hoursPaid += q;
  }

  // Travel allowance: tax-free up to the per-km amount (HB §23.1.1–23.1.2; Annex 2026 table 13).
  let taxFreeAllowances = 0;
  let travelTaxFree = 0;
  for (const it of itemsOf('nl.travel_allowance')) {
    const km = num(it.params, 'km_per_day');
    const days = num(it.params, 'days_per_month') ?? it.quantity;
    const limit = km !== null && days !== null ? round(km * days * rules.wkr.perKmCents) : null;
    const amount = it.amountCents ?? limit ?? 0;
    const free = limit === null ? amount : Math.min(amount, limit);
    if (free !== 0) lines.push({ code: 'nl.travel_allowance', section: 'reimbursement', labelKey: 'nl.travel_allowance', label: it.label, amountCents: free, quantity: km !== null && days !== null ? km * days : null, rate: limit !== null ? rules.wkr.perKmCents / 100 : null });
    if (amount - free !== 0) earning('nl.travel_allowance_taxable', 'nl.travel_allowance_taxable', amount - free);
    // Reisk: only the per-km allowance (gegevensspecificaties 2026, rubriek Bedrag vergoeding reiskosten).
    if (km !== null) travelTaxFree += free;
    taxFreeAllowances += free;
  }

  // Home-working allowance: € per home-working day (HB §22.1.12).
  for (const it of itemsOf('nl.home_working_allowance')) {
    const days = it.quantity ?? num(it.params, 'days_per_month') ?? num(it.params, 'days') ?? 0;
    const limit = round(days * rules.wkr.homeWorkingPerDayCents);
    const amount = it.amountCents ?? (it.rate !== null ? round(days * it.rate * 100) : limit);
    const free = Math.min(amount, limit);
    if (free !== 0) lines.push({ code: 'nl.home_working_allowance', section: 'reimbursement', labelKey: 'nl.home_working_allowance', label: it.label, amountCents: free, quantity: days, rate: rules.wkr.homeWorkingPerDayCents / 100 });
    if (amount - free !== 0) earning('nl.home_working_allowance_taxable', 'nl.home_working_allowance_taxable', amount - free);
    taxFreeAllowances += free;
  }

  // Holiday allowance (Wml art. 15–17): accrue each month, pay in the payout month,
  // monthly when no payout month is set, and the balance when employment ends.
  const hap = Number.isFinite(employer.holidayAllowancePercent) ? employer.holidayAllowancePercent : 8;
  const accrual = employed ? round((qualifyingWage * hap) / 100) : 0;
  const openingKnown = Object.prototype.hasOwnProperty.call(ytd, NL_YTD_KEYS.holidayAllowanceOpening);
  const opening = openingKnown ? ytdValue(ytd, NL_YTD_KEYS.holidayAllowanceOpening) : (nl.holidayAllowanceOpeningBalanceCents ?? 0);
  const balanceBefore = opening + ytdValue(ytd, NL_YTD_KEYS.holidayAllowanceAccrued) - ytdValue(ytd, NL_YTD_KEYS.holidayAllowancePaid);
  let holidayPaid = 0;
  let holidayPaidPeriod = 0; // paid with the period table (monthly payout)
  for (const it of itemsOf('nl.holiday_allowance_payout')) {
    const amount = it.amountCents ?? 0;
    earning('nl.holiday_allowance_payout', 'nl.holiday_allowance', amount, { label: it.label }, true);
    holidayPaid += amount;
    bbWhite += amount;
  }
  const month = Number(period.start.slice(5, 7));
  if (employer.holidayAllowancePayoutMonth === null) {
    holidayPaidPeriod = accrual;
    earning('nl.holiday_allowance', 'nl.holiday_allowance', accrual, { rate: hap });
    holidayPaid += accrual;
  } else {
    const due = month === employer.holidayAllowancePayoutMonth || endsThisPeriod;
    const balance = balanceBefore + accrual - holidayPaid;
    if (due && balance > 0) {
      earning('nl.holiday_allowance', 'nl.holiday_allowance', balance, {}, true);
      holidayPaid += balance;
      bbWhite += balance;
    }
    if (accrual !== 0) lines.push({ code: 'nl.holiday_allowance_accrued', section: 'info', labelKey: 'nl.holiday_allowance_accrued', amountCents: accrual, rate: hap });
  }
  specialRewardsPaid += holidayPaid - holidayPaidPeriod;

  // Transitievergoeding: loon uit vroegere dienstbetrekking — green special-reward table,
  // no SV wage (HB §4.1, §7.7.2), its own income relationship in the return.
  let transition = 0;
  for (const it of itemsOf('nl.transition_payment')) {
    const amount = it.amountCents ?? 0;
    if (amount === 0) continue;
    lines.push({ code: 'nl.transition_payment', section: 'earning', labelKey: 'nl.transition_payment', label: it.label, amountCents: amount, bases: [B_LB, B_ZVW, B_BB] });
    transition += amount;
  }

  // Company car: bijtelling = list price × percentage / 12 (HB §23.3.3, §23.3.7), pro rata for a partial month.
  let carValue = 0;
  let carContribution = 0;
  for (const it of itemsOf('nl.company_car')) {
    const list = toCents(num(it.params, 'list_price') ?? 0);
    const pct = num(it.params, 'percent') ?? 0;
    const zeCap = num(it.params, 'zero_emission_cap');
    const zePct = num(it.params, 'zero_emission_percent');
    let annual: number;
    if (zeCap !== null && zePct !== null) {
      const capped = Math.min(list, toCents(zeCap));
      annual = (capped * zePct) / 100 + (Math.max(0, list - capped) * pct) / 100;
    } else {
      annual = (list * pct) / 100;
    }
    const value = round((annual / 12) * calendarFraction);
    const contribution = toCents(num(it.params, 'employee_contribution') ?? 0);
    if (value !== 0) {
      lines.push({ code: 'nl.company_car', section: 'info', labelKey: 'nl.company_car', label: it.label, amountCents: value, bases: periodBases, rate: pct });
    }
    // The saldo of value and own contribution may not be negative over the calendar year (HB §23.3.7).
    const room = ytdValue(ytd, NL_YTD_KEYS.companyCarValue) + carValue + value - ytdValue(ytd, NL_YTD_KEYS.companyCarContribution) - carContribution;
    const deductible = Math.max(0, Math.min(contribution, room));
    if (deductible > 0) {
      lines.push({ code: 'nl.company_car_contribution', section: 'deduction', labelKey: 'nl.company_car_contribution', amountCents: -deductible, bases: periodBases });
    }
    if (contribution - deductible > 0) {
      lines.push({ code: 'nl.company_car_contribution', section: 'deduction', labelKey: 'nl.company_car_contribution', amountCents: -(contribution - deductible) });
    }
    carValue += value;
    carContribution += deductible;
  }

  // Pension (insured scheme): employee premium is deductible for all wages (HB §11.2.6, column 7);
  // employer premium is an employer cost and no wage.
  const pensionAmount = (it: Item): number => {
    if (it.amountCents !== null) return it.amountCents;
    const pct = num(it.params, 'percent') ?? 0;
    const franchise = toCents(num(it.params, 'franchise_per_year') ?? 0);
    const base = Math.max(0, pensionableWage - (franchise / 12) * proration);
    return round((base * pct) / 100);
  };
  let pensionEmployee = 0;
  for (const it of itemsOf('nl.pension_employee')) {
    const amount = pensionAmount(it);
    if (amount !== 0) lines.push({ code: 'nl.pension_employee', section: 'deduction', labelKey: 'nl.pension_employee', label: it.label, amountCents: -amount, bases: periodBases, rate: num(it.params, 'percent') });
    pensionEmployee += amount;
  }
  let pensionEmployer = 0;
  for (const it of itemsOf('nl.pension_employer')) {
    const amount = pensionAmount(it);
    if (amount !== 0) lines.push({ code: 'nl.pension_employer', section: 'employer', labelKey: 'nl.pension_employer', label: it.label, amountCents: amount, rate: num(it.params, 'percent') });
    pensionEmployer += amount;
  }

  // 30% ruling: the tax-free part of the wage including the allowance (HB §19.4.3), capped at the
  // WNT norm and so that the remaining wage meets the salary norm.
  let expatAllowance = 0;
  const expatPct = nl.expatRulingPercent ?? 0;
  if (expatPct > 0) {
    const cashPeriod = sumOf(lines.filter((l) => l.section === 'earning' && !!l.bases?.includes(B_LB) && !l.bases.includes(B_BB)).map((l) => l.amountCents));
    const cashBb = bbWhite;
    let partPeriod = round((cashPeriod * expatPct) / 100);
    let partBb = round((cashBb * expatPct) / 100);
    const share = employed ? proration : 0;
    const normPeriod = (rules.expat.salaryNormCents / 12) * share;
    if (cashPeriod - partPeriod < normPeriod) {
      partPeriod = Math.max(0, Math.floor(cashPeriod - normPeriod));
      issues.push({ severity: 'warning', code: 'expat_salary_norm', params: { normCents: rules.expat.salaryNormCents } });
    }
    const cap = round(((rules.expat.wntCapCents * expatPct) / 100 / 12) * (employed ? share : 1));
    partPeriod = Math.min(partPeriod, cap);
    partBb = Math.max(0, Math.min(partBb, cap - partPeriod));
    if (partPeriod > 0) lines.push({ code: 'nl.expat_allowance', section: 'info', labelKey: 'nl.expat_allowance', amountCents: -partPeriod, rate: expatPct, bases: periodBases });
    if (partBb > 0) lines.push({ code: 'nl.expat_allowance_special', section: 'info', labelKey: 'nl.expat_allowance', amountCents: -partBb, rate: expatPct, bases: bbBases });
    expatAllowance = partPeriod + partBb;
    taxFreeAllowances += expatAllowance;
  }

  // Net items.
  for (const it of itemsOf('reimbursement')) {
    const amount = it.amountCents ?? 0;
    if (amount !== 0) lines.push({ code: 'reimbursement', section: 'reimbursement', labelKey: 'nl.reimbursement', label: it.label, amountCents: amount });
  }
  for (const it of itemsOf('advance')) {
    const amount = it.amountCents ?? 0;
    if (amount > 0) lines.push({ code: 'advance', section: 'reimbursement', labelKey: 'nl.advance', label: it.label, amountCents: amount });
    else if (amount < 0) lines.push({ code: 'advance', section: 'deduction', labelKey: 'nl.advance', label: it.label, amountCents: amount });
  }
  for (const it of itemsOf('deduction.net')) {
    const amount = Math.abs(it.amountCents ?? 0);
    if (amount !== 0) lines.push({ code: 'deduction.net', section: 'deduction', labelKey: 'nl.deduction_net', label: it.label, amountCents: -amount });
  }

  // ---------------------------------------------------------- wage bases
  const baseSum = (base: string) => sumOf(lines.filter((l) => l.bases?.includes(base)).map((l) => l.amountCents));
  const loonLb = baseSum(B_LB);
  const loonBbAll = baseSum(B_BB);
  const loonSv = svApplies ? baseSum(B_SV) : 0;
  const loonZvw = baseSum(B_ZVW);
  const periodWage = loonLb - loonBbAll;
  const hasPeriodWage = employed || periodWage !== 0;

  // ------------------------------------------------------------ wage tax
  let periodTax = 0;
  let labourCredit = 0;
  let bbTax = 0;
  let bbPercent: number | null = null;
  let transitionTax = 0;
  let transitionPercent: number | null = null;
  let tableCode = '012';

  // Annual wage for the special-reward table (HB §9.3.6): last year's wage, or for a new
  // employee the expected wage for the whole current year including incidental payments.
  const annualWageForBb = (): Cents => {
    if (nl.previousYearAnnualWageCents !== null) return nl.previousYearAnnualWageCents;
    const scale = proration > 0 ? proration : 1;
    // Regular wage (a monthly holiday allowance is part of it), for a full month, times 12.
    const fullMonth = periodWage / scale;
    // A reserved holiday allowance is paid once a year: add a year's accrual.
    const holidayYear = employer.holidayAllowancePayoutMonth !== null ? ((qualifyingWage / scale) * 12 * hap) / 100 : 0;
    // One-off payments of this payslip, except the holiday allowance already counted above.
    const oneOff = loonBbAll - (holidayPaid - holidayPaidPeriod);
    return round(fullMonth * 12 + holidayYear + oneOff);
  };

  if (anonymous) {
    tableCode = '940';
    periodTax = anonymousTax(loonLb, rules);
  } else {
    if (hasPeriodWage && periodWage > 0) {
      if (dayTablePeriod) {
        const perDay = round(periodWage / employedWeekdays);
        const r = periodWageTax(perDay, PERIOD_FACTOR.day, column, applyLhk, rules);
        periodTax = r.taxCents * employedWeekdays;
        labourCredit = r.labourCreditCents * employedWeekdays;
        tableCode = '015';
      } else {
        const r = periodWageTax(periodWage, PERIOD_FACTOR.month, column, applyLhk, rules);
        periodTax = r.taxCents;
        labourCredit = r.labourCreditCents;
      }
    } else if (loonBbAll !== 0) {
      tableCode = '010';
    }
    const annual = loonBbAll !== 0 ? annualWageForBb() : 0;
    const whiteBb = loonBbAll - transition;
    if (whiteBb !== 0) {
      bbPercent = specialRewardPercent(annual, column, applyLhk, rules, 'white');
      bbTax = specialRewardTax(whiteBb, bbPercent);
    }
    if (transition !== 0) {
      transitionPercent = specialRewardPercent(annual, column, applyLhk, rules, 'green');
      transitionTax = specialRewardTax(transition, transitionPercent);
    }
  }
  const wageTax = periodTax + bbTax + transitionTax;
  if (periodTax !== 0) lines.push({ code: 'nl.wage_tax', section: 'tax', labelKey: 'nl.wage_tax', amountCents: -periodTax, rate: anonymous ? rules.wageTax.anonymousRatePercent : null });
  if (bbTax !== 0) lines.push({ code: 'nl.wage_tax_special', section: 'tax', labelKey: 'nl.wage_tax_special', amountCents: -bbTax, rate: bbPercent });
  if (transitionTax !== 0) lines.push({ code: 'nl.wage_tax_transition', section: 'tax', labelKey: 'nl.wage_tax_special', amountCents: -transitionTax, rate: transitionPercent });
  if (labourCredit !== 0) lines.push({ code: 'nl.labour_credit', section: 'info', labelKey: 'nl.labour_credit', amountCents: labourCredit });

  // ------------------------------------------------- premiums (VCR, HB ch. 6)
  const p = rules.premiums;
  const periodMax = !hasPeriodWage || !employed ? 0 : dayTablePeriod ? employedWeekdays * p.maxPremieloon.day : p.maxPremieloon.month;
  const newYtd: Record<string, number> = { ...ytd };
  const add = (key: NlYtdKey, value: number) => {
    newYtd[key] = ytdValue(newYtd, key) + value;
  };

  /** One fund: returns the aanwas (premieloon of this period). */
  const vcr = (applies: boolean, keys: { wage: NlYtdKey; max: NlYtdKey; base: NlYtdKey }, wage: Cents, floorAtZero: boolean): Cents => {
    if (!applies) return 0;
    const cumWage = ytdValue(ytd, keys.wage) + wage;
    const cumMax = ytdValue(ytd, keys.max) + periodMax;
    let base = anonymous ? cumWage : Math.min(cumWage, cumMax);
    if (floorAtZero) base = Math.max(0, base);
    const aanwas = base - ytdValue(ytd, keys.base);
    newYtd[keys.wage] = cumWage;
    newYtd[keys.max] = cumMax;
    newYtd[keys.base] = base;
    return aanwas;
  };
  const premium = (base: Cents, percent: number): Cents => Math.floor((base * Math.round(percent * 100)) / 10_000 + 1e-9);

  const awfLow = (nl.writtenContract && nl.indefiniteContract && !nl.onCall) || (ageAtStart !== null && ageAtStart < 21 && round(hoursPaid) <= 52);
  const awfBase = vcr(premiumsApply && insured.ww, { wage: NL_YTD_KEYS.awfCumWage, max: NL_YTD_KEYS.awfCumMax, base: NL_YTD_KEYS.awfCumBase }, loonSv, false);
  const aofBase = vcr(premiumsApply && insured.wao, { wage: NL_YTD_KEYS.aofCumWage, max: NL_YTD_KEYS.aofCumMax, base: NL_YTD_KEYS.aofCumBase }, loonSv, false);
  const whkApplies = premiumsApply && (insured.wao || insured.zw);
  const whkBase = vcr(whkApplies, { wage: NL_YTD_KEYS.whkCumWage, max: NL_YTD_KEYS.whkCumMax, base: NL_YTD_KEYS.whkCumBase }, loonSv, false);

  const awfPremium = premium(awfBase, awfLow ? p.awfLowPercent : p.awfHighPercent);
  const aofPremium = premium(aofBase, employer.aofSmallEmployer ? p.aofLowPercent : p.aofHighPercent);
  const wkoPremium = premium(aofBase, p.wkoPercent);
  let whkPercent = employer.whkRatePercent;
  if (whkPercent === null && employer.aofSmallEmployer && employer.sectorCode !== null) {
    whkPercent = p.whkSectorPercent[employer.sectorCode] ?? null;
  }
  if (whkApplies && whkPercent === null) {
    issues.push({ severity: 'error', code: 'employer_incomplete', params: { field: 'whkRatePercent' } });
  }
  const whkPremium = whkPercent === null ? 0 : premium(whkBase, whkPercent);

  if (nl.writtenContract && nl.indefiniteContract && !nl.onCall && insured.ww && employee.startDate && employee.endDate && endsThisPeriod) {
    // HB §7.2.2: the low AWf premium is revised when employment ends within 2 months of its start.
    if (employee.endDate < addYearsMonths(employee.startDate, 0, 2)) {
      issues.push({ severity: 'warning', code: 'awf_revision_required', params: { startDate: employee.startDate, endDate: employee.endDate } });
    }
  }

  // Zvw (HB §8.2): employer levy, or withheld contribution for a DGA (HB §8.2.2, §18.1.1).
  const zvwApplies = hasPeriodWage || loonZvw !== 0;
  const zvwBase = vcr(zvwApplies, { wage: NL_YTD_KEYS.zvwCumWage, max: NL_YTD_KEYS.zvwCumMax, base: NL_YTD_KEYS.zvwCumBase }, loonZvw, true);
  const zvwPercent = isDga ? p.zvwWithheldPercent : p.zvwEmployerLevyPercent;
  const zvwAmount = premium(zvwBase, zvwPercent);
  // Split the Zvw for the transitievergoeding's own income relationship: the regular wage takes the room first.
  let transitionZvwBase = 0;
  let transitionZvw = 0;
  if (transition !== 0 && zvwApplies) {
    const cumWageRegular = ytdValue(ytd, NL_YTD_KEYS.zvwCumWage) + loonZvw - transition;
    const cumMax = ytdValue(ytd, NL_YTD_KEYS.zvwCumMax) + periodMax;
    const regularBase = Math.max(0, anonymous ? cumWageRegular : Math.min(cumWageRegular, cumMax)) - ytdValue(ytd, NL_YTD_KEYS.zvwCumBase);
    transitionZvwBase = zvwBase - regularBase;
    transitionZvw = zvwAmount - premium(regularBase, zvwPercent);
  }
  const zvwWithheld = isDga ? zvwAmount : 0;
  const zvwLevy = isDga ? 0 : zvwAmount;
  if (zvwWithheld !== 0) lines.push({ code: 'nl.zvw_contribution', section: 'tax', labelKey: 'nl.zvw_contribution', amountCents: -zvwWithheld, rate: zvwPercent });

  const employerLine = (code: string, amount: Cents, rate: number | null) => {
    if (amount !== 0) lines.push({ code, section: 'employer', labelKey: code, amountCents: amount, rate });
  };
  employerLine('nl.awf_premium', awfPremium, awfLow ? p.awfLowPercent : p.awfHighPercent);
  employerLine('nl.aof_premium', aofPremium, employer.aofSmallEmployer ? p.aofLowPercent : p.aofHighPercent);
  employerLine('nl.wko_premium', wkoPremium, p.wkoPercent);
  employerLine('nl.whk_premium', whkPremium, whkPercent);
  employerLine('nl.zvw_employer_levy', zvwLevy, p.zvwEmployerLevyPercent);

  // ------------------------------------------------------- minimum wage
  if (!isDga && ageAtEnd !== null && ageAtEnd >= 15 && hourlyRateCents !== null && employed) {
    const entry = [...rules.minimumWage].reverse().find((w) => w.from <= period.start) ?? rules.minimumWage[0]!;
    const key = (Math.min(21, ageAtEnd) as 15 | 16 | 17 | 18 | 19 | 20 | 21);
    const minimum = entry.perHour[key];
    lines.push({ code: 'nl.minimum_wage', section: 'info', labelKey: 'nl.minimum_wage', amountCents: minimum, quantity: null, rate: minimum / 100 });
    if (round(hourlyRateCents) < minimum) {
      issues.push({ severity: 'error', code: 'below_minimum_wage', params: { hourlyCents: round(hourlyRateCents), minimumCents: minimum, age: ageAtEnd } });
    }
  }

  // DGA usual salary (gebruikelijkloonregeling, HB §18.1): a warning, a lower salary can be justified.
  if (isDga && monthlySalaryCents !== null && monthlySalaryCents * 12 < rules.dgaUsualSalaryCents) {
    issues.push({ severity: 'warning', code: 'dga_usual_salary', params: { annualCents: round(monthlySalaryCents * 12), minimumCents: rules.dgaUsualSalaryCents } });
  }

  // ------------------------------------------------------------- totals
  const bySection = (section: PayslipLine['section']) => sumOf(lines.filter((l) => l.section === section).map((l) => l.amountCents));
  const grossCents = bySection('earning');
  const employeeTaxesCents = -bySection('tax');
  const employeeDeductionsCents = -bySection('deduction');
  const reimbursementsCents = bySection('reimbursement');
  const netCents = grossCents - employeeTaxesCents - employeeDeductionsCents + reimbursementsCents;
  const employerTaxesCents = awfPremium + aofPremium + wkoPremium + whkPremium + zvwLevy;
  const employerCostCents = grossCents + employerTaxesCents + pensionEmployer + reimbursementsCents;
  if (netCents < 0) issues.push({ severity: 'error', code: 'negative_net_pay', params: { netCents } });
  else if (netCents === 0 && grossCents !== 0) issues.push({ severity: 'warning', code: 'net_pay_zero' });

  const svDays = svApplies ? employedWeekdays : 0;
  const hoursPaidRounded = round(hoursPaid);
  const cashWage = grossCents - expatAllowance;
  const inKindWage = carValue - carContribution;

  const filingData: NlFilingData = {
    kind: 'nl',
    tableCode,
    applyLoonheffingskorting: applyLhk,
    anonymous,
    insured,
    awfRate: awfLow ? 'low' : 'high',
    aofRate: employer.aofSmallEmployer ? 'low' : 'high',
    zvw: isDga ? 'withheld' : zvwApplies ? 'employer_levy' : 'none',
    contract: { written: nl.writtenContract, indefinite: nl.indefiniteContract, onCall: nl.onCall },
    amounts: {
      loonLbPh: loonLb,
      loonSv,
      premieloonAwf: awfBase,
      premieloonAof: aofBase,
      premieloonWhk: whkBase,
      loonZvw: zvwBase,
      loonTabelBijzondereBeloningen: loonBbAll,
      wageTax,
      labourCredit,
      awfPremium,
      aofPremium,
      wkoPremium,
      whkPremium,
      zvwEmployerLevy: zvwLevy,
      zvwWithheld,
      holidayAllowancePaid: holidayPaid,
      holidayAllowanceAccrued: accrual,
      companyCarValue: carValue,
      companyCarEmployeeContribution: carContribution,
      pensionEmployee,
      taxFreeAllowances,
      cashWage,
      inKindWage,
      overtimeWage,
      travelAllowanceTaxFree: travelTaxFree,
      contractWage: comp
        ? round(comp.payType === 'salary' ? (monthlySalaryCents ?? 0) : (hourlyRateCents ?? 0) * (((contractHours ?? 0) * 52) / 12))
        : 0,
      ...(transition !== 0
        ? { transitionPayment: transition, transitionPaymentWageTax: transitionTax, transitionPaymentLoonZvw: transitionZvwBase, transitionPaymentZvw: transitionZvw }
        : {}),
    },
    hoursPaid: hoursPaidRounded,
    svDays,
    contractHoursPerWeek: contractHours,
    incidentalIncomeReduction: incidental,
    isDga,
  };

  // ------------------------------------------------------------------ YTD
  if (!openingKnown) newYtd[NL_YTD_KEYS.holidayAllowanceOpening] = opening;
  add(NL_YTD_KEYS.loonLbPh, loonLb);
  add(NL_YTD_KEYS.loonBb, loonBbAll);
  add(NL_YTD_KEYS.loonSv, loonSv);
  add(NL_YTD_KEYS.loonZvw, loonZvw);
  add(NL_YTD_KEYS.cashWage, cashWage);
  add(NL_YTD_KEYS.inKindWage, inKindWage);
  add(NL_YTD_KEYS.gross, grossCents);
  add(NL_YTD_KEYS.net, netCents);
  add(NL_YTD_KEYS.wageTax, wageTax);
  add(NL_YTD_KEYS.labourCredit, labourCredit);
  add(NL_YTD_KEYS.zvwWithheld, zvwWithheld);
  add(NL_YTD_KEYS.zvwEmployerLevy, zvwLevy);
  add(NL_YTD_KEYS.awfPremium, awfPremium);
  add(NL_YTD_KEYS.aofPremium, aofPremium);
  add(NL_YTD_KEYS.wkoPremium, wkoPremium);
  add(NL_YTD_KEYS.whkPremium, whkPremium);
  add(NL_YTD_KEYS.holidayAllowanceAccrued, accrual);
  add(NL_YTD_KEYS.holidayAllowancePaid, holidayPaid);
  add(NL_YTD_KEYS.specialRewards, specialRewardsPaid);
  add(NL_YTD_KEYS.transitionPayment, transition);
  add(NL_YTD_KEYS.pensionEmployee, pensionEmployee);
  add(NL_YTD_KEYS.pensionEmployer, pensionEmployer);
  add(NL_YTD_KEYS.companyCarValue, carValue);
  add(NL_YTD_KEYS.companyCarContribution, carContribution);
  add(NL_YTD_KEYS.taxFreeAllowances, taxFreeAllowances);
  add(NL_YTD_KEYS.expatAllowance, expatAllowance);
  add(NL_YTD_KEYS.travelAllowanceTaxFree, travelTaxFree);
  add(NL_YTD_KEYS.overtimeWage, overtimeWage);
  add(NL_YTD_KEYS.hoursPaidX100, round(hoursPaid * 100));
  add(NL_YTD_KEYS.svDays, svDays);
  add(NL_YTD_KEYS.monthsEmployedX10000, round(calendarFraction * 10_000));
  add(NL_YTD_KEYS.employerCost, employerCostCents);

  return {
    lines,
    grossCents,
    taxableWageCents: loonLb,
    employeeTaxesCents,
    employeeDeductionsCents,
    reimbursementsCents,
    netCents,
    employerTaxesCents,
    employerCostCents,
    ytd: newYtd,
    filingData,
    issues,
    ruleSet: rules.id,
  };
}

/** Exposed for tests and hr-api previews: the white-table column for an employee in a period. */
export function nlAgeColumn(dateOfBirth: string, payDate: string, rules: NlRuleSet): NlAgeColumn {
  const aow = nlAowDate(dateOfBirth, rules);
  if (payDate < `${aow.slice(0, 8)}01`) return 'belowAow';
  return Number(dateOfBirth.slice(0, 4)) <= 1945 ? 'aow1945' : 'aow1946';
}
