/**
 * Tables and test vectors for the Rust port of `@weldsuite/payroll-domain`
 * (`rust/crates/payroll-domain`).
 *
 * - `data/*.json`: the rule, label and code tables the engines read, taken
 *   from the TypeScript modules so the two can't drift.
 * - `tests/fixtures/*.json`: inputs and what the TypeScript engines answer
 *   for them. The Rust tests run the same inputs and compare, so payroll
 *   amounts, files and documents are the TypeScript's to the cent.
 *
 * Inputs come from a seeded generator (the same every run) plus the
 * hand-written scenarios of the package's own tests.
 *
 *   pnpm rust:payroll-fixtures           write the tables and vectors
 *   pnpm rust:payroll-fixtures --check   exit 1 when one is stale
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { calculatePayslip } from '../packages/domains/payroll/src';
import { fromCents, toCents } from '../packages/domains/payroll/src/money';
import {
  ageOn,
  nextPeriodToRun,
  periodContaining,
  quarterOf,
  weekdaysBetween,
  type PayScheduleSpec,
} from '../packages/domains/payroll/src/periods';
import { PAYSLIP_LABELS } from '../packages/domains/payroll/src/labels';
import { NL_RULES_2026 } from '../packages/domains/payroll/src/nl/rules-2026';
import { NL_RULES_2027 } from '../packages/domains/payroll/src/nl/rules-2027';
import { BRP_NATIONALITY } from '../packages/domains/payroll/src/nl/nationality';
import { nlRulesForYear } from '../packages/domains/payroll/src/nl/rules';
import { periodWageTax, specialRewardPercent, type NlAgeColumn } from '../packages/domains/payroll/src/nl/wage-tax';
import { nlAnnualStatement } from '../packages/domains/payroll/src/nl/annual-statement';
import {
  betalingskenmerk,
  buildLoonaangifte,
  isValidBsn,
  loonaangifteSummaryDocument,
  sumNlFilingData,
  type LoonaangifteIkv,
  type LoonaangifteInput,
} from '../packages/domains/payroll/src/nl/loonaangifte';
import { calculateNlPayslip } from '../packages/domains/payroll/src/nl/calculate';
import {
  ANNA_IDENTITY,
  DGA_IDENTITY,
  STARTER_IDENTITY,
  loonaangifteInput,
  scenario,
} from '../packages/domains/payroll/src/nl/fixtures/employer-scenario';
import { STATE_NAMES } from '../packages/domains/payroll/src/us/states/labels';
import { STATE_CERTIFICATE_LABELS } from '../packages/domains/payroll/src/us/states/certificate-labels';
import type { NlFilingData, NlPayslipInput, PayFrequency, UsPayslipInput, UsW4Input } from '../packages/domains/payroll/src/types';
import { FEDERAL_2026 } from '../packages/domains/payroll/src/us/federal-2026';
import { FUTA_CREDIT_REDUCTION, federalRules } from '../packages/domains/payroll/src/us/federal-rules';
import { SUPPORTED_STATES, stateModule } from '../packages/domains/payroll/src/us/states';
import { certificate, stateInput } from '../packages/domains/payroll/src/us/states/test-input';
import { computeOvertime } from '../packages/domains/payroll/src/us/overtime';
import { nraAdditionCents, supplementalWithholding, worksheet1A } from '../packages/domains/payroll/src/us/withholding';
import {
  annualReturnDueDate,
  businessDaysAfter,
  legalHolidays,
  quarterlyReturnDueDate,
} from '../packages/domains/payroll/src/us/dates';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crateDir = path.join(repo, 'rust', 'crates', 'payroll-domain');
const check = process.argv.includes('--check');
const stale: string[] = [];

function write(relative: string, value: unknown) {
  const file = path.join(crateDir, relative);
  // Tables stay readable; vectors are compact.
  const text = `${relative.startsWith('data/') ? JSON.stringify(value, null, 1) : JSON.stringify(value)}\n`;
  if (check) {
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) stale.push(relative);
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

// ── a seeded generator ──────────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Gen {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  maybe<T>(value: T, p = 0.5): T | null {
    return this.bool(p) ? value : null;
  }
  money(max: number, decimals = 2): number {
    return Math.round(this.next() * max * 10 ** decimals) / 10 ** decimals;
  }
  date(fromYear: number, toYear: number): string {
    const y = this.int(fromYear, toYear);
    const m = this.int(1, 12);
    const d = this.int(1, new Date(Date.UTC(y, m, 0)).getUTCDate());
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
}

/** Runs `fn`, answering `{ error }` for what it throws. */
function attempt<T>(fn: () => T): T | { error: string } {
  try {
    return fn();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ── tables ──────────────────────────────────────────────────────────────────

write('data/nl-rules.json', { 2026: NL_RULES_2026, 2027: NL_RULES_2027 });
write('data/nl-nationality.json', BRP_NATIONALITY);
write('data/labels.json', { payslip: PAYSLIP_LABELS, stateNames: STATE_NAMES, stateCertificates: STATE_CERTIFICATE_LABELS });

// ── money and periods ───────────────────────────────────────────────────────

{
  const g = new Gen(1);
  const values = [0, 0.005, 0.015, 1.005, 2.675, -1.005, -0.5, 1234.5, 99999999.995, 0.1 + 0.2];
  for (let i = 0; i < 300; i += 1) values.push(g.money(100000, g.int(0, 4)) * (g.bool(0.2) ? -1 : 1));
  write(
    'tests/fixtures/money.json',
    values.map((v) => ({ value: v, toCents: toCents(v), fromCents: fromCents(Math.round(v * 100)) })),
  );
}

{
  const g = new Gen(2);
  const frequencies: PayFrequency[] = ['monthly', 'four_weekly', 'semimonthly', 'biweekly', 'weekly'];
  const cases: unknown[] = [];
  for (let i = 0; i < 400; i += 1) {
    const frequency = g.pick(frequencies);
    const rule = g.pick([
      { kind: 'day_of_month' as const, day: g.int(-2, 33) },
      { kind: 'offset_after_end' as const, days: g.int(-3, 12) },
      { kind: 'last_business_day' as const },
    ]);
    const spec: PayScheduleSpec = { frequency, anchorDate: g.date(2024, 2027), payDateRule: rule };
    const country = g.pick(['NL', 'US'] as const);
    const date = g.date(2025, 2027);
    const containing = attempt(() => periodContaining(spec, country, date));
    const last = g.bool(0.3) ? null : { start: date, end: date };
    const next = attempt(() => nextPeriodToRun(spec, country, last));
    cases.push({ spec, country, date, containing, last, next });
  }
  const dates: unknown[] = [];
  for (let i = 0; i < 200; i += 1) {
    const a = g.date(1940, 2027);
    const b = g.date(2020, 2028);
    dates.push({ a, b, weekdays: weekdaysBetween(a < b ? a : b, a < b ? b : a), age: ageOn(a, b), quarter: quarterOf(b) });
  }
  write('tests/fixtures/periods.json', { cases, dates });
}

// ── NL wage tax ─────────────────────────────────────────────────────────────

{
  const g = new Gen(3);
  const columns: NlAgeColumn[] = ['belowAow', 'aow1945', 'aow1946'];
  const cases: unknown[] = [];
  for (let i = 0; i < 1500; i += 1) {
    const year = g.pick([2026, 2027]);
    const rules = nlRulesForYear(year)!;
    const factor = g.pick([12, 260, 52, 13, 4]);
    const wage = g.bool(0.1) ? g.int(-1000, 0) : g.int(0, g.pick([20_000, 600_000, 2_000_000]));
    const column = g.pick(columns);
    const lhk = g.bool(0.7);
    cases.push({
      year,
      factor,
      wage,
      column,
      lhk,
      result: periodWageTax(wage, factor, column, lhk, rules),
      white: specialRewardPercent(wage * 12, column, lhk, rules, 'white'),
      green: specialRewardPercent(wage * 12, column, lhk, rules, 'green'),
    });
  }
  write('tests/fixtures/nl-wage-tax.json', cases);
}

// ── NL payslips ─────────────────────────────────────────────────────────────

const NL_COMPONENT_CODES = [
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
  'us.401k',
];

function nlParams(g: Gen, code: string): Record<string, number | string | boolean | null> {
  switch (code) {
    case 'nl.travel_allowance':
      return g.bool(0.8) ? { km_per_day: g.pick([g.int(1, 60), String(g.int(1, 40)), '', null]), days_per_month: g.maybe(g.int(1, 22), 0.7) } : {};
    case 'nl.home_working_allowance':
      return g.bool(0.5) ? { days_per_month: g.int(0, 20) } : g.bool(0.5) ? { days: String(g.int(1, 10)) } : {};
    case 'nl.company_car':
      return {
        list_price: g.int(15_000, 90_000),
        percent: g.pick([16, 22, 17]),
        ...(g.bool(0.5) ? { zero_emission_cap: 30_000, zero_emission_percent: 18 } : {}),
        ...(g.bool(0.4) ? { employee_contribution: g.int(0, 400) } : {}),
      };
    case 'nl.pension_employee':
    case 'nl.pension_employer':
      return { percent: g.pick([0, 3.5, 7.25, '5', true]), franchise_per_year: g.pick([0, 17_545, null]) };
    default:
      return {};
  }
}

function nlPeriod(g: Gen, year: number, month: number) {
  const mm = String(month).padStart(2, '0');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${year}-${mm}-01`,
    end: `${year}-${mm}-${last}`,
    payDate: `${year}-${mm}-${String(g.int(20, 28)).padStart(2, '0')}`,
    frequency: g.bool(0.97) ? ('monthly' as const) : ('weekly' as const),
    taxYear: year,
    periodNumber: month,
    periodsPerYear: 12,
  };
}

function randomNlInput(g: Gen): NlPayslipInput {
  const year = g.bool(0.95) ? g.pick([2026, 2027]) : 2025;
  const month = g.int(1, 12);
  const period = nlPeriod(g, year, month);
  const dob = g.bool(0.95) ? g.pick([g.date(1940, 1962), g.date(1958, 1961), g.date(1963, 2012)]) : null;
  const startDate = g.pick([null, g.date(2015, 2025), `${period.start.slice(0, 8)}${String(g.int(1, 28)).padStart(2, '0')}`, g.date(2026, 2028)]);
  const endDate = g.bool(0.75) ? null : g.pick([`${period.start.slice(0, 8)}${String(g.int(1, 28)).padStart(2, '0')}`, g.date(2025, 2028)]);
  const compensation = g.bool(0.07)
    ? null
    : g.bool(0.6)
      ? { payType: 'salary' as const, amount: g.money(9000), period: g.pick(['month', 'year', 'week', 'hour'] as const), hoursPerWeek: g.pick([40, 36, 32, 24, 0, null]) }
      : { payType: 'hourly' as const, amount: g.money(45), period: g.pick(['hour', 'hour', 'week', 'month', 'year'] as const), hoursPerWeek: g.pick([40, 36, 20, null]) };
  const components = Array.from({ length: g.int(0, 4) }, () => {
    const code = g.pick(NL_COMPONENT_CODES);
    return {
      code,
      ...(g.bool(0.3) ? { label: g.pick(['Custom', null]) } : {}),
      amountCents: g.maybe(g.int(-20_000, 150_000), 0.5),
      params: nlParams(g, code),
    };
  });
  const inputs = Array.from({ length: g.int(0, 4) }, () => ({
    code: g.pick(NL_COMPONENT_CODES),
    label: g.maybe('Run line', 0.3),
    quantity: g.maybe(g.pick([g.int(0, 180), g.money(40)]), 0.7),
    rate: g.maybe(g.pick([g.int(50, 200), g.money(40)]), 0.4),
    amountCents: g.maybe(g.int(-50_000, 300_000), 0.4),
    workDate: null,
  }));
  const ytd: Record<string, number> = {};
  if (g.bool(0.7)) {
    for (const key of ['nl.loon_lb', 'nl.awf_cum_wage', 'nl.awf_cum_max', 'nl.awf_cum_base', 'nl.zvw_cum_wage', 'nl.zvw_cum_max', 'nl.zvw_cum_base', 'nl.holiday_allowance_accrued', 'nl.holiday_allowance_paid', 'nl.company_car_value', 'nl.company_car_contribution', 'nl.whk_cum_base']) {
      if (g.bool(0.6)) ytd[key] = g.int(0, 3_000_000);
    }
    if (g.bool(0.3)) ytd['nl.holiday_allowance_opening'] = g.int(0, 200_000);
  }
  return {
    country: 'NL',
    period,
    employee: { dateOfBirth: dob, startDate, endDate },
    compensation,
    components,
    inputs,
    ytd,
    employer: {
      whkRatePercent: g.maybe(g.pick([1.16, 0.9, 2.5]), 0.3),
      sectorCode: g.maybe(g.pick([43, 1, 52, 36, 69]), 0.8),
      aofSmallEmployer: g.bool(0.7),
      holidayAllowancePercent: g.pick([8, 8, 8.33, 0]),
      holidayAllowancePayoutMonth: g.maybe(g.pick([5, 6, month]), 0.75),
    },
    nl: {
      applyLoonheffingskorting: g.bool(0.8),
      anonymous: g.bool(0.08),
      isDga: g.bool(0.1),
      insuredWw: g.bool(0.85),
      insuredZw: g.bool(0.85),
      insuredWao: g.bool(0.85),
      writtenContract: g.bool(0.85),
      indefiniteContract: g.bool(0.6),
      onCall: g.bool(0.1),
      contractHoursPerWeek: g.pick([40, 36, 32, 24, null]),
      expatRulingPercent: g.pick([null, null, 0, 30, 27]),
      previousYearAnnualWageCents: g.maybe(g.int(0, 12_000_000), 0.6),
      ...(g.bool(0.3) ? { holidayAllowanceOpeningBalanceCents: g.int(0, 300_000) } : {}),
      ...(g.bool(0.3) ? { usualWorkDaysPerWeek: g.pick([5, 4, 3, null]) } : {}),
    },
  };
}

{
  const g = new Gen(4);
  const cases: unknown[] = [];
  for (let i = 0; i < 1200; i += 1) {
    const input = randomNlInput(g);
    cases.push({ input, output: attempt(() => calculatePayslip(input)) });
  }
  // A year of one employee, YTD carried, the way a run computes it.
  for (let e = 0; e < 12; e += 1) {
    const base = randomNlInput(g);
    let ytd: Record<string, number> = {};
    for (let m = 1; m <= 12; m += 1) {
      const input: NlPayslipInput = { ...base, period: { ...nlPeriod(g, 2026, m), frequency: 'monthly' }, ytd };
      const output = attempt(() => calculatePayslip(input));
      cases.push({ input, output });
      if ('ytd' in output) ytd = output.ytd;
    }
  }
  const s = scenario();
  write('tests/fixtures/nl-payslips.json', cases);
  write('tests/fixtures/nl-scenario.json', s);
}

// ── NL loonaangifte, annual statement ───────────────────────────────────────

{
  const g = new Gen(5);
  const nlFiling = (input: NlPayslipInput): NlFilingData => {
    const r = calculateNlPayslip(input);
    if (r.filingData.kind !== 'nl') throw new Error('expected NL filing data');
    return r.filingData;
  };
  const identities = [ANNA_IDENTITY, DGA_IDENTITY, STARTER_IDENTITY];
  const randomIdentity = () => {
    const base = g.pick(identities);
    return {
      ...base,
      bsn: g.pick([base.bsn, null, '123456789', '987654321', '1112.22.333']),
      initials: g.pick([base.initials, 'j.p.', '', 'ß']),
      surnamePrefix: g.pick([base.surnamePrefix, null, 'van der']),
      nationality: g.pick([base.nationality, null, 'XX', '55', 'de']),
      gender: g.pick([base.gender, null]),
      address: g.pick([
        base.address,
        null,
        { street: 'Rue de la Paix', houseNumber: '12', houseNumberAddition: 'bis', postalCode: '75002', city: 'Paris', country: 'fr' },
        { street: 'Keizersgracht', houseNumber: '12a', postalCode: '1015cj', city: 'Amsterdam' },
        { street: 'Straat', houseNumber: 'zonder', postalCode: '0123AB', city: 'Ergens', country: 'NL' },
      ]),
      personnelNumber: g.pick([base.personnelNumber, null]),
    };
  };
  const randomIkv = (start: string): LoonaangifteIkv => {
    const input = randomNlInput(g);
    input.period = { ...input.period, start, end: `${start.slice(0, 8)}${new Date(Date.UTC(2026, Number(start.slice(5, 7)), 0)).getUTCDate()}`, taxYear: 2026, frequency: 'monthly' };
    if (g.bool(0.2)) input.components.push({ code: 'nl.transition_payment', amountCents: g.int(1000, 900_000), params: {} });
    return {
      identity: randomIdentity(),
      incomeRelationshipNumber: g.int(1, 3),
      employmentStart: g.pick(['2020-01-01', `${start.slice(0, 8)}15`]),
      employmentEnd: g.pick([null, null, `${start.slice(0, 8)}20`, '2027-01-01']),
      filing: nlFiling(input),
      ...(g.bool(0.3) ? { endReasonCode: g.pick(['01', null]) } : {}),
      ...(g.bool(0.3) ? { caoCode: g.int(1, 9999) } : {}),
      ...(g.bool(0.5) ? { transitionPaymentIncomeRelationshipNumber: g.pick([2, null]) } : {}),
    };
  };
  const cases: unknown[] = [];
  const base = loonaangifteInput();
  const variants: LoonaangifteInput[] = [base, { ...base, kind: 'aanvullend' }];
  for (let i = 0; i < 120; i += 1) {
    const month = g.int(2, 12);
    const start = `2026-${String(month).padStart(2, '0')}-01`;
    variants.push({
      employer: {
        loonheffingennummer: g.pick(['001234560L01', ' 001234560l01 ', '123456782L00', 'nope']),
        name: g.pick(['Voorbeeld B.V.', 'Ünïcødé & Søns <B.V.> "quoted"']),
        contactName: g.pick(['J. Bakker', null, '']),
        contactPhone: g.pick(['020-1234567', '0031 20 1234567', null, '()']),
        ...(g.bool(0.8) ? { sectorCode: g.pick([43, null]) } : {}),
      },
      software: { name: 'WeldSuite', version: g.pick(['1.0', '']), relationNumber: g.pick(['SWO12345', 'swo12345', null, 'SWO1']) },
      taxYear: g.pick([2026, 2026, 2025]),
      period: g.bool(0.9) ? { start, end: `${start.slice(0, 8)}${new Date(Date.UTC(2026, month, 0)).getUTCDate()}` } : { start, end: start },
      ikvs: Array.from({ length: g.int(0, 4) }, () => randomIkv(start)),
      corrections: Array.from({ length: g.pick([0, 0, 1, 2]) }, () => {
        const cm = g.int(1, month);
        const cs = `2026-${String(cm).padStart(2, '0')}-01`;
        return {
          period: { start: cs, end: `${cs.slice(0, 8)}${new Date(Date.UTC(2026, cm, 0)).getUTCDate()}` },
          ikvs: Array.from({ length: g.int(1, 2) }, () => randomIkv(cs)),
          ...(g.bool(0.8) ? { previouslyReportedTotTeBetCents: g.int(0, 2_000_000) } : {}),
        };
      }),
      createdAt: '2026-05-08T10:15:00.123Z',
      messageId: g.pick(['001234560L01-2026-04-1', 'a-very-long-message-id-that-is-cut-at-thirty-two-characters']),
    });
  }
  for (const input of variants) {
    const result = buildLoonaangifte(input);
    cases.push({
      input,
      result,
      summaryEn: loonaangifteSummaryDocument(result, input, 'en'),
      summaryNl: loonaangifteSummaryDocument(result, input, 'nl'),
    });
  }
  const kenmerken = ['001234560L01', '123456782L02', ' 001234560l01', 'x'].flatMap((l) =>
    [0, 1, 7, 12, 13].map((month) => ({ loonheffingennummer: l, taxYear: 2026, month, kenmerk: betalingskenmerk({ loonheffingennummer: l, taxYear: 2026, month }) })),
  );
  const bsns = ['111222333', '123456782', '232262536', '123456789', '000000000', '811222333', '1112.22.333', '', '12345678'].map((bsn) => ({ bsn, valid: isValidBsn(bsn) }));
  const sums = Array.from({ length: 40 }, () => {
    const items = Array.from({ length: g.int(1, 4) }, () => nlFiling(randomNlInput(g)));
    return { items, sum: sumNlFilingData(items) };
  });
  const s = scenario();
  const annual = (['en', 'nl'] as const).flatMap((lang) =>
    [s.anna, s.dga].map((payslips, i) => {
      const input = {
        lang,
        year: 2026,
        employer: { name: 'Voorbeeld B.V.', loonheffingennummer: i === 0 ? '001234560L01' : null, address: ['Herengracht 1', '1015 BA Amsterdam'] },
        employee: {
          name: i === 0 ? 'Anna de Vries' : 'Piet Jansen',
          bsn: i === 0 ? '111222333' : null,
          dateOfBirth: i === 0 ? '1988-09-12' : null,
          address: ['Keizersgracht 123B'],
          employmentStart: i === 0 ? '2023-02-01' : null,
          employmentEnd: null,
          personnelNumber: i === 0 ? 'E001' : null,
        },
        payslips: payslips.map((p, m) => ({ payDate: `2026-0${m + 1}-24`, filingData: p.filingData as NlFilingData, ytd: p.ytd })),
      };
      return { input, document: nlAnnualStatement(input) };
    }),
  );
  write('tests/fixtures/nl-loonaangifte.json', { cases, kenmerken, bsns, sums, annual });
}

// ── US ──────────────────────────────────────────────────────────────────────

write('data/us-federal.json', { rules: { 2026: FEDERAL_2026 }, futaCreditReduction: FUTA_CREDIT_REDUCTION });
write('data/us-states.json', Object.fromEntries(SUPPORTED_STATES.map((code) => [code, stateModule(code)])));

const US_CODES = [
  'hours.regular', 'hours.regular', 'hours.regular', 'hours.overtime', 'hours.unpaid_leave', 'hours.paid_leave', 'bonus',
  'commission', 'allowance.taxable', 'reimbursement', 'deduction.net', 'advance', 'us.tips_cash', 'us.401k', 'us.roth_401k',
  'us.401k_employer_match', 'us.section125_health', 'us.employer_health', 'us.hsa', 'us.dependent_care', 'nl.company_car',
];
const US_STATES = [...SUPPORTED_STATES, 'ZZ'];
const SINGLE_W4: UsW4Input = {
  formYear: 2026, filingStatus: 'single', multipleJobs: false, dependentsAmount: 0, otherIncome: 0, deductions: 0,
  extraWithholding: 0, exempt: false, allowances: null, nonresidentAlien: false,
};

function randomW4(g: Gen): UsW4Input | null {
  if (g.bool(0.15)) return null;
  return {
    formYear: g.pick([2026, 2020, 2019]),
    filingStatus: g.pick(['single', 'married_jointly', 'head_of_household'] as const),
    multipleJobs: g.bool(0.2),
    dependentsAmount: g.pick([0, 0, 2000, 4500]),
    otherIncome: g.pick([0, 0, 5000]),
    deductions: g.pick([0, 0, 12000]),
    extraWithholding: g.pick([0, 0, 25, 50.5]),
    exempt: g.bool(0.05),
    allowances: g.maybe(g.int(0, 5), 0.3),
    nonresidentAlien: g.bool(0.07),
  };
}

function randomCertificate(g: Gen, state: string) {
  const values: Record<string, number | string | boolean | null> = {};
  for (const f of stateModule(state)?.certificate?.fields ?? []) {
    if (!g.bool(0.6)) continue;
    if (f.type === 'boolean') values[f.key] = g.pick([true, false, 'true', 1, 0]);
    else if (f.type === 'select') values[f.key] = g.pick([...(f.options ?? []), 'bogus']);
    else if (f.type === 'number') values[f.key] = g.pick([0, 1, 2, 3, '2', 12]);
    else values[f.key] = g.pick([0, 25, '5000', 11000, '']);
  }
  return certificate({
    filingStatus: g.maybe(g.pick([...(stateModule(state)?.certificate?.filingStatuses ?? ['single']), 'married']), 0.7),
    allowances: g.maybe(g.pick([0, 1, 2, 3, 11, 2.7]), 0.6),
    values,
    extraWithholding: g.maybe(g.pick([0, 10, 33.33]), 0.3),
    exempt: g.bool(0.07),
  });
}

function shiftDate(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function usPeriod(g: Gen, frequency: PayFrequency, start: string, index: number): UsPayslipInput['period'] {
  if (frequency === 'weekly' || frequency === 'biweekly') {
    const days = frequency === 'weekly' ? 7 : 14;
    const pay = shiftDate(start, days + 4);
    return { start, end: shiftDate(start, days - 1), payDate: pay, frequency, taxYear: Number(pay.slice(0, 4)), periodNumber: index, periodsPerYear: days === 7 ? 52 : 26 };
  }
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const half = frequency === 'semimonthly';
  const first = !half || g.bool(0.5);
  const s = half && !first ? `${start.slice(0, 8)}16` : `${start.slice(0, 8)}01`;
  const e = half && first ? `${start.slice(0, 8)}15` : `${start.slice(0, 8)}${last}`;
  return { start: s, end: e, payDate: e, frequency, taxYear: y, periodNumber: index, periodsPerYear: half ? 24 : frequency === 'four_weekly' ? 13 : 12 };
}

function randomUsInput(g: Gen): UsPayslipInput {
  const frequency = g.pick(['weekly', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'four_weekly'] as const);
  const start = g.date(2026, 2026);
  const period = usPeriod(g, frequency, frequency === 'weekly' || frequency === 'biweekly' ? start : `${start.slice(0, 8)}01`, g.int(1, 26));
  if (g.bool(0.03)) period.taxYear = 2025;
  const state = g.bool(0.04) ? null : g.pick(US_STATES);
  const compensation = g.bool(0.07)
    ? null
    : g.bool(0.5)
      ? { payType: 'salary' as const, amount: g.pick([g.money(250000), g.money(9000), g.money(2000)]), period: g.pick(['year', 'month', 'week', 'hour'] as const), hoursPerWeek: g.pick([40, 37.5, 0, null]) }
      : { payType: 'hourly' as const, amount: g.money(80), period: g.pick(['hour', 'hour', 'week', 'year'] as const), hoursPerWeek: g.pick([40, 20, null]) };
  const components = Array.from({ length: g.int(0, 4) }, () => {
    const code = g.pick(US_CODES);
    const params: Record<string, number | string | boolean | null> = {};
    if (code === 'us.401k' || code === 'us.roth_401k') params.percent = g.pick([0, 3, 6, '10', true]);
    if (code === 'us.401k_employer_match') Object.assign(params, { match_percent: g.pick([50, 100, null]), match_limit_percent: g.pick([6, '4', null]) });
    return { code, ...(g.bool(0.3) ? { label: g.pick(['Custom', null]) } : {}), amountCents: g.maybe(g.int(0, 80_000), 0.5), params };
  });
  const inputs = Array.from({ length: g.int(0, 6) }, () => ({
    code: g.pick(US_CODES),
    label: g.maybe('Line', 0.3),
    quantity: g.maybe(g.pick([g.int(0, 60), g.money(12)]), 0.85),
    rate: g.maybe(g.pick([g.money(60), 150, 200]), 0.3),
    amountCents: g.maybe(g.int(-10_000, 400_000), 0.3),
    workDate: g.pick([null, period.start, period.end, `${period.start.slice(0, 8)}${String(g.int(1, 28)).padStart(2, '0')}`]),
  }));
  const ytd: Record<string, number> = {};
  if (g.bool(0.6)) {
    for (const key of ['us.ss_wages', 'us.medicare_wages', 'us.futa_wages', 'us.401k', 'us.supplemental_wages', 'us.fit_regular', 'us.dependent_care', 'us.ss_employee', 'us.medicare_employee']) {
      if (g.bool(0.5)) ytd[key] = g.int(0, 20_000_000);
    }
    if (state && g.bool(0.5)) ytd[`us.state.${state}.sui_wages`] = g.int(0, 5_000_000);
    if (g.bool(0.2)) ytd[`us.ot_carry.${period.start}.d1`] = g.int(100, 1200);
  }
  const certificates: Record<string, ReturnType<typeof certificate>> = {};
  if (state && g.bool(0.7)) certificates[state] = randomCertificate(g, state);
  const sui: Record<string, number | null> = {};
  if (state && g.bool(0.8)) sui[state] = g.pick([2, 3.4, 5.4, 2.42, 0.94, null, 6.1]);
  const extra: Record<string, Record<string, number>> = {};
  if (state && g.bool(0.4)) {
    extra[state] = Object.fromEntries((stateModule(state)?.employerRateCodes ?? []).filter(() => g.bool(0.6)).map((c) => [c.code, g.pick([0, 0.1, 0.5, 1.2])]));
  }
  return {
    country: 'US',
    period,
    employee: {
      dateOfBirth: g.maybe(g.date(1950, 2006), 0.9),
      startDate: g.pick([null, g.date(2020, 2025), period.start, `${period.start.slice(0, 8)}05`]),
      endDate: g.pick([null, null, null, period.end, g.date(2026, 2027)]),
    },
    compensation,
    components,
    inputs,
    ytd,
    employer: { workweekStartDay: g.int(0, 6), suiRatePercent: sui, extraRates: extra, employeeCountEstimate: g.maybe(g.pick([3, 12, 30, 80]), 0.8) },
    us: {
      workState: state === null ? null : g.bool(0.1) ? state.toLowerCase() : state,
      residenceState: g.maybe(g.pick([state ?? 'NY', 'NJ', 'pa']), 0.3),
      flsaStatus: g.pick(['nonexempt', 'nonexempt', 'exempt'] as const),
      w4: randomW4(g),
      stateCertificates: certificates,
      exemptFica: g.bool(0.05),
      exemptFuta: g.bool(0.05),
      ...(g.bool(0.2) ? { exemptSui: g.bool(0.5) } : {}),
      statutoryEmployee: g.bool(0.04),
      retirementPlan: g.bool(0.3),
    },
  };
}

{
  const g = new Gen(6);
  const cases: unknown[] = [];
  for (let i = 0; i < 1500; i += 1) {
    const input = randomUsInput(g);
    cases.push({ input, output: attempt(() => calculatePayslip(input)) });
  }
  // A run of weekly or biweekly payslips, YTD carried (wage bases, overtime carry).
  for (let e = 0; e < 12; e += 1) {
    const base = randomUsInput(g);
    const frequency = g.pick(['weekly', 'biweekly'] as const);
    let ytd: Record<string, number> = {};
    let start = '2026-01-04';
    for (let r = 1; r <= (frequency === 'weekly' ? 20 : 12); r += 1) {
      const period = usPeriod(g, frequency, start, r);
      const input: UsPayslipInput = {
        ...base,
        period,
        ytd,
        inputs: base.inputs.map((i) => (i.code === 'hours.regular' || i.code === 'hours.overtime' ? { ...i, workDate: g.pick([period.start, period.end, null]) } : i)),
      };
      const output = attempt(() => calculatePayslip(input));
      cases.push({ input, output });
      if ('ytd' in output) ytd = output.ytd;
      start = shiftDate(start, frequency === 'weekly' ? 7 : 14);
    }
  }
  write('tests/fixtures/us-payslips.json', cases);

  const states: unknown[] = [];
  for (let i = 0; i < 1500; i += 1) {
    const state = g.pick(SUPPORTED_STATES);
    const input = stateInput(state, {
      taxYear: g.bool(0.97) ? 2026 : 2027,
      payDate: g.pick(['2026-03-13', '2026-05-15', '2026-07-03', '2026-12-31']),
      periodsPerYear: g.pick([52, 26, 24, 12, 4, 2, 1, 53, 13]),
      regularWagesCents: g.pick([0, g.int(0, 2_000_000), g.int(0, 30_000_000)]),
      supplementalWagesCents: g.pick([0, 0, g.int(0, 5_000_000)]),
      pretax: {
        retirement401kCents: g.pick([0, g.int(0, 200_000)]),
        section125Cents: g.pick([0, g.int(0, 50_000)]),
        hsaCents: g.pick([0, g.int(0, 30_000)]),
        dependentCareCents: g.pick([0, g.int(0, 50_000)]),
      },
      certificate: g.bool(0.7) ? randomCertificate(g, state) : null,
      federalW4: randomW4(g),
      suiRatePercent: g.pick([2, 3.4, 5.4, 2.42, 0.94, null, 4.3]),
      extraRates: Object.fromEntries((stateModule(state)?.employerRateCodes ?? []).filter(() => g.bool(0.4)).map((c) => [c.code, g.pick([0, 0.1, 0.5, 1.2])])),
      employeeCountEstimate: g.maybe(g.pick([3, 12, 30, 80]), 0.8),
      ytd: g.bool(0.5)
        ? { [`us.state.${state}.sui_wages`]: g.int(0, 5_000_000), [`us.state.${state}.fica_deduction`]: g.int(0, 200_000), [`us.state.${state}.ny_pfl_employee`]: g.int(0, 41_191) }
        : {},
      residenceState: g.maybe(g.pick([state, 'NJ', 'ca']), 0.3),
      exemptFromSui: g.bool(0.08),
      ...(g.bool(0.5) ? { ficaEmployeeCents: g.int(0, 100_000) } : {}),
    });
    states.push({ input, result: stateModule(state)!.calculate(input) });
  }
  write('tests/fixtures/us-states.json', states);

  const rules = federalRules(2026)!;
  const withholding: unknown[] = [];
  for (let i = 0; i < 400; i += 1) {
    const w4 = randomW4(g) ?? SINGLE_W4;
    const periods = g.pick([52, 26, 24, 12, 53, 27, 4, 1, 365]);
    const wages = g.int(-1000, 3_000_000);
    const args = {
      supplementalCents: g.int(0, 2_000_000),
      ytdSupplementalCents: g.pick([0, g.int(0, 120_000_000)]),
      regularWagesCents: wages,
      nraAdditionCents: nraAdditionCents(rules, w4, periods),
      periodsPerYear: periods,
      regularWithheldThisYearCents: g.pick([0, 0, g.int(1, 100_000)]),
    };
    withholding.push({ w4, periods, wages, worksheet: worksheet1A(rules, w4, wages, periods), args, supplemental: supplementalWithholding({ rules, w4, ...args }) });
  }
  const overtime: unknown[] = [];
  for (let i = 0; i < 300; i += 1) {
    const periodStart = g.date(2026, 2026);
    const input = {
      entries: Array.from({ length: g.int(0, 14) }, () => ({
        date: shiftDate(periodStart, g.int(-3, 17)),
        hours: g.pick([g.int(0, 14), g.money(12), -2]),
        rateCents: g.pick([1500, 2250.5, 4000]),
        multiplier: g.pick([null, null, 1.5, 2]),
      })),
      periodStart,
      periodEnd: shiftDate(periodStart, g.pick([6, 13, 15])),
      workweekStartDay: g.int(0, 6),
      california: g.bool(0.3),
      salariedRegularRateCents: g.maybe(g.pick([2500, 3846.15]), 0.3),
      ytd: g.bool(0.4)
        ? { [`us.ot_carry.${periodStart}.d2`]: g.int(100, 1000), [`us.ot_carry.${periodStart}.pay`]: g.int(1000, 100_000), [`us.ot_carry.${periodStart}.premium`]: g.int(0, 5000), 'us.ot_carry.bad.d1': 5 }
        : {},
    };
    overtime.push({ input, result: computeOvertime(input) });
  }
  const dates = [2025, 2026, 2027, 2028, 2029].map((year) => ({
    year,
    holidays: legalHolidays(year),
    due: ([1, 2, 3, 4] as const).map((q) => quarterlyReturnDueDate(year, q)),
    annual: annualReturnDueDate(year),
    after: businessDaysAfter(`${year}-12-22`, 3),
  }));
  write('tests/fixtures/us-federal.json', { withholding, overtime, dates });
}

if (check) {
  if (stale.length) {
    console.error(`Stale payroll fixtures (run \`pnpm rust:payroll-fixtures\`):\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  console.log('Payroll fixtures are up to date.');
} else {
  console.log(`Wrote the payroll tables and vectors to ${path.relative(repo, crateDir)}.`);
}
