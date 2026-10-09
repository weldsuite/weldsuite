/**
 * US federal and state filings built from final payslips: Form 941 per
 * quarter, Form 940 and W-2/W-3 per year, and state withholding and
 * unemployment wage reports per quarter. WeldSuite prepares them; the
 * employer files and pays (self-service model, docs/plans/weldhr-payroll.md).
 *
 * Sources (fetched 9 October 2026):
 * - Instructions for Form 941 (03/2026), https://www.irs.gov/instructions/i941
 * - Instructions for Form 940 (2025), https://www.irs.gov/instructions/i940
 *   (the 2026 instructions are not out yet; the line structure is unchanged
 *   in the 2026 draft Schedule A), Schedule A (Form 940) for 2025,
 *   https://www.irs.gov/pub/irs-pdf/f940sa.pdf
 * - General Instructions for Forms W-2 and W-3 (2026),
 *   https://www.irs.gov/instructions/iw2w3
 * - Pub 15 (2026) section 11 (deposit schedules), https://www.irs.gov/publications/p15
 *
 * Not produced: the SSA EFW2 upload file (SSA's TY2026 EFW2 specification
 * could not be fetched to confirm the record positions of codes TT, TP, TA
 * and box 14b), Schedule B as a separate PDF layout (its daily figures are in
 * the 941 summary and document), Form 940 line 10 (state unemployment paid
 * late or partly excluded wages).
 */

import type { GeneratedFile, PayrollDocument, DocumentField, DocumentSection } from '../documents';
import { roundHalfAwayFromZero } from '../money';
import type { UsFilingData } from '../types';
import {
  annualReturnDueDate,
  businessDaysAfter,
  onOrNextBusinessDay,
  quarterBounds,
  quarterlyReturnDueDate,
} from './dates';
import { federalRules, FUTA_CREDIT_REDUCTION } from './federal-rules';
import { FEDERAL_2026 } from './federal-2026';
import { weekday, addDays } from '../periods';

export interface UsPayslipForForms {
  payslipId: string;
  employeeId: string;
  payDate: string;
  filingData: UsFilingData;
  /** Additive: the pay period, for Form 941 line 1 (employees paid for the pay period including the 12th). */
  periodStart?: string;
  periodEnd?: string;
}

export interface UsEmployerForForms {
  name: string;
  ein: string | null;
  address: string[];
  depositSchedule: 'monthly' | 'semiweekly';
  states: Record<string, { withholdingAccountNumber?: string | null; suiAccountNumber?: string | null }>;
}

export interface UsEmployeeForForms {
  employeeId: string;
  name: string;
  /** Full SSN for the employer's copy; masked for anything shown in the UI. */
  ssn: string | null;
  address: string[];
}

