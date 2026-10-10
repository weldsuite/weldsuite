import { describe, expect, it } from 'vitest';
import type { UsFilingData } from '../types';
import { annualReturnDueDate, legalHolidays, quarterlyReturnDueDate } from './dates';
import {
  depositDueDate,
  form940,
  form941,
  formW2,
  formW3,
  maskSsn,
  stateUnemploymentReport,
  stateWithholdingReport,
  type UsEmployeeForForms,
  type UsEmployerForForms,
  type UsPayslipForForms,
} from './forms';

const employer: UsEmployerForForms = {
  name: 'Acme Widgets Inc',
  ein: '123456789',
  address: ['1 Main St', 'Austin, TX 78701'],
  depositSchedule: 'monthly',
  states: { CA: { withholdingAccountNumber: '123-4567-8', suiAccountNumber: '123-4567-8' } },
};

const alice: UsEmployeeForForms = { employeeId: 'e1', name: 'Alice Adams', ssn: '123-45-6789', address: ['2 Oak Ave'] };
const bob: UsEmployeeForForms = { employeeId: 'e2', name: 'Bob Brown', ssn: '987654321', address: ['3 Pine Rd'] };

type Federal = UsFilingData['federal'];

/** A payslip's filing figures: $5,000 of wages unless overridden. */
function slip(employeeId: string, payDate: string, f: Partial<Federal> = {}, states: UsFilingData['states'] = {}, extra: Partial<UsPayslipForForms> = {}): UsPayslipForForms {
  const federal: Federal = {
    fitWages: 500_000,
    federalIncomeTax: 50_000,
    ssWages: 500_000,
    ssTaxEmployee: 31_000,
    ssTaxEmployer: 31_000,
    medicareWages: 500_000,
    medicareTaxEmployee: 7_250,
    medicareTaxEmployer: 7_250,
    additionalMedicareWages: 0,
    additionalMedicareTax: 0,
    futaGrossWages: 500_000,
    futaWages: 0,
    futaTax: 0,
    ssTips: 0,
    box12: {},
    dependentCare: 0,
    futaExemptWages: 0,
    futaState: 'TX',
    ...f,
  };
  return { payslipId: `${employeeId}-${payDate}`, employeeId, payDate, filingData: { kind: 'us', federal, states, qualifiedOvertimePremium: 0, hoursWorked: 0 }, ...extra };
}

describe('due dates (Pub 15 section 11)', () => {
  it('reproduces the 2026 legal holidays listed in Pub 15', () => {
    expect(legalHolidays(2026)).toEqual([
      '2026-01-01',
      '2026-01-19',
      '2026-02-16',
      '2026-04-16',
      '2026-05-25',
      '2026-06-19',
      '2026-07-03',
      '2026-09-07',
      '2026-10-12',
      '2026-11-11',
      '2026-11-26',
      '2026-12-25',
    ]);
  });

  it('monthly schedule: the 15th of the next month, moved off weekends and holidays', () => {
    expect(depositDueDate('monthly', '2026-03-31')).toBe('2026-04-15');
    expect(depositDueDate('monthly', '2026-02-27')).toBe('2026-03-16'); // 15 March 2026 is a Sunday
    expect(depositDueDate('monthly', '2026-12-31')).toBe('2027-01-15');
  });

  it('semiweekly schedule: Wed–Fri → next Wednesday, Sat–Tue → next Friday (Pub 15 example: 30 Sept and 2 Oct 2026 → 7 Oct)', () => {
    expect(depositDueDate('semiweekly', '2026-09-30')).toBe('2026-10-07');
    expect(depositDueDate('semiweekly', '2026-10-02')).toBe('2026-10-07');
    expect(depositDueDate('semiweekly', '2026-10-06')).toBe('2026-10-09');
    expect(depositDueDate('semiweekly', '2026-10-03')).toBe('2026-10-09');
    // Friday payday, Monday 19 January is a holiday → Thursday.
    expect(depositDueDate('semiweekly', '2026-01-16')).toBe('2026-01-22');
  });

  it('$100,000 next-day deposit rule', () => {
    expect(depositDueDate('monthly', '2026-07-02', { accumulatedCents: 10_000_000 })).toBe('2026-07-06');
  });

  it('941 due the last day of the month after the quarter, 940/W-2 on 31 January, next business day', () => {
    expect(quarterlyReturnDueDate(2026, 1)).toBe('2026-04-30');
    expect(quarterlyReturnDueDate(2026, 3)).toBe('2026-11-02');
    expect(quarterlyReturnDueDate(2026, 4)).toBe('2027-02-01');
    expect(annualReturnDueDate(2026)).toBe('2027-02-01');
    expect(annualReturnDueDate(2025)).toBe('2026-02-02');
  });
});

