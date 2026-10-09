import { describe, expect, it } from 'vitest';
import type { ComponentInput, PayslipResult, RunInput, UsPayslipInput, UsW4Input } from '../types';
import { percentOf } from '../money';
import { calculateUsPayslipWith, type UsEngineDeps } from './calculate';
import type { StateCalcInput, StateCalcResult, StateModule } from './states/types';

/**
 * A stand-in state module so these tests do not depend on the real state
 * modules: 3% income tax on wages after every pre-tax item, 2% SUI (or the
 * employer's rate) on the first $10,000, and a paid-leave program of 0.5%
 * employee / 0.25% employer.
 */
function fakeState(code: string): StateModule {
  return {
    code,
    name: `Test ${code}`,
    hasIncomeTax: true,
    supportedYears: [2026],
    certificate: null,
    calculate(input: StateCalcInput): StateCalcResult {
      const p = input.pretax;
      const gross = input.regularWagesCents + input.supplementalWagesCents;
      const stateWages = gross - p.retirement401kCents - p.section125Cents - p.hsaCents - p.dependentCareCents;
      const suiGross = gross - p.section125Cents - p.hsaCents - p.dependentCareCents;
      const key = `us.state.${code}.sui_wages`;
      const before = input.ytd[key] ?? 0;
      const taxable = input.exemptFromSui ? 0 : Math.max(0, Math.min(suiGross, 1_000_000 - before));
      return {
        stateWagesCents: stateWages,
        incomeTaxCents: percentOf(stateWages, 3),
        sui: { taxableWagesCents: taxable, grossWagesCents: suiGross, employerCents: percentOf(taxable, input.suiRatePercent ?? 2), employeeCents: 0 },
        programs: [{ code: 'zz_pfl', labelKey: 'us.zz_pfl', wagesCents: suiGross, employeeCents: percentOf(suiGross, 0.5), employerCents: percentOf(suiGross, 0.25) }],
        ytdUpdates: { [key]: before + taxable },
        issues: [],
        ruleSet: `us-${code.toLowerCase()}-2026.test`,
      };
    },
  };
}

const deps: UsEngineDeps = { stateModule: (code) => (code === 'ZZ' || code === 'CA' ? fakeState(code) : undefined) };

const SINGLE: UsW4Input = {
  formYear: 2026,
  filingStatus: 'single',
  multipleJobs: false,
  dependentsAmount: 0,
  otherIncome: 0,
  deductions: 0,
  extraWithholding: 0,
  exempt: false,
  allowances: null,
  nonresidentAlien: false,
};

type Overrides = {
  period?: Partial<UsPayslipInput['period']>;
  employee?: Partial<UsPayslipInput['employee']>;
  compensation?: UsPayslipInput['compensation'];
  components?: ComponentInput[];
  inputs?: RunInput[];
  ytd?: Record<string, number>;
  employer?: Partial<UsPayslipInput['employer']>;
  us?: Partial<UsPayslipInput['us']>;
};

function payslip(o: Overrides = {}): UsPayslipInput {
  return {
    country: 'US',
    period: { start: '2026-03-01', end: '2026-03-31', payDate: '2026-03-31', frequency: 'monthly', taxYear: 2026, periodNumber: 3, periodsPerYear: 12, ...o.period },
    employee: { dateOfBirth: '1990-05-01', startDate: '2024-01-01', endDate: null, ...o.employee },
    compensation: o.compensation === undefined ? { payType: 'salary', amount: 72_000, period: 'year', hoursPerWeek: 40 } : o.compensation,
    components: o.components ?? [],
    inputs: o.inputs ?? [],
    ytd: o.ytd ?? {},
    employer: { workweekStartDay: 0, suiRatePercent: { ZZ: 2, CA: 2 }, extraRates: {}, employeeCountEstimate: 10, ...o.employer },
    us: {
      workState: 'ZZ',
      residenceState: 'ZZ',
      flsaStatus: 'exempt',
      w4: SINGLE,
      stateCertificates: {},
      exemptFica: false,
      exemptFuta: false,
      statutoryEmployee: false,
      retirementPlan: false,
      ...o.us,
    },
  };
}

