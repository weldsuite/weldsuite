import { describe, expect, it } from 'vitest';
import { columnIndex, parseCsv, parseDate, parseMoney } from './csv';
import { PayrollImportError, buildGlLines, buildPayrollLines, emptyTotals, validateTotals } from './journal';
import { flattenCsvMapping, expandCsvMapping, csvMappingSchema } from './mapping';
import { normalizeGustoPayroll } from './gusto';
import type { EntityAccounts } from '../accounting-posting';

describe('parseCsv', () => {
  it('reads quoted fields, doubled quotes, CRLF, a BOM and skips blank rows', () => {
    const parsed = parseCsv('﻿Name,Memo,Amount\r\n"Smith, Jo","said ""hi""",1\r\n\r\n,,\r\nLee,,2');
    expect(parsed.headers).toEqual(['Name', 'Memo', 'Amount']);
    expect(parsed.rows).toEqual([
      ['Smith, Jo', 'said "hi"', '1'],
      ['Lee', '', '2'],
    ]);
  });

  it('detects semicolon and tab delimiters', () => {
    expect(parseCsv('a;b\n1;2').rows).toEqual([['1', '2']]);
    expect(parseCsv('a\tb\n1\t2').rows).toEqual([['1', '2']]);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(parseCsv('a,b\n"line 1\nline 2",x').rows).toEqual([['line 1\nline 2', 'x']]);
  });

  it('finds a column by header, ignoring case and spaces', () => {
    expect(columnIndex(['Pay Date', 'Net'], ' pay date ')).toBe(0);
    expect(columnIndex(['Pay Date'], 'missing')).toBe(-1);
    expect(columnIndex(['Pay Date'], undefined)).toBe(-1);
  });
});

describe('parseMoney', () => {
  it('reads the formats payroll reports use', () => {
    expect(parseMoney('1,234.56')).toBe(1234.56);
    expect(parseMoney('$1,234.56')).toBe(1234.56);
    expect(parseMoney('(1,234.56)')).toBe(-1234.56);
    expect(parseMoney('1234.56-')).toBe(-1234.56);
    expect(parseMoney('-12.5')).toBe(-12.5);
    expect(parseMoney('1.234,56')).toBe(1234.56);
    expect(parseMoney('0.1')).toBe(0.1);
    expect(parseMoney('7500')).toBe(7500);
  });

  it('treats empty and dashes as nothing and rejects words', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney(' - ')).toBeNull();
    expect(parseMoney(undefined)).toBeNull();
    expect(() => parseMoney('twelve')).toThrow(/not an amount/);
  });
});

describe('parseDate', () => {
  it('reads ISO, US slash dates, two-digit years and month names', () => {
    expect(parseDate('2026-01-15')).toBe('2026-01-15');
    expect(parseDate('2026-01-15T00:00:00Z')).toBe('2026-01-15');
    expect(parseDate('1/5/2026')).toBe('2026-01-05');
    expect(parseDate('01/15/26')).toBe('2026-01-15');
    expect(parseDate('15/01/2026', 'dmy')).toBe('2026-01-15');
    expect(parseDate('Jan 15, 2026')).toBe('2026-01-15');
    expect(parseDate('2026/01/15')).toBe('2026-01-15');
  });

  it('refuses things that are not dates', () => {
    expect(parseDate('13/45/2026')).toBeNull();
    expect(parseDate('02/30/2026')).toBeNull();
    expect(parseDate('soon')).toBeNull();
    expect(parseDate('')).toBeNull();
  });
});

