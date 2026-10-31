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
import type { NlFilingData, NlPayslipInput, PayFrequency } from '../packages/domains/payroll/src/types';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crateDir = path.join(repo, 'rust', 'crates', 'payroll-domain');
const check = process.argv.includes('--check');
const stale: string[] = [];

function write(relative: string, value: unknown) {
  const file = path.join(crateDir, relative);
  const text = `${JSON.stringify(value, null, 1)}\n`;
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

if (check) {
  if (stale.length) {
    console.error(`Stale payroll fixtures (run \`pnpm rust:payroll-fixtures\`):\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  console.log('Payroll fixtures are up to date.');
} else {
  console.log(`Wrote the payroll tables and vectors to ${path.relative(repo, crateDir)}.`);
}