const run = (o: Overrides = {}): PayslipResult => calculateUsPayslipWith(payslip(o), deps);
const component = (code: string, amountCents: number | null, params: ComponentInput['params'] = {}): ComponentInput => ({ code, amountCents, params });
const runInput = (code: string, fields: Partial<RunInput>): RunInput => ({ code, quantity: null, rate: null, amountCents: null, workDate: null, ...fields });
const codes = (r: PayslipResult, severity?: 'error' | 'warning') => r.issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);
const line = (r: PayslipResult, code: string, section?: string) => r.lines.find((l) => l.code === code && (!section || l.section === section));

describe('calculateUsPayslip — salaried employee, monthly', () => {
  it('computes gross to net for $72,000 a year with no W-4 on file (Single, no adjustments)', () => {
    const r = run({ us: { w4: null } });
    expect(r.grossCents).toBe(600_000);
    // (72,000 − 8,600 − 57,900) × 22% + 5,800 = 7,010 ÷ 12 = 584.1667.
    expect(line(r, 'us.fit')?.amountCents).toBe(-58_417);
    expect(line(r, 'us.ss')?.amountCents).toBe(-37_200);
    expect(line(r, 'us.medicare')?.amountCents).toBe(-8_700);
    expect(line(r, 'us.futa')?.amountCents).toBe(3_600);
    expect(line(r, 'us.state_income_tax')?.amountCents).toBe(-18_000);
    expect(line(r, 'us.sui_employer')?.amountCents).toBe(12_000);
    expect(r.employeeTaxesCents).toBe(58_417 + 37_200 + 8_700 + 18_000 + 3_000);
    expect(r.netCents).toBe(600_000 - 125_317);
    expect(r.employerTaxesCents).toBe(37_200 + 8_700 + 3_600 + 12_000 + 1_500);
    expect(r.employerCostCents).toBe(600_000 + 63_000);
    expect(codes(r)).toEqual(['w4_missing_default_single']);
    expect(r.ruleSet).toBe('us-2026.1/us-zz-2026.test');
    expect(r.filingData).toMatchObject({
      kind: 'us',
      federal: { fitWages: 600_000, federalIncomeTax: 58_417, ssWages: 600_000, medicareWages: 600_000, futaWages: 600_000, futaTax: 3_600, futaState: 'ZZ' },
      states: { ZZ: { stateWages: 600_000, stateIncomeTax: 18_000, suiWages: 600_000, suiEmployerTax: 12_000, programs: { zz_pfl: { wages: 600_000, employee: 3_000, employer: 1_500 } } } },
    });
  });

  it('is deterministic', () => {
    expect(run()).toEqual(run());
  });

  it('prorates a partial first period by weekdays employed (12 of 22 in March 2026)', () => {
    const r = run({ employee: { startDate: '2026-03-16' } });
    expect(r.grossCents).toBe(327_273);
    expect(r.issues).toContainEqual({ severity: 'warning', code: 'partial_period', params: { workedDays: 12, periodDays: 22 } });
  });

  it('pays a weekly salary as is on a weekly schedule and spreads an annual salary over 53 paydays', () => {
    const weekly = run({
      compensation: { payType: 'salary', amount: 1_250, period: 'week', hoursPerWeek: 40 },
      period: { start: '2026-03-01', end: '2026-03-07', payDate: '2026-03-06', frequency: 'weekly', periodsPerYear: 53 },
    });
    expect(weekly.grossCents).toBe(125_000);
    const annual = run({ period: { start: '2026-03-01', end: '2026-03-07', payDate: '2026-03-06', frequency: 'weekly', periodsPerYear: 53 } });
    expect(annual.grossCents).toBe(Math.round(7_200_000 / 53));
  });

  it('deducts unpaid leave from the salary at the hourly equivalent', () => {
    const r = run({ inputs: [runInput('hours.unpaid_leave', { quantity: 8 })] });
    // 72,000 ÷ 2,080 = 34.615… × 8 = 276.92.
    expect(line(r, 'hours.unpaid_leave')?.amountCents).toBe(-27_692);
    expect(r.grossCents).toBe(600_000 - 27_692);
  });
});

