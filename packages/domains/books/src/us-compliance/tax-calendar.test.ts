import { describe, it, expect } from 'vitest';
import type { FiscalYearConfig } from './fiscal-year';
import {
  agencyDeadlines,
  daysUntil,
  incomeTaxDeadlines,
  information1099Deadlines,
  payrollDeadlines,
  taxCalendar,
  type SalesTaxAgencyInput,
  type TaxDeadline,
} from './tax-calendar';

const pairs = (items: TaxDeadline[]) => items.map((item) => [item.dueDate, item.key]);
const find = (items: TaxDeadline[], key: string) => {
  const found = items.find((item) => item.key === key);
  if (!found) throw new Error(`missing ${key}`);
  return found;
};

describe('income tax return deadlines', () => {
  it('uses the 15th of the 3rd month for 1065 and 1120-S and extends by six months', () => {
    for (const form of ['f1065', 'f1120s'] as const) {
      const items = incomeTaxDeadlines({ form }, 2026);
      expect(find(items, `${form}:2026`)).toMatchObject({ dueDate: '2027-03-15', nominalDate: '2027-03-15', kind: 'income_tax_return' });
      expect(find(items, `${form}:2026:extended`)).toMatchObject({ dueDate: '2027-09-15', extensionForm: 'Form 7004' });
    }
  });

  it('moves a Sunday due date to Monday', () => {
    const items = incomeTaxDeadlines({ form: 'f1120s' }, 2025);
    expect(find(items, 'f1120s:2025')).toMatchObject({ nominalDate: '2026-03-15', dueDate: '2026-03-16' });
  });

  it('uses 15 April for Schedule C and 15 October with Form 4868, whatever the entity fiscal year', () => {
    const july: FiscalYearConfig = { type: 'month', startMonth: 7 };
    const items = incomeTaxDeadlines({ form: 'sch_c', fiscalYear: july }, 2026);
    expect(find(items, 'sch_c:2026')).toMatchObject({ dueDate: '2027-04-15', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    expect(find(items, 'sch_c:2026:extended')).toMatchObject({ dueDate: '2027-10-15', extensionForm: 'Form 4868' });
  });

  it('uses the 15th of the 4th month for 1120 and four 1120-W installments', () => {
    const items = incomeTaxDeadlines({ form: 'f1120' }, 2026);
    expect(find(items, 'f1120:2026').dueDate).toBe('2027-04-15');
    expect(find(items, 'f1120:2026:extended').dueDate).toBe('2027-10-15');
    expect(pairs(items.filter((item) => item.kind === 'estimated_tax'))).toEqual([
      ['2026-04-15', '1120w:2026:q1'],
      ['2026-06-15', '1120w:2026:q2'],
      ['2026-09-15', '1120w:2026:q3'],
      ['2026-12-15', '1120w:2026:q4'],
    ]);
  });

  it('keeps the 3rd month for C corporations with a June year end that began before 2026', () => {
    const june: FiscalYearConfig = { type: 'month', startMonth: 7 };
    const old = incomeTaxDeadlines({ form: 'f1120', fiscalYear: june }, 2026); // 1 July 2025 - 30 June 2026
    expect(find(old, 'f1120:2026')).toMatchObject({ nominalDate: '2026-09-15', dueDate: '2026-09-15' });
    expect(find(old, 'f1120:2026:extended').dueDate).toBe('2027-04-15');
    expect(pairs(old.filter((item) => item.kind === 'estimated_tax'))).toEqual([
      ['2025-10-15', '1120w:2026:q1'],
      ['2025-12-15', '1120w:2026:q2'],
      ['2026-03-16', '1120w:2026:q3'], // 15 March 2026 is a Sunday
      ['2026-06-15', '1120w:2026:q4'],
    ]);

    const current = incomeTaxDeadlines({ form: 'f1120', fiscalYear: june }, 2027); // starts 1 July 2026
    expect(find(current, 'f1120:2027').dueDate).toBe('2027-10-15');
    // 15 April 2028 is a Saturday and 16 April (DC Emancipation Day) a Sunday observed on Monday
    expect(find(current, 'f1120:2027:extended')).toMatchObject({ nominalDate: '2028-04-15', dueDate: '2028-04-18' });
  });

  it('does not give other forms the June exception', () => {
    const june: FiscalYearConfig = { type: 'month', startMonth: 7 };
    expect(find(incomeTaxDeadlines({ form: 'f1120s', fiscalYear: june }, 2026), 'f1120s:2026').dueDate).toBe('2026-09-15');
    expect(find(incomeTaxDeadlines({ form: 'f1120', fiscalYear: { type: 'month', startMonth: 10 } }, 2026), 'f1120:2026').dueDate).toBe('2027-01-15');
  });

  it('uses the 15th of the 5th month for Form 990 and Form 8868', () => {
    const items = incomeTaxDeadlines({ form: 'f990' }, 2026);
    expect(find(items, 'f990:2026')).toMatchObject({ nominalDate: '2027-05-15', dueDate: '2027-05-17' });
    expect(find(items, 'f990:2026:extended')).toMatchObject({ dueDate: '2027-11-15', extensionForm: 'Form 8868' });
  });

  it('treats a 52-53-week year as ending in its end month', () => {
    const nearest: FiscalYearConfig = { type: 'fifty_two_fifty_three', endMonth: 12, weekday: 6, rule: 'nearest' };
    const items = incomeTaxDeadlines({ form: 'f1120s', fiscalYear: nearest }, 2026); // ends 2 January 2027
    expect(find(items, 'f1120s:2026')).toMatchObject({ dueDate: '2027-03-15', periodEnd: '2027-01-02' });
  });

  it('moves the April deadline with DC Emancipation Day', () => {
    const items = incomeTaxDeadlines({ form: 'sch_c' }, 2021);
    expect(find(items, 'sch_c:2021')).toMatchObject({ nominalDate: '2022-04-15', dueDate: '2022-04-18' });
  });
});

describe('taxCalendar', () => {
  it('lists an S corporation year in date order', () => {
    expect(pairs(taxCalendar({ form: 'f1120s' }, 2027))).toEqual([
      ['2027-01-15', '1040es:2026:q4'],
      ['2027-02-01', '1099_misc_recipient:2026'],
      ['2027-02-01', '1099_nec_irs:2026'],
      ['2027-02-01', '1099_nec_recipient:2026'],
      ['2027-03-01', '1099_misc_irs_paper:2026'],
      ['2027-03-15', 'f1120s:2026'],
      ['2027-03-31', '1099_misc_irs_electronic:2026'],
      ['2027-04-15', '1040es:2027:q1'],
      ['2027-06-15', '1040es:2027:q2'],
      ['2027-09-15', '1040es:2027:q3'],
      ['2027-09-15', 'f1120s:2026:extended'],
    ]);
  });

  it('gives C corporations installments instead of 1040-ES', () => {
    const items = taxCalendar({ form: 'f1120' }, 2026);
    expect(items.some((item) => item.form === '1040es')).toBe(false);
    expect(items.filter((item) => item.kind === 'estimated_tax').map((item) => item.dueDate)).toEqual([
      '2026-04-15',
      '2026-06-15',
      '2026-09-15',
      '2026-12-15',
    ]);
    expect(find(items, 'f1120:2025').dueDate).toBe('2026-04-15');
    expect(find(items, 'f1120:2025:extended').dueDate).toBe('2026-10-15');
  });

  it('can leave out 1099s and add Form 945', () => {
    expect(taxCalendar({ form: 'f1065', files1099: false }, 2027).some((item) => item.kind === 'information_return')).toBe(false);
    const withHolding = taxCalendar({ form: 'f1065', hasBackupWithholding: true }, 2027);
    expect(find(withHolding, '945:2026').dueDate).toBe('2027-02-01');
  });

  it('adds payroll items as informational when the entity has payroll', () => {
    const items = taxCalendar({ form: 'f1120s', hasPayroll: true }, 2027);
    const payroll = items.filter((item) => item.kind === 'payroll');
    expect(pairs(payroll)).toEqual([
      ['2027-02-01', '940:2026'],
      ['2027-02-01', '941:2026:q4'],
      ['2027-02-01', 'w2:2026'],
      ['2027-04-30', '941:2027:q1'],
      ['2027-08-02', '941:2027:q2'],
      ['2027-11-01', '941:2027:q3'],
    ]);
    expect(payroll.every((item) => item.informational)).toBe(true);
    expect(taxCalendar({ form: 'f1120s' }, 2027).some((item) => item.kind === 'payroll')).toBe(false);
  });

  it('merges sales tax agency periods into the calendar', () => {
    const agency: SalesTaxAgencyInput = {
      id: 'ag1',
      stateCode: 'TX',
      filingFrequency: 'quarterly',
      dueDay: 20,
      firstPeriodStart: '2026-01-01',
    };
    const items = taxCalendar({ form: 'sch_c', files1099: false }, 2026, { agencies: [agency] });
    expect(items.filter((item) => item.kind === 'sales_tax').map((item) => [item.dueDate, item.key])).toEqual([
      ['2026-04-20', 'sales_tax:ag1:2026-03-31'],
      ['2026-07-20', 'sales_tax:ag1:2026-06-30'],
      ['2026-10-20', 'sales_tax:ag1:2026-09-30'],
    ]);
  });

  it('has unique keys', () => {
    const items = taxCalendar({ form: 'f1065', hasPayroll: true, hasBackupWithholding: true }, 2027);
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });
});

describe('1099 and payroll deadlines', () => {
  it('rolls tax year 2026 information returns to 1 February 2027', () => {
    const items = information1099Deadlines(2026);
    expect(find(items, '1099_nec_recipient:2026')).toMatchObject({ nominalDate: '2027-01-31', dueDate: '2027-02-01' });
    expect(find(items, '1099_nec_irs:2026').dueDate).toBe('2027-02-01');
    expect(find(items, '1099_misc_irs_paper:2026')).toMatchObject({ nominalDate: '2027-02-28', dueDate: '2027-03-01' });
    expect(find(items, '1099_misc_irs_electronic:2026').dueDate).toBe('2027-03-31');
  });

  it('dates the payroll forms of a year', () => {
    expect(payrollDeadlines(2026).map((item) => [item.key, item.dueDate])).toEqual([
      ['941:2026:q1', '2026-04-30'],
      ['941:2026:q2', '2026-07-31'],
      ['941:2026:q3', '2026-11-02'],
      ['941:2026:q4', '2027-02-01'],
      ['940:2026', '2027-02-01'],
      ['w2:2026', '2027-02-01'],
    ]);
  });
});

describe('agencyDeadlines', () => {
  const quarterly: SalesTaxAgencyInput = { id: 'A', stateCode: 'WA', filingFrequency: 'quarterly', dueDay: 20, firstPeriodStart: '2026-01-01' };
  const monthly: SalesTaxAgencyInput = { id: 'B', stateCode: 'CA', filingFrequency: 'monthly', dueDay: 'last', firstPeriodStart: '2026-01-01' };

  it('produces periods with start, end and due date inside the window', () => {
    const items = agencyDeadlines([quarterly, monthly], '2026-10-01', '2026-11-30');
    expect(items.map((item) => [item.dueDate, item.key, item.periodStart, item.periodEnd])).toEqual([
      ['2026-10-20', 'sales_tax:A:2026-09-30', '2026-07-01', '2026-09-30'],
      // 31 October 2026 is a Saturday
      ['2026-11-02', 'sales_tax:B:2026-09-30', '2026-09-01', '2026-09-30'],
      ['2026-11-30', 'sales_tax:B:2026-10-31', '2026-10-01', '2026-10-31'],
    ]);
    expect(items[1]).toMatchObject({ nominalDate: '2026-10-31', agencyId: 'B', stateCode: 'CA', kind: 'sales_tax' });
  });

  it('handles semiannual and annual grids and a short first period', () => {
    const semi: SalesTaxAgencyInput = { id: 'S', filingFrequency: 'semiannual', dueDay: 15, firstPeriodStart: '2026-01-01' };
    expect(agencyDeadlines([semi], '2026-01-01', '2027-03-01').map((item) => [item.key, item.dueDate])).toEqual([
      ['sales_tax:S:2026-06-30', '2026-07-15'],
      ['sales_tax:S:2026-12-31', '2027-01-15'],
    ]);
    const annual: SalesTaxAgencyInput = { id: 'Y', filingFrequency: 'annual', dueDay: 31, firstPeriodStart: '2025-03-15' };
    const [first, second] = agencyDeadlines([annual], '2026-01-01', '2027-12-31');
    expect(first).toMatchObject({ key: 'sales_tax:Y:2026-02-28', periodStart: '2025-03-15', dueDate: '2026-03-31' });
    expect(second).toMatchObject({ key: 'sales_tax:Y:2027-02-28', periodStart: '2026-03-01', dueDate: '2027-03-31' });
  });

  it('stops at the end of the registration and skips closed or unstarted agencies', () => {
    const ended: SalesTaxAgencyInput = { ...quarterly, id: 'E', registeredUntil: '2026-06-30' };
    expect(agencyDeadlines([ended], '2026-01-01', '2026-12-31').map((item) => item.key)).toEqual([
      'sales_tax:E:2026-03-31',
      'sales_tax:E:2026-06-30',
    ]);
    expect(agencyDeadlines([{ ...quarterly, status: 'closed' }, { ...quarterly, firstPeriodStart: null }], '2026-01-01', '2026-12-31')).toEqual([]);
  });

  it('clamps a due day past the end of the month', () => {
    const late: SalesTaxAgencyInput = { id: 'L', filingFrequency: 'monthly', dueDay: 31, firstPeriodStart: '2026-01-01' };
    const [january] = agencyDeadlines([late], '2026-02-01', '2026-03-31');
    expect(january).toMatchObject({ nominalDate: '2026-02-28', dueDate: '2026-03-02' }); // 28 Feb 2026 is a Saturday
    expect(january?.key).toBe('sales_tax:L:2026-01-31');
  });
});

describe('daysUntil', () => {
  it('counts days to a deadline', () => {
    expect(daysUntil('2026-10-08', '2026-10-15')).toBe(7);
    expect(daysUntil('2026-10-08', '2026-10-01')).toBe(-7);
  });
});