describe('Form 941', () => {
  const q1 = [
    ...['2026-01-30', '2026-02-27', '2026-03-31'].map((d) => slip('e1', d)),
    ...['2026-01-30', '2026-02-27', '2026-03-31'].map((d) => slip('e2', d, {}, {}, { periodStart: '2026-03-01', periodEnd: '2026-03-31' })),
    slip('e1', '2026-04-30'),
  ];

  it('totals the quarter and splits the liability by month', () => {
    const r = form941({ employer, taxYear: 2026, quarter: 1, payslips: q1 });
    expect(r.summary).toMatchObject({
      line1: 2,
      line2: 3_000_000,
      line3: 300_000,
      line5a_wages: 3_000_000,
      line5a_tax: 372_000,
      line5c_wages: 3_000_000,
      line5c_tax: 87_000,
      line5e: 459_000,
      line6: 759_000,
      line7: 0,
      line10: 759_000,
      line12: 759_000,
      line13: 759_000,
      line14: 0,
      line16_box: 2,
      line16_month1: 253_000,
      line16_month2: 253_000,
      line16_month3: 253_000,
      line16_total: 759_000,
    });
    expect(r.amountDueCents).toBe(0);
    expect(r.dueDate).toBe('2026-04-30');
    expect(r.document.title).toContain('941');
  });

  it('adjusts for fractions of cents (line 7) and keeps line 16 equal to line 12', () => {
    // $333.50 of wages three times. Withheld per payslip: SS 20.677 → 20.68, Medicare 4.83575 → 4.84,
    // so 3 × 25.52 = 76.56. Employee share of column 2 on $1,000.50: SS 62.031 → 62.03, Medicare
    // 14.507 → 14.51, so 76.54. Line 7 = +0.02.
    const odd = [1, 2, 3].map((m) =>
      slip('e1', `2026-0${m}-15`, {
        fitWages: 33_350,
        federalIncomeTax: 0,
        ssWages: 33_350,
        ssTaxEmployee: 2_068,
        ssTaxEmployer: 2_068,
        medicareWages: 33_350,
        medicareTaxEmployee: 484,
        medicareTaxEmployer: 484,
      }),
    );
    const r = form941({ employer, taxYear: 2026, quarter: 1, payslips: odd });
    expect(r.summary.line7).toBe(2);
    expect(r.summary.line12).toBe(r.summary.line5e! + 2);
    expect(r.summary.line16_month1! + r.summary.line16_month2! + r.summary.line16_month3!).toBe(r.summary.line12);
    expect(r.summary.line16_box).toBe(1); // under $2,500: de minimis
  });

  it('semiweekly depositors get Schedule B daily liabilities', () => {
    const r = form941({ employer: { ...employer, depositSchedule: 'semiweekly' }, taxYear: 2026, quarter: 1, payslips: q1 });
    expect(r.summary.line16_box).toBe(3);
    expect(r.summary.scheduleB_m1_d30).toBe(253_000);
    expect(r.summary.scheduleB_m3_d31).toBe(253_000);
    expect(r.document.sections.some((s) => s.kind === 'table' && s.title?.startsWith('Schedule B'))).toBe(true);
  });

  it('shows a balance due when deposits fall short', () => {
    const r = form941({ employer, taxYear: 2026, quarter: 1, payslips: q1, depositsCents: 700_000 });
    expect(r.summary.line14).toBe(59_000);
    expect(r.amountDueCents).toBe(59_000);
  });
});