describe('pre-tax deductions and employer benefits', () => {
  it('401(k) reduces only income tax wages; Section 125 and HSA reduce FIT, FICA and FUTA', () => {
    const r = run({
      components: [
        component('us.401k', null, { percent: 10 }),
        component('us.section125_health', 20_000),
        component('us.hsa', 10_000),
        component('us.401k_employer_match', null, { match_percent: 50, match_limit_percent: 6 }),
        component('us.employer_health', 40_000),
      ],
    });
    const f = r.filingData.kind === 'us' ? r.filingData.federal : null;
    expect(f).toMatchObject({ fitWages: 510_000, ssWages: 570_000, medicareWages: 570_000, futaWages: 570_000, futaExemptWages: 30_000 });
    expect(f?.box12).toEqual({ D: 60_000, W: 10_000, DD: 60_000 });
    // FIT on 5,100: (61,200 − 8,600 − 19,900) × 12% + 1,240 = 5,164 ÷ 12.
    expect(line(r, 'us.fit')?.amountCents).toBe(-43_033);
    expect(line(r, 'us.ss')?.amountCents).toBe(-35_340);
    // Match: 50% of the deferral up to 6% of pay (36,000 of 60,000).
    expect(line(r, 'us.401k_employer_match')?.amountCents).toBe(18_000);
    expect(r.employerCostCents).toBe(600_000 + r.employerTaxesCents + 18_000 + 40_000);
    expect(r.employeeDeductionsCents).toBe(60_000 + 20_000 + 10_000);
    expect(r.filingData.kind === 'us' && r.filingData.states.ZZ!.stateWages).toBe(510_000);
  });

  it('caps elective deferrals at the §402(g) limit for the age on 31 December (pre-tax first, then Roth)', () => {
    const deferral = [component('us.401k', 100_000), component('us.roth_401k', 100_000)];
    const young = run({ components: deferral, ytd: { 'us.401k': 2_400_000 } });
    expect(line(young, 'us.401k')?.amountCents).toBe(-50_000);
    expect(line(young, 'us.roth_401k')).toBeUndefined();
    // Age 52: $24,500 + $8,000.
    const fifty = run({ components: deferral, employee: { dateOfBirth: '1974-06-01' }, ytd: { 'us.401k': 2_400_000, 'us.roth_401k': 700_000 } });
    expect(line(fifty, 'us.401k')?.amountCents).toBe(-100_000);
    expect(line(fifty, 'us.roth_401k')?.amountCents).toBe(-50_000);
    // Age 61: $24,500 + $11,250.
    const sixty = run({ components: deferral, employee: { dateOfBirth: '1965-06-01' }, ytd: { 'us.401k': 3_500_000 } });
    expect(line(sixty, 'us.401k')?.amountCents).toBe(-75_000);
    expect(sixty.ytd['us.401k']).toBe(3_575_000);
  });

  it('excludes dependent care up to $7,500 a year; the excess is wages (box 10 shows all of it)', () => {
    const r = run({ components: [component('us.dependent_care', 100_000)], ytd: { 'us.dependent_care': 700_000 } });
    const f = r.filingData.kind === 'us' ? r.filingData.federal : null;
    expect(f).toMatchObject({ fitWages: 550_000, ssWages: 550_000, dependentCare: 100_000 });
  });
});