export interface UsFormResult {
  /** Lines of the form in cents, e.g. `line2`, `line5a_wages`, `box1`. */
  summary: Record<string, number>;
  /** Balance due with the return (after deposits are taken as made on time), cents. */
  amountDueCents: number;
  dueDate: string;
  document: PayrollDocument;
  files?: GeneratedFile[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `123456` → `$1,234.56`. */
export function usd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/** Plain decimal for CSV files: `1234.56`. */
function decimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** `123456789` → `XXX-XX-6789` (truncation allowed on employee copies, W-2 instructions). */
export function maskSsn(ssn: string | null): string {
  if (!ssn) return '';
  const digits = ssn.replace(/\D/g, '');
  return digits.length >= 4 ? `XXX-XX-${digits.slice(-4)}` : 'XXX-XX-XXXX';
}

function formatSsn(ssn: string | null): string {
  if (!ssn) return '';
  const d = ssn.replace(/\D/g, '');
  return d.length === 9 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : ssn;
}

function formatEin(ein: string | null): string {
  if (!ein) return 'Applied for';
  const d = ein.replace(/\D/g, '');
  return d.length === 9 ? `${d.slice(0, 2)}-${d.slice(2)}` : ein;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function csv(rows: string[][]): string {
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\n')}\n`;
}

const rate = (cents: number, factor: number): number => roundHalfAwayFromZero(cents * factor);

function sumBy<T>(items: readonly T[], f: (t: T) => number): number {
  let s = 0;
  for (const i of items) s += f(i);
  return s;
}

function inRange(date: string, start: string, end: string): boolean {
  return date >= start && date <= end;
}

function field(label: string, value: string, emphasis?: boolean): DocumentField {
  return emphasis ? { label, value, emphasis } : { label, value };
}

function employerBlock(employer: UsEmployerForForms): string[] {
  return [employer.name, `EIN ${formatEin(employer.ein)}`, ...employer.address];
}

/** Federal tax liability of one payslip for Form 941 (withheld income tax + both shares of FICA). */
function liability941(p: UsPayslipForForms): number {
  const f = p.filingData.federal;
  return f.federalIncomeTax + f.ssTaxEmployee + f.ssTaxEmployer + f.medicareTaxEmployee + f.medicareTaxEmployer + f.additionalMedicareTax;
}

/**
 * Spreads `target − sum(values)` (rounding differences between per-payslip
 * figures and the return's totals) onto the last non-zero bucket, never
 * below zero, so the buckets add up to the return's total as the
 * instructions require.
 */
function reconcile(values: number[], target: number): number[] {
  const out = [...values];
  let diff = target - sumBy(out, (v) => v);
  for (let i = out.length - 1; i >= 0 && diff !== 0; i -= 1) {
    if (out[i] === 0 && i > 0) continue;
    const next = Math.max(0, out[i] + diff);
    diff -= next - out[i];
    out[i] = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

/**
 * When the federal deposit (941 taxes) for wages paid on `payDate` is due
 * (Pub 15 section 11):
 * - monthly schedule: the 15th of the following month;
 * - semiweekly schedule: wages paid Wednesday–Friday by the following
 *   Wednesday, Saturday–Tuesday by the following Friday, i.e. the third
 *   business day after the semiweekly period closes (one more day for each
 *   legal holiday among those three weekdays);
 * - $100,000 next-day rule: when `accumulatedCents` (tax accumulated on the
 *   day, optional) reaches $100,000, the next business day.
 * A due date on a weekend or legal holiday moves to the next business day.
 */
export function depositDueDate(schedule: 'monthly' | 'semiweekly', payDate: string, options?: { accumulatedCents?: number }): string {
  if ((options?.accumulatedCents ?? 0) >= 10_000_000) return businessDaysAfter(payDate, 1);
  if (schedule === 'monthly') {
    const year = Number(payDate.slice(0, 4));
    const month = Number(payDate.slice(5, 7));
    const next = month === 12 ? `${year + 1}-01-15` : `${year}-${String(month + 1).padStart(2, '0')}-15`;
    return onOrNextBusinessDay(next);
  }
  const d = weekday(payDate);
  // Wed (3) – Fri (5): the period closes on Friday. Sat (6) – Tue (2): it closes on Tuesday.
  const closesOn = d >= 3 && d <= 5 ? 5 : 2;
  const close = addDays(payDate, (closesOn - d + 7) % 7);
  return businessDaysAfter(close, 3);
}

/** When FUTA tax accumulated in a quarter is due if it exceeds $500 (Instructions for Form 940): the last day of the following month. */
export function futaDepositDueDate(taxYear: number, quarter: 1 | 2 | 3 | 4): string {
  return quarterlyReturnDueDate(taxYear, quarter);
}

// ---------------------------------------------------------------------------
// Form 941
// ---------------------------------------------------------------------------

export function form941(input: {
  employer: UsEmployerForForms;
  taxYear: number;
  quarter: 1 | 2 | 3 | 4;
  payslips: UsPayslipForForms[];
  /** Additive: deposits made for the quarter (line 13); default = the full liability, deposited on time. */
  depositsCents?: number;
  /** Additive: line 12 of the prior quarter's return, for the $2,500 de minimis test. */
  priorQuarterLine12Cents?: number;
}): UsFormResult {
  const { employer, taxYear, quarter } = input;
  const { start, end } = quarterBounds(taxYear, quarter);
  const slips = input.payslips.filter((p) => inRange(p.payDate, start, end));
  const fed = (f: (d: UsFilingData['federal']) => number) => sumBy(slips, (p) => f(p.filingData.federal));

  // Line 1: employees paid for the pay period including the 12th of the quarter's last month.
  const lastMonth = quarter * 3;
  const twelfth = `${taxYear}-${String(lastMonth).padStart(2, '0')}-12`;
  const monthPrefix = twelfth.slice(0, 8);
  const line1 = new Set(
    slips
      .filter((p) => (p.periodStart && p.periodEnd ? inRange(twelfth, p.periodStart, p.periodEnd) : p.payDate.startsWith(monthPrefix)))
      .map((p) => p.employeeId),
  ).size;

  const line2 = fed((f) => f.fitWages);
  const line3 = fed((f) => f.federalIncomeTax);
  const line5aWages = fed((f) => f.ssWages);
  const line5bWages = fed((f) => f.ssTips);
  const line5cWages = fed((f) => f.medicareWages);
  const line5dWages = fed((f) => f.additionalMedicareWages);
  const line5aTax = rate(line5aWages, 0.124);
  const line5bTax = rate(line5bWages, 0.124);
  const line5cTax = rate(line5cWages, 0.029);
  const line5dTax = rate(line5dWages, 0.009);
  const line4 = line2 > 0 && line5aWages + line5bWages + line5cWages === 0 ? 1 : 0;
  const line5e = line5aTax + line5bTax + line5cTax + line5dTax;
  const line5f = 0;
  const line6 = line3 + line5e + line5f;
  // Line 7: employee share actually withheld vs. the employee share of column 2.
  const withheld = fed((f) => f.ssTaxEmployee + f.medicareTaxEmployee + f.additionalMedicareTax);
  const employeeShareOnForm = rate(line5aWages, 0.062) + rate(line5bWages, 0.062) + rate(line5cWages, 0.0145) + line5dTax;
  const line7 = withheld - employeeShareOnForm;
  const line8 = 0;
  const line9 = 0;
  const line10 = line6 + line7 + line8 + line9;
  const line11 = 0;
  const line12 = Math.max(0, line10 - line11);
  const line13 = input.depositsCents ?? line12;
  const line14 = Math.max(0, line12 - line13);
  const line15 = Math.max(0, line13 - line12);

  const deMinimis = line12 < 250_000 || (input.priorQuarterLine12Cents !== undefined && input.priorQuarterLine12Cents < 250_000);
  const line16Box = deMinimis ? 1 : employer.depositSchedule === 'monthly' ? 2 : 3;

  // Liabilities by pay date month (line 16) and by pay date (Schedule B), reconciled to line 12.
  const months = [0, 0, 0];
  const daily = new Map<string, number>();
  for (const p of slips) {
    const m = Number(p.payDate.slice(5, 7)) - (quarter - 1) * 3 - 1;
    months[m] += liability941(p);
    daily.set(p.payDate, (daily.get(p.payDate) ?? 0) + liability941(p));
  }
  const monthly = reconcile(months, line12);
  const days = [...daily.keys()].sort();
  const dailyValues = reconcile(days.map((d) => daily.get(d) ?? 0), line12);

  const summary: Record<string, number> = {
    line1,
    line2,
    line3,
    line4,
    line5a_wages: line5aWages,
    line5a_tax: line5aTax,
    line5b_wages: line5bWages,
    line5b_tax: line5bTax,
    line5c_wages: line5cWages,
    line5c_tax: line5cTax,
    line5d_wages: line5dWages,
    line5d_tax: line5dTax,
    line5e,
    line5f,
    line6,
    line7,
    line8,
    line9,
    line10,
    line11,
    line12,
    line13,
    line14,
    line15,
    line16_box: line16Box,
    line16_month1: monthly[0],
    line16_month2: monthly[1],
    line16_month3: monthly[2],
    line16_total: monthly[0] + monthly[1] + monthly[2],
  };
  const scheduleB: string[][] = [];
  days.forEach((d, i) => {
    const m = Number(d.slice(5, 7)) - (quarter - 1) * 3;
    summary[`scheduleB_m${m}_d${Number(d.slice(8, 10))}`] = dailyValues[i];
    scheduleB.push([d, usd(dailyValues[i])]);
  });

  const dueDate = quarterlyReturnDueDate(taxYear, quarter);
  const sections: DocumentSection[] = [
    {
      kind: 'fields',
      title: 'Part 1: Answer these questions for this quarter',
      fields: [
        field('1 Number of employees who received wages for the pay period including the 12th', String(line1)),
        field('2 Wages, tips, and other compensation', usd(line2)),
        field('3 Federal income tax withheld', usd(line3)),
        field('4 No wages subject to social security or Medicare tax', line4 ? 'Yes' : 'No'),
        field('5a Taxable social security wages × 0.124', `${usd(line5aWages)} → ${usd(line5aTax)}`),
        field('5b Taxable social security tips × 0.124', `${usd(line5bWages)} → ${usd(line5bTax)}`),
        field('5c Taxable Medicare wages & tips × 0.029', `${usd(line5cWages)} → ${usd(line5cTax)}`),
        field('5d Wages & tips subject to Additional Medicare Tax × 0.009', `${usd(line5dWages)} → ${usd(line5dTax)}`),
        field('5e Total social security and Medicare taxes', usd(line5e)),
        field('5f Section 3121(q) Notice and Demand', usd(line5f)),
        field('6 Total taxes before adjustments', usd(line6)),
        field('7 Current quarter’s adjustment for fractions of cents', usd(line7)),
        field('8 Current quarter’s adjustment for sick pay', usd(line8)),
        field('9 Current quarter’s adjustments for tips and group-term life insurance', usd(line9)),
        field('10 Total taxes after adjustments', usd(line10)),
        field('11 Qualified small business payroll tax credit for increasing research activities', usd(line11)),
        field('12 Total taxes after adjustments and nonrefundable credits', usd(line12), true),
        field('13 Total deposits for this quarter', usd(line13)),
        field('14 Balance due', usd(line14), true),
        field('15 Overpayment', usd(line15)),
      ],
    },
    {
      kind: 'fields',
      title: 'Part 2: Deposit schedule and tax liability for this quarter',
      fields:
        line16Box === 1
          ? [field('16', 'Line 12 is less than $2,500 (or the prior quarter’s was): no deposit record is required.')]
          : line16Box === 2
            ? [
                field('16 Monthly schedule depositor — Month 1', usd(monthly[0])),
                field('Month 2', usd(monthly[1])),
                field('Month 3', usd(monthly[2])),
                field('Total liability for quarter', usd(monthly[0] + monthly[1] + monthly[2]), true),
              ]
            : [field('16 Semiweekly schedule depositor', 'Complete Schedule B (Form 941) with the daily liabilities below.')],
    },
  ];
  if (line16Box === 3) {
    sections.push({
      kind: 'table',
      title: 'Schedule B (Form 941): tax liability by pay date',
      columns: ['Pay date', 'Tax liability'],
      alignRight: [1],
      rows: scheduleB,
      totals: ['Total liability for the quarter', usd(sumBy(dailyValues, (v) => v))],
    });
  }
  sections.push({
    kind: 'text',
    paragraphs: [
      `Due ${dueDate}. If all taxes for the quarter were deposited on time, the return may be filed by the 10th day of the second month after the quarter.`,
      'Prepared by WeldSuite from final payslips. The employer reviews, signs and files the return and makes the deposits through EFTPS.',
    ],
  });

  return {
    summary,
    amountDueCents: line14,
    dueDate,
    document: {
      title: `Form 941 — Employer’s Quarterly Federal Tax Return`,
      subtitle: `Quarter ${quarter}, ${taxYear}`,
      language: 'en',
      from: employerBlock(employer),
      sections,
      footer: ['Worksheet for Form 941; transcribe onto the official form or file electronically through an IRS e-file provider.'],
    },
  };
}

// ---------------------------------------------------------------------------
// Form 940
// ---------------------------------------------------------------------------

export function form940(input: {
  employer: UsEmployerForForms;
  taxYear: number;
  payslips: UsPayslipForForms[];
  /** Additive: FUTA tax deposited for the year (line 13); default = the full liability, deposited on time. */
  depositsCents?: number;
}): UsFormResult {
  const { employer, taxYear } = input;
  const rules = federalRules(taxYear) ?? FEDERAL_2026;
  const netRate = (rules.futa.grossRatePercent - rules.futa.maxCreditPercent) / 100;
  const slips = input.payslips.filter((p) => p.payDate.startsWith(`${taxYear}-`));
  const fed = (f: (d: UsFilingData['federal']) => number) => sumBy(slips, (p) => f(p.filingData.federal));

  const states = new Set<string>();
  for (const p of slips) {
    for (const [st, s] of Object.entries(p.filingData.states)) if (s.suiGrossWages > 0 || s.suiWages > 0) states.add(st);
  }
  const reductionRates = FUTA_CREDIT_REDUCTION[taxYear] ?? {};

  const line3 = fed((f) => f.futaGrossWages);
  const line4 = fed((f) => f.futaExemptWages ?? 0);
  const line7 = fed((f) => f.futaWages);
  const line5 = Math.max(0, line3 - line4 - line7);
  const line6 = line4 + line5;
  const line8 = rate(line7, netRate);
  // Line 9: only when ALL taxable FUTA wages were excluded from state unemployment tax (the
  // state module reported no SUI wages for them).
  const excludedFromSui = sumBy(slips, (p) => {
    const st = p.filingData.federal.futaState;
    const s = st ? p.filingData.states[st] : undefined;
    return s && s.suiGrossWages === 0 ? p.filingData.federal.futaWages : 0;
  });
  const line9 = line7 > 0 && excludedFromSui === line7 ? rate(line7, rules.futa.maxCreditPercent / 100) : 0;
  const line10 = 0;

  // Schedule A: FUTA taxable wages per credit-reduction state × the state's rate.
  const scheduleA = new Map<string, number>();
  for (const p of slips) {
    const st = p.filingData.federal.futaState;
    if (!st || !(reductionRates[st] > 0)) continue;
    const s = p.filingData.states[st];
    if (s && s.suiGrossWages === 0) continue;
    scheduleA.set(st, (scheduleA.get(st) ?? 0) + p.filingData.federal.futaWages);
  }
  const scheduleARows: string[][] = [];
  let line11 = 0;
  for (const [st, wages] of [...scheduleA.entries()].sort()) {
    const reduction = rate(wages, reductionRates[st] / 100);
    line11 += reduction;
    scheduleARows.push([st, usd(wages), `${(reductionRates[st] / 100).toFixed(3)}`, usd(reduction)]);
  }
  const line12 = line8 + line9 + line10 + line11;
  const line13 = input.depositsCents ?? line12;
  const line14 = Math.max(0, line12 - line13);
  const line15 = Math.max(0, line13 - line12);

  // Part 5: FUTA liability by quarter (credit reduction in the fourth quarter), reconciled to line 12.
  const quarters = [0, 0, 0, 0];
  for (const p of slips) {
    const q = Math.floor((Number(p.payDate.slice(5, 7)) - 1) / 3);
    const f = p.filingData.federal;
    quarters[q] += f.futaTax - (f.futaCreditReduction ?? 0);
  }
  quarters[3] += line11;
  const part5 = line12 > 50_000 ? reconcile(quarters, line12) : [0, 0, 0, 0];

  const summary: Record<string, number> = {
    line1b: states.size > 1 ? 1 : 0,
    line2: line11 > 0 ? 1 : 0,
    line3,
    line4,
    line5,
    line6,
    line7,
    line8,
    line9,
    line10,
    line11,
    line12,
    line13,
    line14,
    line15,
    line16a: part5[0],
    line16b: part5[1],
    line16c: part5[2],
    line16d: part5[3],
    line17: sumBy(part5, (v) => v),
  };
  for (const [st, wages] of scheduleA) {
    summary[`scheduleA_${st}_wages`] = wages;
    summary[`scheduleA_${st}_reduction`] = rate(wages, reductionRates[st] / 100);
  }

  const dueDate = annualReturnDueDate(taxYear);
  const stateList = [...states].sort();
  const sections: DocumentSection[] = [
    {
      kind: 'fields',
      title: 'Part 1: About your return',
      fields: [
        field('1a One state only', stateList.length === 1 ? stateList[0] : ''),
        field('1b More than one state (Schedule A required)', stateList.length > 1 ? `Yes: ${stateList.join(', ')}` : 'No'),
        field('2 Wages paid in a credit reduction state (Schedule A required)', line11 > 0 ? 'Yes' : 'No'),
      ],
    },
    {
      kind: 'fields',
      title: 'Part 2: FUTA tax before adjustments',
      fields: [
        field('3 Total payments to all employees', usd(line3)),
        field('4 Payments exempt from FUTA tax', usd(line4)),
        field('5 Total of payments made to each employee in excess of $7,000', usd(line5)),
        field('6 Subtotal (line 4 + line 5)', usd(line6)),
        field('7 Total taxable FUTA wages', usd(line7)),
        field('8 FUTA tax before adjustments (line 7 × 0.006)', usd(line8)),
      ],
    },
    {
      kind: 'fields',
      title: 'Part 3: Adjustments',
      fields: [
        field('9 All taxable FUTA wages excluded from state unemployment tax (line 7 × 0.054)', usd(line9)),
        field('10 Some wages excluded, or state unemployment tax paid late', usd(line10)),
        field('11 Credit reduction (Schedule A)', usd(line11)),
      ],
    },
    {
      kind: 'fields',
      title: 'Part 4: Your FUTA tax and balance due or overpayment',
      fields: [
        field('12 Total FUTA tax after adjustments', usd(line12), true),
        field('13 FUTA tax deposited for the year', usd(line13)),
        field('14 Balance due', usd(line14), true),
        field('15 Overpayment', usd(line15)),
      ],
    },
  ];
  if (line12 > 50_000) {
    sections.push({
      kind: 'table',
      title: 'Part 5: FUTA tax liability by quarter',
      columns: ['Quarter', 'Liability'],
      alignRight: [1],
      rows: part5.map((v, i) => [`16${'abcd'[i]} ${['1st', '2nd', '3rd', '4th'][i]} quarter`, usd(v)]),
      totals: ['17 Total tax liability for the year', usd(sumBy(part5, (v) => v))],
    });
  }
  if (scheduleARows.length > 0) {
    sections.push({
      kind: 'table',
      title: 'Schedule A (Form 940): credit reduction',
      columns: ['State', 'FUTA taxable wages', 'Reduction rate', 'Credit reduction'],
      alignRight: [1, 2, 3],
      rows: scheduleARows,
      totals: ['Total credit reduction', '', '', usd(line11)],
    });
  }
  sections.push({
    kind: 'text',
    paragraphs: [
      `Due ${dueDate}. If all FUTA tax was deposited when due, the return may be filed by the 10th day of the following month.`,
      'Line 10 (wages partly excluded from state unemployment tax, or state tax paid late) is not computed: check it with your state unemployment payments before filing.',
      'Prepared by WeldSuite from final payslips. The employer reviews, signs and files the return and deposits FUTA tax through EFTPS.',
    ],
  });

  return {
    summary,
    amountDueCents: line14,
    dueDate,
    document: {
      title: 'Form 940 — Employer’s Annual Federal Unemployment (FUTA) Tax Return',
      subtitle: String(taxYear),
      language: 'en',
      from: employerBlock(employer),
      sections,
      footer: ['Worksheet for Form 940; transcribe onto the official form or file electronically through an IRS e-file provider.'],
    },
  };
}

// ---------------------------------------------------------------------------
// W-2 and W-3
// ---------------------------------------------------------------------------

interface W2Totals {
  box1: number;
  box2: number;
  box3: number;
  box4: number;
  box5: number;
  box6: number;
  box7: number;
  box10: number;
  box12: Record<string, number>;
  statutoryEmployee: boolean;
  retirementPlan: boolean;
  states: Record<string, { wages: number; tax: number }>;
}

function w2Totals(payslips: readonly UsPayslipForForms[]): W2Totals {
  const t: W2Totals = {
    box1: 0,
    box2: 0,
    box3: 0,
    box4: 0,
    box5: 0,
    box6: 0,
    box7: 0,
    box10: 0,
    box12: {},
    statutoryEmployee: false,
    retirementPlan: false,
    states: {},
  };
  for (const p of payslips) {
    const f = p.filingData.federal;
    t.box1 += f.fitWages;
    t.box2 += f.federalIncomeTax;
    t.box3 += f.ssWages;
    t.box4 += f.ssTaxEmployee;
    t.box5 += f.medicareWages;
    t.box6 += f.medicareTaxEmployee + f.additionalMedicareTax;
    t.box7 += f.ssTips;
    t.box10 += f.dependentCare;
    for (const [code, cents] of Object.entries(f.box12)) t.box12[code] = (t.box12[code] ?? 0) + cents;
    t.statutoryEmployee ||= f.statutoryEmployee === true;
    t.retirementPlan ||= f.retirementPlan === true;
    for (const [st, s] of Object.entries(p.filingData.states)) {
      const prev = t.states[st] ?? { wages: 0, tax: 0 };
      t.states[st] = { wages: prev.wages + s.stateWages, tax: prev.tax + s.stateIncomeTax };
    }
  }
  return t;
}

/** Box 12 codes in the order the W-2 instructions list them. */
const BOX12_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'V', 'W', 'Y', 'Z', 'AA', 'BB', 'DD', 'EE', 'FF', 'GG', 'HH', 'II', 'TA', 'TP', 'TT'];
const DEFERRED_COMP_CODES = ['D', 'E', 'F', 'G', 'H', 'S', 'Y', 'AA', 'BB', 'EE'];

function box12Codes(box12: Record<string, number>): [string, number][] {
  return Object.entries(box12)
    .filter(([, v]) => v !== 0)
    .sort((a, b) => {
      const ia = BOX12_ORDER.indexOf(a[0]);
      const ib = BOX12_ORDER.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
}

export function formW2(input: {
  employer: UsEmployerForForms;
  employee: UsEmployeeForForms;
  taxYear: number;
  payslips: UsPayslipForForms[];
}): UsFormResult {
  const { employer, employee, taxYear } = input;
  const slips = input.payslips.filter((p) => p.payDate.startsWith(`${taxYear}-`) && p.employeeId === employee.employeeId);
  const t = w2Totals(slips);
  const codes = box12Codes(t.box12);

  const summary: Record<string, number> = {
    box1: t.box1,
    box2: t.box2,
    box3: t.box3,
    box4: t.box4,
    box5: t.box5,
    box6: t.box6,
    box7: t.box7,
    box8: 0,
    box10: t.box10,
    box11: 0,
    box13_statutory: t.statutoryEmployee ? 1 : 0,
    box13_retirement: t.retirementPlan ? 1 : 0,
    box13_sick_pay: 0,
  };
  for (const [code, cents] of codes) summary[`box12_${code}`] = cents;
  const stateCodes = Object.keys(t.states).sort();
  for (const st of stateCodes) {
    summary[`box16_${st}`] = t.states[st].wages;
    summary[`box17_${st}`] = t.states[st].tax;
  }

  const dueDate = annualReturnDueDate(taxYear);
  const sections: DocumentSection[] = [
    {
      kind: 'fields',
      title: 'Employee and employer',
      fields: [
        field('a Employee’s social security number', maskSsn(employee.ssn)),
        field('b Employer identification number (EIN)', formatEin(employer.ein)),
        field('c Employer’s name and address', [employer.name, ...employer.address].join(', ')),
        field('e/f Employee’s name and address', [employee.name, ...employee.address].join(', ')),
      ],
    },
    {
      kind: 'fields',
      title: 'Wages and taxes',
      fields: [
        field('1 Wages, tips, other compensation', usd(t.box1), true),
        field('2 Federal income tax withheld', usd(t.box2), true),
        field('3 Social security wages', usd(t.box3)),
        field('4 Social security tax withheld', usd(t.box4)),
        field('5 Medicare wages and tips', usd(t.box5)),
        field('6 Medicare tax withheld', usd(t.box6)),
        field('7 Social security tips', usd(t.box7)),
        field('8 Allocated tips', usd(0)),
        field('10 Dependent care benefits', usd(t.box10)),
        field('11 Nonqualified plans', usd(0)),
      ],
    },
    {
      kind: 'table',
      title: '12 Codes',
      columns: ['Code', 'Amount'],
      alignRight: [1],
      rows: codes.map(([code, cents]) => [code, usd(cents)]),
    },
    {
      kind: 'fields',
      title: '13 Checkboxes',
      fields: [
        field('Statutory employee', t.statutoryEmployee ? 'X' : ''),
        field('Retirement plan', t.retirementPlan ? 'X' : ''),
        field('Third-party sick pay', ''),
      ],
    },
    {
      kind: 'table',
      title: 'State',
      columns: ['15 State', 'Employer’s state ID number', '16 State wages, tips, etc.', '17 State income tax'],
      alignRight: [2, 3],
      rows: stateCodes.map((st) => [st, employer.states[st]?.withholdingAccountNumber ?? '', usd(t.states[st].wages), usd(t.states[st].tax)]),
    },
  ];
  const notes: string[] = [];
  if (codes.length > 4) notes.push('More than four box 12 codes: on paper, issue a second Form W-2 for the remaining codes (W-2 instructions, "Multiple forms").');
  if (t.box12.TP) notes.push('Code TP (cash tips) requires the Treasury Tipped Occupation Code in box 14b; enter it before furnishing this form.');
  notes.push(`Furnish to the employee and file with the SSA (Copy A, with Form W-3) by ${dueDate}. Copy A must show the full SSN.`);
  sections.push({ kind: 'text', paragraphs: notes });

  return {
    summary,
    amountDueCents: 0,
    dueDate,
    document: {
      title: 'Form W-2 Wage and Tax Statement',
      subtitle: `${taxYear} — Copies B, C and 2 for the employee`,
      language: 'en',
      from: employerBlock(employer),
      to: [employee.name, ...employee.address],
      sections,
      footer: ['This information is being furnished to the Internal Revenue Service.'],
    },
  };
}

export function formW3(input: {
  employer: UsEmployerForForms;
  taxYear: number;
  employees: Array<{ employee: UsEmployeeForForms; payslips: UsPayslipForForms[] }>;
}): UsFormResult {
  const { employer, taxYear } = input;
  const all: UsPayslipForForms[] = [];
  let formCount = 0;
  for (const e of input.employees) {
    const slips = e.payslips.filter((p) => p.payDate.startsWith(`${taxYear}-`) && p.employeeId === e.employee.employeeId);
    if (slips.length === 0) continue;
    formCount += 1;
    all.push(...slips);
  }
  const t = w2Totals(all);
  const box12a = sumBy(DEFERRED_COMP_CODES, (c) => t.box12[c] ?? 0);
  const stateCodes = Object.keys(t.states).sort();
  const summary: Record<string, number> = {
    boxC: formCount,
    box1: t.box1,
    box2: t.box2,
    box3: t.box3,
    box4: t.box4,
    box5: t.box5,
    box6: t.box6,
    box7: t.box7,
    box8: 0,
    box10: t.box10,
    box11: 0,
    box12a: box12a,
    box13: 0,
    box14: 0,
  };
  for (const st of stateCodes) {
    summary[`box16_${st}`] = t.states[st].wages;
    summary[`box17_${st}`] = t.states[st].tax;
  }
  const dueDate = annualReturnDueDate(taxYear);
  return {
    summary,
    amountDueCents: 0,
    dueDate,
    document: {
      title: 'Form W-3 Transmittal of Wage and Tax Statements',
      subtitle: String(taxYear),
      language: 'en',
      from: employerBlock(employer),
      sections: [
        {
          kind: 'fields',
          title: 'Transmittal',
          fields: [
            field('b Kind of payer', '941'),
            field('c Total number of Forms W-2', String(formCount)),
            field('e Employer identification number (EIN)', formatEin(employer.ein)),
            field('f Employer’s name', employer.name),
          ],
        },
        {
          kind: 'fields',
          title: 'Totals',
          fields: [
            field('1 Wages, tips, other compensation', usd(t.box1), true),
            field('2 Federal income tax withheld', usd(t.box2), true),
            field('3 Social security wages', usd(t.box3)),
            field('4 Social security tax withheld', usd(t.box4)),
            field('5 Medicare wages and tips', usd(t.box5)),
            field('6 Medicare tax withheld', usd(t.box6)),
            field('7 Social security tips', usd(t.box7)),
            field('10 Dependent care benefits', usd(t.box10)),
            field('12a Deferred compensation (codes D–H, S, Y, AA, BB, EE)', usd(box12a)),
          ],
        },
        {
          kind: 'table',
          title: 'State totals',
          columns: ['15 State', 'Employer’s state ID number', '16 State wages', '17 State income tax'],
          alignRight: [2, 3],
          rows: stateCodes.map((st) => [st, employer.states[st]?.withholdingAccountNumber ?? '', usd(t.states[st].wages), usd(t.states[st].tax)]),
        },
        {
          kind: 'text',
          paragraphs: [
            `File Copy A of every Form W-2 with this transmittal with the SSA by ${dueDate}. Employers filing 10 or more information returns must e-file (SSA Business Services Online).`,
            'Totals must equal the sum of the four Forms 941 for the year (wages, income tax, social security and Medicare).',
          ],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// State reports
// ---------------------------------------------------------------------------

interface StateRow {
  employee: UsEmployeeForForms;
  gross: number;
  stateWages: number;
  tax: number;
  suiGross: number;
  suiTaxable: number;
  suiEmployee: number;
  suiEmployer: number;
}

function stateRows(
  employees: Array<{ employee: UsEmployeeForForms; payslips: UsPayslipForForms[] }>,
  state: string,
  taxYear: number,
  quarter: 1 | 2 | 3 | 4,
): StateRow[] {
  const { start, end } = quarterBounds(taxYear, quarter);
  const rows: StateRow[] = [];
  for (const e of employees) {
    const slips = e.payslips.filter((p) => inRange(p.payDate, start, end) && p.employeeId === e.employee.employeeId && p.filingData.states[state]);
    if (slips.length === 0) continue;
    rows.push({
      employee: e.employee,
      gross: sumBy(slips, (p) => p.filingData.federal.futaGrossWages),
      stateWages: sumBy(slips, (p) => p.filingData.states[state].stateWages),
      tax: sumBy(slips, (p) => p.filingData.states[state].stateIncomeTax),
      suiGross: sumBy(slips, (p) => p.filingData.states[state].suiGrossWages),
      suiTaxable: sumBy(slips, (p) => p.filingData.states[state].suiWages),
      suiEmployee: sumBy(slips, (p) => p.filingData.states[state].suiEmployeeTax),
      suiEmployer: sumBy(slips, (p) => p.filingData.states[state].suiEmployerTax),
    });
  }
  return rows.sort((a, b) => (a.employee.name < b.employee.name ? -1 : a.employee.name > b.employee.name ? 1 : 0));
}

/**
 * Quarterly state income tax withholding report: per employee name, SSN,
 * gross pay, state wages and state tax withheld, with totals and a CSV for
 * keying into (or uploading to) the state's portal. Due date: the last day of
 * the month after the quarter (the common quarterly reconciliation date; the
 * state's own deposit schedule may require earlier payments).
 */
export function stateWithholdingReport(input: {
  employer: UsEmployerForForms;
  state: string;
  taxYear: number;
  quarter: 1 | 2 | 3 | 4;
  employees: Array<{ employee: UsEmployeeForForms; payslips: UsPayslipForForms[] }>;
}): UsFormResult {
  const state = input.state.toUpperCase();
  const rows = stateRows(input.employees, state, input.taxYear, input.quarter);
  const total = {
    gross: sumBy(rows, (r) => r.gross),
    stateWages: sumBy(rows, (r) => r.stateWages),
    tax: sumBy(rows, (r) => r.tax),
  };
  const account = input.employer.states[state]?.withholdingAccountNumber ?? '';
  const dueDate = quarterlyReturnDueDate(input.taxYear, input.quarter);
  const file: GeneratedFile = {
    fileName: `${state.toLowerCase()}-withholding-${input.taxYear}-q${input.quarter}.csv`,
    contentType: 'text/csv',
    content: csv([
      ['employee_id', 'name', 'ssn', 'gross_wages', 'state_wages', 'state_tax_withheld'],
      ...rows.map((r) => [r.employee.employeeId, r.employee.name, formatSsn(r.employee.ssn), decimal(r.gross), decimal(r.stateWages), decimal(r.tax)]),
      ['', 'TOTAL', '', decimal(total.gross), decimal(total.stateWages), decimal(total.tax)],
    ]),
  };
  return {
    summary: { employees: rows.length, gross: total.gross, stateWages: total.stateWages, stateTax: total.tax },
    amountDueCents: total.tax,
    dueDate,
    document: {
      title: `${state} income tax withholding — quarterly report`,
      subtitle: `Quarter ${input.quarter}, ${input.taxYear}`,
      language: 'en',
      from: [...employerBlock(input.employer), ...(account ? [`${state} withholding account ${account}`] : [])],
      sections: [
        {
          kind: 'table',
          columns: ['Employee', 'SSN', 'Gross wages', 'State wages', 'State tax withheld'],
          alignRight: [2, 3, 4],
          rows: rows.map((r) => [r.employee.name, maskSsn(r.employee.ssn), usd(r.gross), usd(r.stateWages), usd(r.tax)]),
          totals: ['Total', '', usd(total.gross), usd(total.stateWages), usd(total.tax)],
        },
        {
          kind: 'text',
          paragraphs: [`File with ${state} by ${dueDate} (verify the state's own deadline and deposit schedule). The CSV next to this report has full SSNs for filing.`],
        },
      ],
    },
    files: [file],
  };
}

/**
 * Quarterly state unemployment insurance wage report: per employee name,
 * SSN, gross UI wages, taxable UI wages (after the state's wage base) and
 * contributions, with totals and a CSV. Due the last day of the month after
 * the quarter.
 */
export function stateUnemploymentReport(input: {
  employer: UsEmployerForForms;
  state: string;
  taxYear: number;
  quarter: 1 | 2 | 3 | 4;
  employees: Array<{ employee: UsEmployeeForForms; payslips: UsPayslipForForms[] }>;
}): UsFormResult {
  const state = input.state.toUpperCase();
  const rows = stateRows(input.employees, state, input.taxYear, input.quarter);
  const total = {
    suiGross: sumBy(rows, (r) => r.suiGross),
    suiTaxable: sumBy(rows, (r) => r.suiTaxable),
    suiEmployee: sumBy(rows, (r) => r.suiEmployee),
    suiEmployer: sumBy(rows, (r) => r.suiEmployer),
  };
  const account = input.employer.states[state]?.suiAccountNumber ?? '';
  const dueDate = quarterlyReturnDueDate(input.taxYear, input.quarter);
  const file: GeneratedFile = {
    fileName: `${state.toLowerCase()}-unemployment-${input.taxYear}-q${input.quarter}.csv`,
    contentType: 'text/csv',
    content: csv([
      ['employee_id', 'name', 'ssn', 'gross_wages', 'taxable_wages', 'employee_contribution', 'employer_contribution'],
      ...rows.map((r) => [
        r.employee.employeeId,
        r.employee.name,
        formatSsn(r.employee.ssn),
        decimal(r.suiGross),
        decimal(r.suiTaxable),
        decimal(r.suiEmployee),
        decimal(r.suiEmployer),
      ]),
      ['', 'TOTAL', '', decimal(total.suiGross), decimal(total.suiTaxable), decimal(total.suiEmployee), decimal(total.suiEmployer)],
    ]),
  };
  return {
    summary: {
      employees: rows.length,
      grossWages: total.suiGross,
      taxableWages: total.suiTaxable,
      excessWages: total.suiGross - total.suiTaxable,
      employeeContributions: total.suiEmployee,
      employerContributions: total.suiEmployer,
    },
    amountDueCents: total.suiEmployee + total.suiEmployer,
    dueDate,
    document: {
      title: `${state} unemployment insurance — quarterly wage report`,
      subtitle: `Quarter ${input.quarter}, ${input.taxYear}`,
      language: 'en',
      from: [...employerBlock(input.employer), ...(account ? [`${state} UI account ${account}`] : [])],
      sections: [
        {
          kind: 'table',
          columns: ['Employee', 'SSN', 'Gross wages', 'Taxable wages', 'Employee', 'Employer'],
          alignRight: [2, 3, 4, 5],
          rows: rows.map((r) => [r.employee.name, maskSsn(r.employee.ssn), usd(r.suiGross), usd(r.suiTaxable), usd(r.suiEmployee), usd(r.suiEmployer)]),
          totals: ['Total', '', usd(total.suiGross), usd(total.suiTaxable), usd(total.suiEmployee), usd(total.suiEmployer)],
        },
        {
          kind: 'text',
          paragraphs: [`File and pay with ${state} by ${dueDate}. The CSV next to this report has full SSNs for filing.`],
        },
      ],
    },
    files: [file],
  };
}
