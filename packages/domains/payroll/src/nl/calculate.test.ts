/**
 * Gross-to-net scenarios. Expected wage-tax amounts are rows of the official
 * 2026 white monthly/daily tables (see fixtures/white-tables.ts for the
 * source); premiums are worked out by hand from the 2026 rates annex.
 */
import { describe, expect, it } from 'vitest';
import type { NlPayslipInput, PayslipLine } from '../types';
import { calculateNlPayslip } from './calculate';
import { NL_PAYSLIP_LABELS } from './labels';
import { NL_YTD_KEYS, nlAnnualWageForSpecialRewards, nlHolidayAllowanceBalance } from './ytd';

type DeepPartialInput = Partial<Omit<NlPayslipInput, 'employer' | 'nl' | 'employee' | 'period'>> & {
  employer?: Partial<NlPayslipInput['employer']>;
  nl?: Partial<NlPayslipInput['nl']>;
  employee?: Partial<NlPayslipInput['employee']>;
  period?: Partial<NlPayslipInput['period']>;
};

function month(m: number, year = 2026) {
  const mm = String(m).padStart(2, '0');
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${last}`, payDate: `${year}-${mm}-25`, frequency: 'monthly' as const, taxYear: year, periodNumber: m, periodsPerYear: 12 };
}

function input(o: DeepPartialInput = {}): NlPayslipInput {
  return {
    country: 'NL',
    period: { ...month(3), ...o.period },
    employee: { dateOfBirth: '1990-05-10', startDate: '2024-01-01', endDate: null, ...o.employee },
    compensation: o.compensation === undefined ? { payType: 'salary', amount: 4000, period: 'month', hoursPerWeek: 40 } : o.compensation,
    components: o.components ?? [],
    inputs: o.inputs ?? [],
    ytd: o.ytd ?? { [NL_YTD_KEYS.loonLbPh]: 1 },
    employer: { whkRatePercent: null, sectorCode: 43, aofSmallEmployer: true, holidayAllowancePercent: 8, holidayAllowancePayoutMonth: 5, ...o.employer },
    nl: {
      applyLoonheffingskorting: true,
      anonymous: false,
      isDga: false,
      insuredWw: true,
      insuredZw: true,
      insuredWao: true,
      writtenContract: true,
      indefiniteContract: true,
      onCall: false,
      contractHoursPerWeek: 40,
      expatRulingPercent: null,
      previousYearAnnualWageCents: 5_184_000,
      ...o.nl,
    },
  };
}

const line = (lines: PayslipLine[], code: string) => lines.find((l) => l.code === code);
const amount = (lines: PayslipLine[], code: string) => line(lines, code)?.amountCents ?? 0;
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('standard employee, March 2026', () => {
  const r = calculateNlPayslip(input());

  it('withholds the white monthly table amount and records the labour credit', () => {
    // Table row 3.996,00 (€ 4.000 → L 47.952): 818,67 with loonheffingskorting, arbeidskorting 461,00.
    expect(amount(r.lines, 'nl.wage_tax')).toBe(-81_867);
    expect(amount(r.lines, 'nl.labour_credit')).toBe(46_100);
    expect(r.filingData.kind === 'nl' && r.filingData.amounts.labourCredit).toBe(46_100);
  });

  it('computes the employer premiums on the capped premium wage', () => {
    // AWf low 2,74%, Aof low 6,27%, Wko 0,50%, Whk sector 43 (Zakelijke dienstverlening I) 1,16%, Zvw 6,10%.
    expect(amount(r.lines, 'nl.awf_premium')).toBe(10_960);
    expect(amount(r.lines, 'nl.aof_premium')).toBe(25_080);
    expect(amount(r.lines, 'nl.wko_premium')).toBe(2_000);
    expect(amount(r.lines, 'nl.whk_premium')).toBe(4_640);
    expect(amount(r.lines, 'nl.zvw_employer_levy')).toBe(24_400);
    expect(r.employerTaxesCents).toBe(67_080);
    expect(r.employerCostCents).toBe(400_000 + 67_080);
  });

  it('nets out', () => {
    expect(r.grossCents).toBe(400_000);
    expect(r.taxableWageCents).toBe(400_000);
    expect(r.netCents).toBe(318_133);
    expect(r.issues).toEqual([]);
    expect(r.ruleSet).toBe('nl-2026.1');
  });

  it('fills the filing data', () => {
    expect(r.filingData).toMatchObject({
      kind: 'nl',
      tableCode: '012',
      awfRate: 'low',
      aofRate: 'low',
      zvw: 'employer_levy',
      hoursPaid: 173, // 40 h × 52 / 12 = 173,33
      svDays: 22,
      incidentalIncomeReduction: null,
      amounts: { loonLbPh: 400_000, loonSv: 400_000, premieloonAwf: 400_000, loonZvw: 400_000, holidayAllowanceAccrued: 32_000, cashWage: 400_000, contractWage: 400_000 },
    });
  });

  it('labels every line in both languages', () => {
    for (const l of r.lines) {
      expect(NL_PAYSLIP_LABELS[l.labelKey], l.labelKey).toBeDefined();
      for (const b of l.bases ?? []) expect(NL_PAYSLIP_LABELS[b], b).toBeDefined();
    }
  });

  it('accumulates year to date', () => {
    expect(r.ytd[NL_YTD_KEYS.wageTax]).toBe(81_867);
    expect(r.ytd[NL_YTD_KEYS.loonLbPh]).toBe(400_001);
    expect(r.ytd[NL_YTD_KEYS.awfCumBase]).toBe(400_000);
    expect(r.ytd[NL_YTD_KEYS.awfCumMax]).toBe(661_741);
  });

  it('is deterministic', () => {
    expect(calculateNlPayslip(input())).toEqual(r);
  });

  it('flags the first payslip of the year', () => {
    expect(codes(calculateNlPayslip(input({ ytd: {} })).issues)).toContain('first_payslip');
  });
});

describe('table columns', () => {
  it('without loonheffingskorting', () => {
    const r = calculateNlPayslip(input({ nl: { applyLoonheffingskorting: false } }));
    expect(amount(r.lines, 'nl.wage_tax')).toBe(-144_217);
    expect(line(r.lines, 'nl.labour_credit')).toBeUndefined();
  });

  it('AOW age, born 1946 or later: AOW column, no employee-insurance premiums, Zvw levy continues', () => {
    const r = calculateNlPayslip(input({ employee: { dateOfBirth: '1958-06-01' }, compensation: { payType: 'salary', amount: 3500, period: 'month', hoursPerWeek: 40 } }));
    // Row 3.496,50, AOW ≥1946 with LHK: 171,42; arbeidskorting 233,67.
    expect(amount(r.lines, 'nl.wage_tax')).toBe(-17_142);
    expect(amount(r.lines, 'nl.labour_credit')).toBe(23_367);
    expect(amount(r.lines, 'nl.awf_premium')).toBe(0);
    expect(amount(r.lines, 'nl.aof_premium')).toBe(0);
    expect(amount(r.lines, 'nl.zvw_employer_levy')).toBe(21_350);
    expect(r.filingData.kind === 'nl' && r.filingData.insured).toEqual({ ww: false, zw: true, wao: false });
  });

  it('AOW age, born 1945 or earlier', () => {
    const r = calculateNlPayslip(input({ employee: { dateOfBirth: '1945-02-01' }, compensation: { payType: 'salary', amount: 3500, period: 'month', hoursPerWeek: 40 } }));
    expect(amount(r.lines, 'nl.wage_tax')).toBe(-13_467);
    expect(amount(r.lines, 'nl.labour_credit')).toBe(23_367);
  });

  it('switches to the AOW column from the first day of the month the AOW age is reached', () => {
    const dob = '1959-03-15'; // AOW age (67) on 15 March 2026.
    const feb = calculateNlPayslip(input({ period: month(2), employee: { dateOfBirth: dob } }));
    const mar = calculateNlPayslip(input({ period: month(3), employee: { dateOfBirth: dob } }));
    expect(amount(feb.lines, 'nl.wage_tax')).toBe(-81_867);
    expect(amount(feb.lines, 'nl.awf_premium')).toBe(10_960);
    expect(amount(mar.lines, 'nl.wage_tax')).toBe(-40_275); // row 3.996,00, AOW ≥1946 with LHK
    expect(amount(mar.lines, 'nl.awf_premium')).toBe(0);
    // In the AOW month the indicators stay J; the return splits the period at the AOW date.
    expect(mar.filingData.kind === 'nl' && mar.filingData.insured.ww).toBe(true);
  });
});

describe('voortschrijdend cumulatief rekenen', () => {
  it('caps the premium wage at the monthly maximum (€ 6.617,41)', () => {
    const r = calculateNlPayslip(input({ compensation: { payType: 'salary', amount: 7000, period: 'month', hoursPerWeek: 40 } }));
    expect(r.filingData.kind === 'nl' && r.filingData.amounts.premieloonAwf).toBe(661_741);
    expect(amount(r.lines, 'nl.awf_premium')).toBe(18_131); // 6.617,41 × 2,74% = 181,317 → down
  });

  it('lets a later month use room left by an earlier lower month', () => {
    const jan = calculateNlPayslip(input({ period: month(1), ytd: {}, compensation: { payType: 'salary', amount: 5000, period: 'month', hoursPerWeek: 40 } }));
    const feb = calculateNlPayslip(input({ period: month(2), ytd: jan.ytd, compensation: { payType: 'salary', amount: 8000, period: 'month', hoursPerWeek: 40 } }));
    // Cumulative wage 13.000 ≤ cumulative maximum 13.234,82: the full 8.000 is premium wage.
    expect(feb.filingData.kind === 'nl' && feb.filingData.amounts.premieloonAwf).toBe(800_000);
    const mar = calculateNlPayslip(input({ period: month(3), ytd: feb.ytd, compensation: { payType: 'salary', amount: 8000, period: 'month', hoursPerWeek: 40 } }));
    // 21.000 against 19.852,23: aanwas 19.852,23 − 13.000.
    expect(mar.filingData.kind === 'nl' && mar.filingData.amounts.premieloonAwf).toBe(1_985_223 - 1_300_000);
  });
});

describe('anonymous rate', () => {
  it('withholds 52% without credits and without premium caps', () => {
    const r = calculateNlPayslip(input({ nl: { anonymous: true }, compensation: { payType: 'salary', amount: 8000, period: 'month', hoursPerWeek: 40 } }));
    expect(amount(r.lines, 'nl.wage_tax')).toBe(-416_000);
    expect(r.filingData).toMatchObject({ tableCode: '940', applyLoonheffingskorting: false, anonymous: true, amounts: { premieloonAwf: 800_000, loonZvw: 800_000 } });
    expect(codes(r.issues)).toContain('anonymous_rate');
  });
});

describe('DGA', () => {
  const r = calculateNlPayslip(input({ nl: { isDga: true, insuredWw: false, insuredZw: false, insuredWao: false } }));

  it('pays no employee-insurance premiums and withholds the Zvw contribution', () => {
    expect(r.employerTaxesCents).toBe(0);
    expect(amount(r.lines, 'nl.zvw_contribution')).toBe(-19_400); // 4,85% of 4.000
    expect(r.netCents).toBe(400_000 - 81_867 - 19_400);
    expect(r.filingData).toMatchObject({ zvw: 'withheld', insured: { ww: false, zw: false, wao: false }, amounts: { loonSv: 0, zvwWithheld: 19_400 } });
  });

  it('warns when the salary is below the usual-salary minimum (€ 58.000)', () => {
    expect(r.issues).toContainEqual({ severity: 'warning', code: 'dga_usual_salary', params: { annualCents: 4_800_000, minimumCents: 5_800_000 } });
    const high = calculateNlPayslip(input({ nl: { isDga: true }, compensation: { payType: 'salary', amount: 5000, period: 'month', hoursPerWeek: 40 } }));
    expect(codes(high.issues)).not.toContain('dga_usual_salary');
  });
});

describe('holiday allowance', () => {
  it('reserves 8% each month and pays the balance in the payout month with the special-reward table', () => {
    const ytd = { [NL_YTD_KEYS.holidayAllowanceOpening]: 0, [NL_YTD_KEYS.holidayAllowanceAccrued]: 128_000, [NL_YTD_KEYS.holidayAllowancePaid]: 0 };
    const r = calculateNlPayslip(input({ period: month(5), ytd }));
    expect(amount(r.lines, 'nl.holiday_allowance')).toBe(160_000);
    expect(line(r.lines, 'nl.holiday_allowance')?.bases).toContain('nl.loon_bb');
    // Annual wage 51.840 → 37,56% + 12,91% = 50,47%: 1.600 × 50,47% = 807,52.
    expect(amount(r.lines, 'nl.wage_tax_special')).toBe(-80_752);
    expect(amount(r.lines, 'nl.wage_tax')).toBe(-81_867);
    expect(r.filingData).toMatchObject({ amounts: { holidayAllowancePaid: 160_000, holidayAllowanceAccrued: 32_000, loonTabelBijzondereBeloningen: 160_000 } });
    expect(nlHolidayAllowanceBalance(r.ytd)).toBe(0);
  });

  it('carries last year’s reserve into the year', () => {
    const r = calculateNlPayslip(input({ period: month(1), ytd: {}, nl: { holidayAllowanceOpeningBalanceCents: 112_000 } }));
    expect(r.ytd[NL_YTD_KEYS.holidayAllowanceOpening]).toBe(112_000);
    expect(nlHolidayAllowanceBalance(r.ytd)).toBe(112_000 + 32_000);
  });

  it('pays monthly with the period table when no payout month is set', () => {
    const r = calculateNlPayslip(input({ employer: { holidayAllowancePayoutMonth: null } }));
    expect(amount(r.lines, 'nl.holiday_allowance')).toBe(32_000);
    expect(amount(r.lines, 'nl.wage_tax')).toBe(-98_217); // row 4.320,00
    expect(line(r.lines, 'nl.wage_tax_special')).toBeUndefined();
  });

  it('pays the balance out when employment ends', () => {
    const ytd = { [NL_YTD_KEYS.holidayAllowanceOpening]: 50_000, [NL_YTD_KEYS.holidayAllowanceAccrued]: 160_000, [NL_YTD_KEYS.holidayAllowancePaid]: 0 };
    const r = calculateNlPayslip(input({ period: month(9), ytd, employee: { endDate: '2026-09-30' } }));
    expect(amount(r.lines, 'nl.holiday_allowance')).toBe(50_000 + 160_000 + 32_000);
  });
});

describe('partial first month', () => {
  it('full-timer: salary by working days, tax with the day table, premium cap by days', () => {
    // 16–31 March 2026 = 12 of 22 working days: 4.000 × 12/22 = 2.181,82; per day 181,82 →
    // day-table row 181,74: 36,42 with LHK and arbeidskorting 21,45, × 12 days.
    const r = calculateNlPayslip(input({ employee: { startDate: '2026-03-16' }, ytd: {} }));
    expect(amount(r.lines, 'nl.salary')).toBe(218_182);
    expect(amount(r.lines, 'nl.wage_tax')).toBe(-43_704);
    expect(amount(r.lines, 'nl.labour_credit')).toBe(25_740);
    expect(r.filingData.kind === 'nl' && r.filingData.tableCode).toBe('015');
    expect(r.ytd[NL_YTD_KEYS.awfCumMax]).toBe(12 * 30_541);
    expect(codes(r.issues)).toEqual(expect.arrayContaining(['partial_period', 'first_payslip']));
  });

  it('part-timer: the month stays the period (monthly table)', () => {
    const r = calculateNlPayslip(input({ employee: { startDate: '2026-03-16' }, nl: { contractHoursPerWeek: 32, usualWorkDaysPerWeek: 4 } }));
    expect(amount(r.lines, 'nl.salary')).toBe(218_182);
    expect(amount(r.lines, 'nl.wage_tax')).toBe(-7_683); // row 2.178,00
    expect(r.filingData.kind === 'nl' && r.filingData.tableCode).toBe('012');
  });
});

describe('special rewards', () => {
  it('bonus in a first year: annual wage estimated for the whole year (Handboek §9.3.6)', () => {
    // 4.000 × 12 + reserved holiday allowance 3.840 + bonus 1.000 = 52.840 → 50,47%.
    const r = calculateNlPayslip(input({ nl: { previousYearAnnualWageCents: null }, inputs: [{ code: 'bonus', label: null, quantity: null, rate: null, amountCents: 100_000, workDate: null }] }));
    expect(amount(r.lines, 'nl.wage_tax_special')).toBe(-50_470);
    expect(line(r.lines, 'nl.wage_tax_special')?.rate).toBe(50.47);
  });

  it('uses the previous year’s annual wage', () => {
    const r = calculateNlPayslip(input({ nl: { previousYearAnnualWageCents: 3_000_000 }, inputs: [{ code: 'commission', label: null, quantity: null, rate: null, amountCents: 100_000, workDate: null }] }));
    expect(amount(r.lines, 'nl.wage_tax_special')).toBe(-40_200); // row 29.737: 35,75 + 4,45
  });

  it('annualises a partial previous year by months employed', () => {
    expect(nlAnnualWageForSpecialRewards({ [NL_YTD_KEYS.loonLbPh]: 300_000, [NL_YTD_KEYS.monthsEmployedX10000]: 15_000 })).toBe(2_400_000);
    expect(nlAnnualWageForSpecialRewards({ [NL_YTD_KEYS.loonLbPh]: 5_000_000, [NL_YTD_KEYS.monthsEmployedX10000]: 120_000 })).toBe(5_000_000);
  });

  it('transitievergoeding: green table, no SV wage, own share of the Zvw', () => {
    const r = calculateNlPayslip(input({ inputs: [{ code: 'nl.transition_payment', label: null, quantity: null, rate: null, amountCents: 1_000_000, workDate: null }] }));
    expect(amount(r.lines, 'nl.wage_tax_transition')).toBe(-439_600); // green 37,56 + 6,40
    expect(line(r.lines, 'nl.transition_payment')?.bases).not.toContain('nl.loon_sv');
    expect(r.filingData).toMatchObject({
      amounts: { loonSv: 400_000, loonLbPh: 1_400_000, loonZvw: 661_741, transitionPayment: 1_000_000, transitionPaymentLoonZvw: 261_741 },
    });
  });
});

describe('benefits and allowances', () => {
  it('company car: bijtelling minus own contribution counts in every wage', () => {
    const r = calculateNlPayslip(input({ components: [{ code: 'nl.company_car', amountCents: null, params: { list_price: 40000, percent: 22, employee_contribution: 100 } }] }));
    expect(amount(r.lines, 'nl.company_car')).toBe(73_333);
    expect(amount(r.lines, 'nl.company_car_contribution')).toBe(-10_000);
    expect(r.taxableWageCents).toBe(463_333);
    expect(amount(r.lines, 'nl.wage_tax')).toBe(-113_892); // row 4.630,50
    expect(r.grossCents).toBe(400_000);
    expect(r.netCents).toBe(400_000 - 113_892 - 10_000);
    expect(r.filingData).toMatchObject({ amounts: { companyCarValue: 73_333, companyCarEmployeeContribution: 10_000, inKindWage: 63_333, cashWage: 400_000 } });
  });

  it('zero-emission car: lower percentage up to the cap', () => {
    const r = calculateNlPayslip(input({ components: [{ code: 'nl.company_car', amountCents: null, params: { list_price: 40000, percent: 22, zero_emission_cap: 30000, zero_emission_percent: 18 } }] }));
    expect(amount(r.lines, 'nl.company_car')).toBe(63_333); // (30.000 × 18% + 10.000 × 22%) / 12
  });

  it('travel allowance: tax-free up to € 0,25 per km, the rest is wage', () => {
    const r = calculateNlPayslip(input({ components: [{ code: 'nl.travel_allowance', amountCents: 20_000, params: { km_per_day: 40, days_per_month: 18 } }] }));
    expect(amount(r.lines, 'nl.travel_allowance')).toBe(18_000);
    expect(amount(r.lines, 'nl.travel_allowance_taxable')).toBe(2_000);
    expect(r.taxableWageCents).toBe(402_000);
    expect(r.filingData).toMatchObject({ amounts: { travelAllowanceTaxFree: 18_000, taxFreeAllowances: 18_000 } });
  });

  it('home-working allowance: € 2,45 per day', () => {
    const r = calculateNlPayslip(input({ inputs: [{ code: 'nl.home_working_allowance', label: null, quantity: 8, rate: null, amountCents: null, workDate: null }] }));
    expect(amount(r.lines, 'nl.home_working_allowance')).toBe(1_960);
    expect(r.netCents).toBe(318_133 + 1_960);
  });

  it('pension: employee premium over salary minus franchise reduces every wage', () => {
    // (4.000 − 19.172/12) × 5% = 120,12 → wage 3.879,88 → row 3.879,00: 759,58.
    const r = calculateNlPayslip(input({ components: [
      { code: 'nl.pension_employee', amountCents: null, params: { percent: 5, franchise_per_year: 19172 } },
      { code: 'nl.pension_employer', amountCents: null, params: { percent: 10, franchise_per_year: 19172 } },
    ] }));
    expect(amount(r.lines, 'nl.pension_employee')).toBe(-12_012);
    expect(r.taxableWageCents).toBe(387_988);
    expect(amount(r.lines, 'nl.wage_tax')).toBe(-75_958);
    expect(amount(r.lines, 'nl.pension_employer')).toBe(24_023);
    expect(r.employerCostCents).toBe(400_000 + r.employerTaxesCents + 24_023);
  });

  it('30% ruling: tax-free allowance of 30% of the wage including it', () => {
    const r = calculateNlPayslip(input({ nl: { expatRulingPercent: 30 }, compensation: { payType: 'salary', amount: 10000, period: 'month', hoursPerWeek: 40 } }));
    expect(amount(r.lines, 'nl.expat_allowance')).toBe(-300_000);
    expect(r.taxableWageCents).toBe(700_000);
    expect(amount(r.lines, 'nl.wage_tax')).toBe(-235_908); // row 6.997,50
    expect(r.filingData).toMatchObject({ amounts: { cashWage: 700_000, taxFreeAllowances: 300_000, premieloonAwf: 661_741 } });
    expect(r.netCents).toBe(1_000_000 - 235_908);
  });

  it('net items: reimbursement, advance and net deduction', () => {
    const r = calculateNlPayslip(input({ inputs: [
      { code: 'reimbursement', label: 'Train', quantity: null, rate: null, amountCents: 5_000, workDate: null },
      { code: 'advance', label: null, quantity: null, rate: null, amountCents: -20_000, workDate: null },
      { code: 'deduction.net', label: null, quantity: null, rate: null, amountCents: 3_000, workDate: null },
    ] }));
    expect(r.reimbursementsCents).toBe(5_000);
    expect(r.employeeDeductionsCents).toBe(23_000);
    expect(r.netCents).toBe(318_133 + 5_000 - 23_000);
    expect(r.taxableWageCents).toBe(400_000);
  });
});

describe('hours', () => {
  it('hourly pay with overtime at 125%', () => {
    const r = calculateNlPayslip(input({
      compensation: { payType: 'hourly', amount: 20, period: 'hour', hoursPerWeek: 38 },
      inputs: [
        { code: 'hours.regular', label: null, quantity: 160, rate: null, amountCents: null, workDate: null },
        { code: 'hours.overtime', label: null, quantity: 10, rate: 125, amountCents: null, workDate: null },
      ],
    }));
    expect(amount(r.lines, 'nl.hours_regular')).toBe(320_000);
    expect(amount(r.lines, 'hours.overtime')).toBe(25_000);
    expect(amount(r.lines, 'nl.wage_tax')).toBe(-57_133); // row 3.447,00
    expect(r.filingData).toMatchObject({ hoursPaid: 170, amounts: { overtimeWage: 25_000 } });
  });

  it('unpaid leave reduces pay at the hourly equivalent and is coded O', () => {
    // 4.000 / (40 × 52 / 12) = 23,0769 per hour; 8 hours = 184,62.
    const r = calculateNlPayslip(input({ inputs: [{ code: 'hours.unpaid_leave', label: null, quantity: 8, rate: null, amountCents: null, workDate: null }] }));
    expect(amount(r.lines, 'hours.unpaid_leave')).toBe(-18_462);
    expect(r.filingData).toMatchObject({ hoursPaid: 165, incidentalIncomeReduction: 'O' });
  });

  it('sick pay at 70% reduces pay for the 30% and warns below the statutory 70%', () => {
    const r = calculateNlPayslip(input({ inputs: [{ code: 'nl.sick_pay', label: null, quantity: 16, rate: 70, amountCents: null, workDate: null }] }));
    expect(amount(r.lines, 'nl.sick_pay')).toBe(-11_077); // 16 × 23,0769 × 30%
    expect(r.filingData.kind === 'nl' && r.filingData.incidentalIncomeReduction).toBe('Z');
    const low = calculateNlPayslip(input({ inputs: [{ code: 'nl.sick_pay', label: null, quantity: 16, rate: 60, amountCents: null, workDate: null }] }));
    expect(codes(low.issues)).toContain('sick_pay_below_statutory');
  });
});

describe('checks', () => {
  it('below the statutory minimum hourly wage is an error', () => {
    const r = calculateNlPayslip(input({ compensation: { payType: 'hourly', amount: 14, period: 'hour', hoursPerWeek: 40 }, inputs: [{ code: 'hours.regular', label: null, quantity: 160, rate: null, amountCents: null, workDate: null }] }));
    expect(r.issues).toContainEqual({ severity: 'error', code: 'below_minimum_wage', params: { hourlyCents: 1400, minimumCents: 1471, age: 35 } });
  });

  it('uses the youth minimum wage and the July amounts', () => {
    const teen = { dateOfBirth: '2008-01-15' }; // 18
    const ok = calculateNlPayslip(input({ period: month(3), employee: teen, compensation: { payType: 'hourly', amount: 7.4, period: 'hour', hoursPerWeek: 20 }, inputs: [{ code: 'hours.regular', label: null, quantity: 80, rate: null, amountCents: null, workDate: null }] }));
    expect(codes(ok.issues)).not.toContain('below_minimum_wage'); // January rate 7,36
    const july = calculateNlPayslip(input({ period: month(7), employee: teen, compensation: { payType: 'hourly', amount: 7.4, period: 'hour', hoursPerWeek: 20 }, inputs: [{ code: 'hours.regular', label: null, quantity: 80, rate: null, amountCents: null, workDate: null }] }));
    expect(july.issues).toContainEqual({ severity: 'error', code: 'below_minimum_wage', params: { hourlyCents: 740, minimumCents: 750, age: 18 } });
  });

  it('negative net pay is an error', () => {
    const r = calculateNlPayslip(input({ inputs: [{ code: 'deduction.net', label: null, quantity: null, rate: null, amountCents: 500_000, workDate: null }] }));
    expect(codes(r.issues)).toContain('negative_net_pay');
  });

  it('a missing Whk rate without a small-employer sector rate is an employer error', () => {
    const r = calculateNlPayslip(input({ employer: { whkRatePercent: null, sectorCode: null } }));
    expect(r.issues).toContainEqual({ severity: 'error', code: 'employer_incomplete', params: { field: 'whkRatePercent' } });
    const own = calculateNlPayslip(input({ employer: { whkRatePercent: 1.5, aofSmallEmployer: false } }));
    expect(amount(own.lines, 'nl.whk_premium')).toBe(6_000);
    expect(amount(own.lines, 'nl.aof_premium')).toBe(30_520); // Aof high 7,63%
  });

  it('a code from another country is unsupported', () => {
    const r = calculateNlPayslip(input({ inputs: [{ code: 'us.tips_cash', label: null, quantity: null, rate: null, amountCents: 100, workDate: null }] }));
    expect(r.issues).toContainEqual({ severity: 'error', code: 'unsupported_component', params: { code: 'us.tips_cash' } });
  });

  it('an unsupported tax year is an error, never an exception', () => {
    const r = calculateNlPayslip(input({ period: month(3, 2025) }));
    expect(r.issues).toEqual([{ severity: 'error', code: 'unsupported_tax_year', params: { year: 2025 } }]);
    expect(r.ruleSet).toBe('nl-none');
  });

  it('2027 uses the provisional Prinsjesdag rules and says so', () => {
    const r = calculateNlPayslip(input({ period: month(3, 2027) }));
    expect(r.ruleSet).toBe('nl-2027.0-prinsjesdag');
    expect(codes(r.issues)).toContain('provisional_rules');
    expect(amount(r.lines, 'nl.aof_premium')).toBe(26_680); // Aof low 6,67% (SZW 2027, provisional)
  });

  it('warns about the AWf revision when a permanent contract ends within two months', () => {
    const r = calculateNlPayslip(input({ period: month(2), employee: { startDate: '2026-01-05', endDate: '2026-02-20' } }));
    expect(codes(r.issues)).toContain('awf_revision_required');
  });
});