describe('FICA and FUTA with year-to-date', () => {
  const highEarner: Overrides = { compensation: { payType: 'salary', amount: 240_000, period: 'year', hoursPerWeek: 40 } };

  it('stops Social Security at the $184,500 wage base and warns when it is reached', () => {
    const r = run({ ...highEarner, ytd: { 'us.ss_wages': 18_200_000, 'us.ss_employee': 1_128_400, 'us.ss_employer': 1_128_400 } });
    expect(line(r, 'us.ss')?.amountCents).toBe(-15_500);
    expect(r.ytd['us.ss_wages']).toBe(18_450_000);
    expect(r.ytd['us.ss_employee']).toBe(1_143_900);
    expect(codes(r, 'warning')).toContain('ss_wage_base_reached');
    const after = run({ ...highEarner, ytd: r.ytd });
    expect(line(after, 'us.ss')).toBeUndefined();
    expect(codes(after, 'warning')).not.toContain('ss_wage_base_reached');
  });

  it('starts Additional Medicare in the period wages pass $200,000, only on the excess', () => {
    const r = run({ ...highEarner, ytd: { 'us.medicare_wages': 19_500_000 } });
    expect(line(r, 'us.addl_medicare')?.amountCents).toBe(-13_500);
    expect(line(r, 'us.medicare')?.amountCents).toBe(-29_000);
    expect(r.filingData.kind === 'us' && r.filingData.federal.additionalMedicareWages).toBe(1_500_000);
    expect(codes(r, 'warning')).toContain('additional_medicare_started');
    const next = run({ ...highEarner, ytd: r.ytd });
    expect(line(next, 'us.addl_medicare')?.amountCents).toBe(-18_000);
    expect(codes(next, 'warning')).not.toContain('additional_medicare_started');
  });

  it('stops FUTA at $7,000', () => {
    const r = run({ ytd: { 'us.futa_wages': 650_000 } });
    expect(line(r, 'us.futa')?.amountCents).toBe(300);
    expect(r.filingData.kind === 'us' && r.filingData.federal.futaWages).toBe(50_000);
    expect(line(run({ ytd: { 'us.futa_wages': 700_000 } }), 'us.futa')).toBeUndefined();
  });

  it('warns that California’s 2026 FUTA credit reduction is not final yet', () => {
    const r = run({ us: { workState: 'CA' } });
    expect(r.issues).toContainEqual({ severity: 'warning', code: 'provisional_rules', params: { item: 'futa_credit_reduction', state: 'CA' } });
  });

  it('respects FICA and FUTA exemptions', () => {
    const r = run({ us: { exemptFica: true, exemptFuta: true } });
    expect(line(r, 'us.ss')).toBeUndefined();
    expect(line(r, 'us.medicare')).toBeUndefined();
    expect(line(r, 'us.futa')).toBeUndefined();
    expect(r.filingData.kind === 'us' && r.filingData.federal).toMatchObject({ ssWages: 0, futaGrossWages: 600_000, futaExemptWages: 600_000 });
    // SUI exemption follows FUTA unless set separately.
    expect(r.filingData.kind === 'us' && r.filingData.states.ZZ!.suiWages).toBe(0);
  });
});

describe('federal income tax variants', () => {
  it('withholds 22% on a bonus paid with regular wages', () => {
    const r = run({ inputs: [runInput('bonus', { amountCents: 500_000 })] });
    expect(line(r, 'us.fit')?.amountCents).toBe(-(58_417 + 110_000));
    expect(r.filingData.kind === 'us' && r.filingData.federal.supplementalWages).toBe(500_000);
    expect(r.ytd['us.supplemental_wages']).toBe(500_000);
  });

  it('withholds nothing for a W-4 claiming exemption, and nothing for a statutory employee', () => {
    expect(line(run({ us: { w4: { ...SINGLE, exempt: true } } }), 'us.fit')).toBeUndefined();
    const stat = run({ us: { statutoryEmployee: true } });
    expect(line(stat, 'us.fit')).toBeUndefined();
    expect(line(stat, 'us.ss')?.amountCents).toBe(-37_200);
    expect(stat.filingData.kind === 'us' && stat.filingData.federal).toMatchObject({ fitWages: 600_000, statutoryEmployee: true });
  });
});