describe('Form 940', () => {
  it('computes lines 3–8 per employee wage base', () => {
    const slips = [
      ...[1, 2, 3, 4, 5, 6].map((m) => slip('e1', `2026-0${m}-28`, { futaGrossWages: 500_000, futaExemptWages: 0, futaWages: m === 1 ? 500_000 : m === 2 ? 200_000 : 0, futaTax: m === 1 ? 3_000 : m === 2 ? 1_200 : 0 })),
      slip('e2', '2026-07-31', { futaGrossWages: 400_000, futaExemptWages: 50_000, futaWages: 350_000, futaTax: 2_100 }),
    ];
    const r = form940({ employer, taxYear: 2026, payslips: slips });
    expect(r.summary).toMatchObject({ line3: 3_400_000, line4: 50_000, line5: 2_300_000, line6: 2_350_000, line7: 1_050_000, line8: 6_300, line11: 0, line12: 6_300 });
    // Line 12 is $500 or less: Part 5 is not required.
    expect(r.summary).toMatchObject({ line9: 0, line16a: 0, line17: 0 });
    expect(r.dueDate).toBe('2027-02-01');
  });

  it('Part 5 splits the liability by quarter when line 12 is over $500', () => {
    const slips = Array.from({ length: 15 }, (_, i) =>
      slip(`e${i}`, i < 10 ? '2026-02-27' : '2026-08-31', { futaGrossWages: 700_000, futaWages: 700_000, futaTax: 4_200 }),
    );
    const r = form940({ employer, taxYear: 2026, payslips: slips });
    expect(r.summary).toMatchObject({ line7: 10_500_000, line12: 63_000, line16a: 42_000, line16b: 0, line16c: 21_000, line16d: 0, line17: 63_000 });
  });

  it('line 9 applies when every taxable FUTA wage was excluded from state unemployment tax', () => {
    const exempt = slip('e1', '2026-01-30', { futaGrossWages: 700_000, futaWages: 700_000, futaTax: 4_200, futaState: 'TX' }, {
      TX: { stateWages: 0, stateIncomeTax: 0, suiWages: 0, suiGrossWages: 0, suiEmployerTax: 0, suiEmployeeTax: 0, programs: {} },
    });
    expect(form940({ employer, taxYear: 2026, payslips: [exempt] }).summary).toMatchObject({ line8: 4_200, line9: 37_800, line12: 42_000 });
  });

  it('Schedule A credit reduction (2025, California 0.012): $21,000 → $252.00, paid with the fourth quarter', () => {
    const ca = (id: string) =>
      slip('e' + id, '2025-03-31', { futaGrossWages: 700_000, futaWages: 700_000, futaTax: 4_200 + 8_400, futaCreditReduction: 8_400, futaState: 'CA' }, {
        CA: { stateWages: 700_000, stateIncomeTax: 0, suiWages: 700_000, suiGrossWages: 700_000, suiEmployerTax: 0, suiEmployeeTax: 0, programs: {} },
      });
    const r = form940({ employer, taxYear: 2025, payslips: [ca('1'), ca('2'), ca('3')] });
    expect(r.summary).toMatchObject({ line2: 1, line7: 2_100_000, line8: 12_600, line11: 25_200, line12: 37_800, scheduleA_CA_wages: 2_100_000, scheduleA_CA_reduction: 25_200 });
    // $378 in total: Part 5 is not required.
    expect(r.summary.line17).toBe(0);
    expect(r.dueDate).toBe('2026-02-02');
  });
});