describe('payroll journal', () => {
  const accounts = (roles: Record<string, string>): EntityAccounts => {
    const row = (id: string) => ({ id, code: id, name: id }) as unknown as ReturnType<EntityAccounts['byId']>;
    const byId = new Set(['bank', 'wages', 'tax', 'liab', 'benefits']);
    return {
      byId: (id) => (id && byId.has(id) ? row(id) : undefined),
      byRole: (role) => (roles[role] ? row(roles[role]!) : undefined),
      byCode: () => undefined,
      bySubtype: () => undefined,
    };
  };
  const totals = { ...emptyTotals(), grossWages: 1000, employerTaxes: 76.5, employeeTaxes: 200, employeeDeductions: 50, netPay: 750 };

  it('balances: expenses against liabilities and the bank account', () => {
    const lines = buildPayrollLines(totals, accounts({ payroll_wages_expense: 'wages', payroll_tax_expense: 'tax', payroll_liabilities: 'liab' }), { net_pay: 'bank' }, 'Payroll');
    expect(lines.map((l) => [l.accountId, l.debit ?? 0, l.credit ?? 0])).toEqual([
      ['wages', 1000, 0],
      ['tax', 76.5, 0],
      ['liab', 0, 326.5],
      ['bank', 0, 750],
    ]);
    const debit = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    const credit = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100));
  });

  it('uses mapped accounts over the chart roles and only needs accounts for amounts that exist', () => {
    const lines = buildPayrollLines(
      { ...emptyTotals(), grossWages: 100, netPay: 100 },
      accounts({}),
      { gross_wages: 'wages', net_pay: 'bank' },
      'Payroll',
    );
    expect(lines.map((l) => l.accountId)).toEqual(['wages', 'bank']);
  });

  it('refuses a missing account, a missing bank account and totals that do not balance', () => {
    expect(() => buildPayrollLines(totals, accounts({}), { net_pay: 'bank' }, 'x')).toThrow(/gross_wages/);
    expect(() => buildPayrollLines(totals, accounts({ payroll_wages_expense: 'wages', payroll_tax_expense: 'tax', payroll_liabilities: 'liab' }), {}, 'x')).toThrow(/net_pay/);
    expect(() => validateTotals({ ...totals, netPay: 700 })).toThrow(/does not balance.*off by 50\.00/);
    expect(() => validateTotals({ ...totals, netPay: -1 })).toThrow(PayrollImportError);
    expect(() => validateTotals(emptyTotals())).toThrow(/no amounts/);
    expect(() => buildPayrollLines(totals, accounts({ payroll_tax_expense: 'tax', payroll_liabilities: 'liab' }), { net_pay: 'elsewhere', gross_wages: 'wages' }, 'x')).toThrow(/does not belong/);
  });

  it('a general-ledger payroll must balance', () => {
    expect(buildGlLines([{ accountId: 'a', debit: 10, credit: 0 }, { accountId: 'b', debit: 0, credit: 10, memo: 'pay' }], 'Payroll')).toHaveLength(2);
    expect(() => buildGlLines([{ accountId: 'a', debit: 10, credit: 0 }, { accountId: 'b', debit: 0, credit: 9.99 }], 'Payroll')).toThrow(/off by 0\.01/);
    expect(() => buildGlLines([], 'Payroll')).toThrow(/no amounts/);
  });
});

describe('CSV mapping storage', () => {
  it('flattens and expands a mapping without losing anything', () => {
    const mapping = csvMappingSchema.parse({
      shape: 'summary',
      columns: { payDate: 'Date', grossWages: 'Gross', netPay: 'Net', employerTaxes: 'ER taxes' },
      accounts: { net_pay: 'acc_1', gross_wages: 'acc_2' },
      dateFormat: 'dmy',
    });
    const flat = flattenCsvMapping(mapping);
    expect(flat).toMatchObject({ shape: 'summary', dateFormat: 'dmy', 'col.payDate': 'Date', 'acc.net_pay': 'acc_1' });
    expect(expandCsvMapping(flat)).toEqual(mapping);
    expect(expandCsvMapping(null)).toBeNull();
    expect(expandCsvMapping({ shape: 'summary' })).toBeNull();
  });

  it('rejects an unknown payroll category', () => {
    expect(csvMappingSchema.safeParse({ shape: 'summary', columns: { payDate: 'a', grossWages: 'b', netPay: 'c' }, accounts: { bonus: 'x' } }).success).toBe(false);
  });
});

describe('Gusto payroll totals', () => {
  const base = {
    payroll_uuid: 'p-1',
    processed: true,
    check_date: '2026-02-13',
    pay_period: { start_date: '2026-02-01', end_date: '2026-02-15' },
    totals: { gross_pay: '10000.00', net_pay: '7500.00', employee_taxes: '2100.00', employer_taxes: '765.00', benefits: '300.00', employee_benefits_deductions: '250.00', other_deductions: '150.00', reimbursements: '10.00' },
  };

  it('maps the totals', () => {
    expect(normalizeGustoPayroll(base)).toMatchObject({
      externalId: 'p-1',
      payDate: '2026-02-13',
      periodStart: '2026-02-01',
      periodEnd: '2026-02-15',
      totals: { grossWages: 10000, netPay: 7500, employeeTaxes: 2100, employerTaxes: 765, employerBenefits: 300, employeeDeductions: 400, reimbursements: 10, ownersDraw: 0 },
    });
  });

  it('skips what it cannot use, with the reason', () => {
    expect(normalizeGustoPayroll({ ...base, processed: false })).toMatchObject({ skip: expect.stringMatching(/not processed/), externalId: 'p-1' });
    expect(normalizeGustoPayroll({ ...base, totals: undefined })).toMatchObject({ skip: expect.stringMatching(/no totals/) });
    expect(normalizeGustoPayroll({ ...base, check_date: undefined })).toMatchObject({ skip: expect.stringMatching(/check date/) });
    expect(normalizeGustoPayroll({ totals: {} })).toMatchObject({ skip: expect.stringMatching(/no id/), externalId: null });
    expect(normalizeGustoPayroll(null)).toMatchObject({ skip: expect.stringMatching(/no id/) });
  });

  it('accepts older id spellings and numeric amounts', () => {
    const result = normalizeGustoPayroll({ ...base, payroll_uuid: undefined, payroll_id: 42, totals: { gross_pay: 100, net_pay: 100 } });
    expect(result).toMatchObject({ externalId: '42', totals: { grossWages: 100, netPay: 100 } });
  });
});