describe('hourly employees, tips and overtime', () => {
  const hourly: Overrides = { compensation: { payType: 'hourly', amount: 20, period: 'hour', hoursPerWeek: 40 }, us: { flsaStatus: 'nonexempt' } };
  const day = (d: number) => `2026-03-${String(d).padStart(2, '0')}`;

  it('pays FLSA overtime per workweek across a biweekly period (45 h and 38 h)', () => {
    const inputs = [
      ...[2, 3, 4, 5, 6].map((d) => runInput('hours.regular', { quantity: 9, workDate: day(d) })),
      ...[9, 10, 11, 12].map((d) => runInput('hours.regular', { quantity: 9.5, workDate: day(d) })),
    ];
    const r = run({ ...hourly, inputs, period: { start: '2026-03-01', end: '2026-03-14', payDate: '2026-03-20', frequency: 'biweekly', periodsPerYear: 26 } });
    expect(line(r, 'hours.regular')).toMatchObject({ quantity: 83, rate: 20, amountCents: 166_000 });
    expect(r.lines.find((l) => l.labelKey === 'us.overtime_premium')).toMatchObject({ quantity: 5, rate: 10, amountCents: 5_000 });
    expect(r.grossCents).toBe(171_000);
    expect(r.filingData).toMatchObject({ qualifiedOvertimePremium: 5_000, hoursWorked: 83, federal: { box12: { TT: 5_000 } } });
    expect(line(r, 'us.qualified_overtime', 'info')?.amountCents).toBe(5_000);
  });

  it('applies California daily overtime for a CA work state', () => {
    const inputs = [
      runInput('hours.regular', { quantity: 10, workDate: day(2) }),
      runInput('hours.regular', { quantity: 13, workDate: day(3) }),
      ...[4, 5, 6].map((d) => runInput('hours.regular', { quantity: 8, workDate: day(d) })),
    ];
    const r = run({
      ...hourly,
      us: { flsaStatus: 'nonexempt', workState: 'CA' },
      inputs,
      period: { start: '2026-03-01', end: '2026-03-07', payDate: '2026-03-13', frequency: 'weekly', periodsPerYear: 52 },
    });
    expect(r.grossCents).toBe(94_000 + 6_000 + 2_000);
    expect(r.lines.find((l) => l.labelKey === 'us.double_time_premium')).toMatchObject({ quantity: 1, amountCents: 2_000, jurisdiction: 'CA' });
    expect(r.filingData.kind === 'us' && r.filingData.qualifiedOvertimePremium).toBe(7_000);
  });

  it('treats reported cash tips as wages the employee already has (box 7, code TP)', () => {
    const r = run({ ...hourly, inputs: [runInput('hours.regular', { quantity: 30 }), runInput('us.tips_cash', { amountCents: 50_000 })] });
    expect(r.grossCents).toBe(110_000);
    expect(r.filingData.kind === 'us' && r.filingData.federal).toMatchObject({ ssWages: 60_000, ssTips: 50_000, medicareWages: 110_000, fitWages: 110_000, box12: { TP: 50_000 } });
    expect(line(r, 'us.tips_cash', 'deduction')?.amountCents).toBe(-50_000);
    // 30 h × $20 + $500 tips: no FIT (13,200 − 8,600 < 7,500); 1,100 − SS 68.20 − Medicare 15.95 − state 33.00 − program 5.50 − tips 500.
    expect(line(r, 'us.fit')).toBeUndefined();
    expect(r.netCents).toBe(47_735);
    expect(r.employerCostCents).toBe(60_000 + r.employerTaxesCents);
  });

  it('pays manual overtime at its multiplier', () => {
    const r = run({ ...hourly, us: { flsaStatus: 'exempt' }, inputs: [runInput('hours.regular', { quantity: 40 }), runInput('hours.overtime', { quantity: 4, rate: 200 })] });
    expect(r.lines.find((l) => l.labelKey === 'us.overtime_manual')).toMatchObject({ quantity: 4, rate: 40, amountCents: 16_000 });
  });

  it('warns when an hourly employee has no hours', () => {
    expect(codes(run(hourly), 'warning')).toContain('no_hours');
  });
});

describe('blocking issues', () => {
  it('reports a missing work state and an unsupported state', () => {
    expect(codes(run({ us: { workState: null } }), 'error')).toEqual(['missing_work_state']);
    const r = run({ us: { workState: 'OH' } });
    expect(r.issues).toContainEqual({ severity: 'error', code: 'unsupported_state', params: { state: 'OH' } });
  });

  it('reports negative net pay', () => {
    expect(codes(run({ inputs: [runInput('deduction.net', { amountCents: 1_000_000 })] }), 'error')).toEqual(['negative_net_pay']);
  });

  it('reports an unsupported tax year and frequency instead of guessing', () => {
    const y = run({ period: { taxYear: 2027, payDate: '2027-01-29' } });
    expect(y.issues).toEqual([{ severity: 'error', code: 'unsupported_tax_year', params: { year: 2027 } }]);
    expect(y.ruleSet).toBe('us-none');
    expect(codes(run({ period: { frequency: 'four_weekly', periodsPerYear: 13 } }), 'error')).toEqual(['unsupported_frequency']);
  });

  it('rejects components of another country', () => {
    expect(codes(run({ components: [component('nl.company_car', null)] }), 'error')).toEqual(['unsupported_component']);
  });
});