describe('Form W-2 and W-3', () => {
  const payslips = [
    slip('e1', '2026-06-30', {
      fitWages: 450_000,
      additionalMedicareWages: 10_000,
      additionalMedicareTax: 90,
      ssTips: 20_000,
      dependentCare: 30_000,
      box12: { D: 50_000, DD: 60_000, TT: 5_000, TP: 20_000, W: 10_000 },
      retirementPlan: true,
    }, { CA: { stateWages: 450_000, stateIncomeTax: 20_000, suiWages: 0, suiGrossWages: 500_000, suiEmployerTax: 0, suiEmployeeTax: 0, programs: {} } }),
    slip('e1', '2026-12-31', { box12: { D: 50_000, AA: 10_000 } }),
    slip('e2', '2026-12-31'),
  ];

  it('sums the year for one employee, with box 12 codes in order and a masked SSN', () => {
    const r = formW2({ employer, employee: alice, taxYear: 2026, payslips });
    expect(r.summary).toMatchObject({
      box1: 950_000,
      box2: 100_000,
      box3: 1_000_000,
      box4: 62_000,
      box5: 1_000_000,
      box6: 14_590,
      box7: 20_000,
      box10: 30_000,
      box12_D: 100_000,
      box12_AA: 10_000,
      box12_TT: 5_000,
      box12_TP: 20_000,
      box13_retirement: 1,
      box16_CA: 450_000,
      box17_CA: 20_000,
    });
    const codes = r.document.sections.find((s) => s.kind === 'table' && s.title === '12 Codes');
    expect(codes?.kind === 'table' && codes.rows.map((row) => row[0])).toEqual(['D', 'W', 'AA', 'DD', 'TP', 'TT']);
    expect(JSON.stringify(r.document)).toContain('XXX-XX-6789');
    expect(JSON.stringify(r.document)).not.toContain('123-45-6789');
    expect(r.dueDate).toBe('2027-02-01');
    const notes = r.document.sections.find((s) => s.kind === 'text');
    expect(notes?.kind === 'text' && notes.paragraphs.join(' ')).toContain('box 14b');
  });

  it('W-3 totals every W-2; box 12a is the deferred compensation codes', () => {
    const r = formW3({ employer, taxYear: 2026, employees: [{ employee: alice, payslips }, { employee: bob, payslips }] });
    expect(r.summary).toMatchObject({ boxC: 2, box1: 1_450_000, box2: 150_000, box12a: 110_000, box16_CA: 450_000 });
  });

  it('masks SSNs', () => {
    expect(maskSsn('123456789')).toBe('XXX-XX-6789');
    expect(maskSsn(null)).toBe('');
  });
});

describe('state reports', () => {
  const ca = (employeeId: string, payDate: string, wages: number) =>
    slip(employeeId, payDate, { futaGrossWages: wages }, {
      CA: { stateWages: wages, stateIncomeTax: wages / 20, suiWages: Math.min(wages, 700_000), suiGrossWages: wages, suiEmployerTax: 3_400, suiEmployeeTax: 0, programs: {} },
    });
  const employees = [
    { employee: bob, payslips: [ca('e2', '2026-07-31', 400_000)] },
    { employee: alice, payslips: [ca('e1', '2026-07-31', 600_000), ca('e1', '2026-08-31', 600_000), ca('e1', '2026-10-30', 600_000)] },
  ];

  it('builds the withholding report with totals and a CSV with full SSNs', () => {
    const r = stateWithholdingReport({ employer, state: 'CA', taxYear: 2026, quarter: 3, employees });
    expect(r.summary).toEqual({ employees: 2, gross: 1_600_000, stateWages: 1_600_000, stateTax: 80_000 });
    expect(r.amountDueCents).toBe(80_000);
    expect(r.dueDate).toBe('2026-11-02');
    expect(r.files?.[0]?.content.split('\n')[1]).toBe('e1,Alice Adams,123-45-6789,12000.00,12000.00,600.00');
    expect(JSON.stringify(r.document)).not.toContain('123-45-6789');
  });

  it('builds the unemployment wage report', () => {
    const r = stateUnemploymentReport({ employer, state: 'ca', taxYear: 2026, quarter: 3, employees });
    expect(r.summary).toEqual({ employees: 2, grossWages: 1_600_000, taxableWages: 1_600_000, excessWages: 0, employeeContributions: 0, employerContributions: 10_200 });
    expect(r.files?.[0]?.fileName).toBe('ca-unemployment-2026-q3.csv');
  });
});