describe('accumulators and reimbursements', () => {
  it('adds this payslip to the year-to-date record and keeps unknown keys', () => {
    const r = run({ ytd: { 'us.gross': 1_200_000, 'us.fit': 116_834, 'custom.key': 5 } });
    expect(r.ytd['us.gross']).toBe(1_800_000);
    expect(r.ytd['us.fit']).toBe(116_834 + 58_417);
    expect(r.ytd['custom.key']).toBe(5);
    expect(r.ytd['us.state.ZZ.sui_wages']).toBe(600_000);
  });

  it('adds reimbursements and advances to net pay without taxing them', () => {
    const r = run({ inputs: [runInput('reimbursement', { amountCents: 12_345 }), runInput('advance', { amountCents: 10_000 })] });
    expect(r.reimbursementsCents).toBe(22_345);
    expect(r.netCents).toBe(600_000 - 125_317 + 22_345 + 3_000 - 3_000);
    expect(r.taxableWageCents).toBe(600_000);
  });
});

describe('labels', () => {
  it('every federal line label has English and Dutch text', async () => {
    const { US_PAYSLIP_LABELS, usPayslipLabels } = await import('./labels');
    const r = run({
      compensation: { payType: 'hourly', amount: 20, period: 'hour', hoursPerWeek: 40 },
      us: { flsaStatus: 'nonexempt', workState: 'CA' },
      period: { start: '2026-03-01', end: '2026-03-07', payDate: '2026-03-13', frequency: 'weekly', periodsPerYear: 52 },
      components: [component('us.401k', 1_000), component('us.roth_401k', 1_000), component('us.section125_health', 1_000), component('us.hsa', 1_000), component('us.dependent_care', 1_000), component('us.401k_employer_match', 500), component('us.employer_health', 5_000)],
      inputs: [
        runInput('hours.regular', { quantity: 13, workDate: '2026-03-02' }),
        ...['2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'].map((d) => runInput('hours.regular', { quantity: 9, workDate: d })),
        runInput('hours.overtime', { quantity: 2, rate: 200 }),
        runInput('hours.paid_leave', { quantity: 4 }),
        runInput('bonus', { amountCents: 10_000 }),
        runInput('commission', { amountCents: 10_000 }),
        runInput('allowance.taxable', { amountCents: 1_000 }),
        runInput('us.tips_cash', { amountCents: 2_000 }),
        runInput('reimbursement', { amountCents: 1_000 }),
        runInput('advance', { amountCents: 1_000 }),
        runInput('deduction.net', { amountCents: 500 }),
      ],
    });
    // This run uses the fake state module; state lines are checked against the real modules below.
    const federal = r.lines.filter((l) => l.jurisdiction !== 'CA');
    for (const l of federal) {
      expect(US_PAYSLIP_LABELS[l.labelKey], l.labelKey).toBeDefined();
      expect(US_PAYSLIP_LABELS[l.labelKey]!.en.length).toBeGreaterThan(0);
      expect(US_PAYSLIP_LABELS[l.labelKey]!.nl.length).toBeGreaterThan(0);
    }
    expect(usPayslipLabels()['us.salary']).toEqual(US_PAYSLIP_LABELS['us.salary']);
  });

  it('state lines from the real state modules carry the state-named labels', async () => {
    const { usPayslipLabels } = await import('./labels');
    const { calculateUsPayslip } = await import('./calculate');
    const labels = usPayslipLabels();
    for (const workState of ['CA', 'NY', 'NJ', 'WA']) {
      const r = calculateUsPayslip(payslip({ us: { flsaStatus: 'exempt', workState } }));
      const stateLines = r.lines.filter((l) => l.jurisdiction === workState);
      expect(stateLines.length, workState).toBeGreaterThan(0);
      for (const l of stateLines) {
        expect(labels[l.labelKey], l.labelKey).toBeDefined();
        expect(labels[l.labelKey]!.en.length).toBeGreaterThan(0);
        expect(labels[l.labelKey]!.nl.length).toBeGreaterThan(0);
      }
    }
    expect(labels['us.state_income_tax.CA']?.en).toMatch(/California/);
  });
});
