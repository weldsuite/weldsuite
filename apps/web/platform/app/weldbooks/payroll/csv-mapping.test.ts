import { describe, expect, it } from 'vitest';
import type { CsvImportResult, CsvMapping, ImportedPayroll } from '@/lib/api/domains/weldbooks-assets';
import {
  buildCsvMapping,
  distinctValues,
  draftFromFile,
  draftFromSaved,
  emptyDraft,
  guessDateFormat,
  guessGlColumns,
  guessSummaryColumns,
  judgeDryRun,
  missingAccounts,
  missingColumns,
  parseCsv,
  payrollBalance,
  type MappingDraft,
} from './csv-mapping';

const SUMMARY_CSV = [
  'Pay Date,Gross Wages,Employer Taxes,Employee Taxes Withheld,Employee Deductions,Net Pay,Period Start,Period End',
  '01/15/2026,"10,000.00",765.00,"1,900.00",100.00,"8,000.00",01/01/2026,01/15/2026',
  '01/31/2026,"10,000.00",765.00,"1,900.00",100.00,"8,000.00",01/16/2026,01/31/2026',
].join('\r\n');

describe('parseCsv', () => {
  it('reads quoted fields, CRLF line ends and trims the header', () => {
    const parsed = parseCsv(SUMMARY_CSV);
    expect(parsed.headers[0]).toBe('Pay Date');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]?.[1]).toBe('10,000.00');
  });

  it('detects a semicolon delimiter and drops a byte order mark', () => {
    const parsed = parseCsv('﻿Date;Account;Debit;Credit\n2026-01-15;Wages;100,00;0');
    expect(parsed.headers).toEqual(['Date', 'Account', 'Debit', 'Credit']);
    expect(parsed.rows[0]).toEqual(['2026-01-15', 'Wages', '100,00', '0']);
  });

  it('keeps doubled quotes and commas inside a quoted field', () => {
    const parsed = parseCsv('Memo,Amount\n"Bonus, ""Q1""",5');
    expect(parsed.rows[0]).toEqual(['Bonus, "Q1"', '5']);
  });

  it('skips blank lines', () => {
    expect(parseCsv('A,B\n\n1,2\n   ,  \n').rows).toEqual([['1', '2']]);
  });

  it('lists the distinct values of a column in file order, ignoring the header case', () => {
    const parsed = parseCsv('Date,Account,Debit,Credit\n1,Wages,5,0\n1,Bank,0,5\n2,Wages,6,0');
    expect(distinctValues(parsed, 'account')).toEqual(['Wages', 'Bank']);
    expect(distinctValues(parsed, 'Missing')).toEqual([]);
  });
});

describe('column guessing', () => {
  it('matches a payroll summary export by its headers, each header once', () => {
    const guessed = guessSummaryColumns(parseCsv(SUMMARY_CSV).headers);
    expect(guessed).toEqual({
      payDate: 'Pay Date',
      grossWages: 'Gross Wages',
      employerTaxes: 'Employer Taxes',
      employeeTaxes: 'Employee Taxes Withheld',
      employeeDeductions: 'Employee Deductions',
      netPay: 'Net Pay',
      periodStart: 'Period Start',
      periodEnd: 'Period End',
    });
  });

  it('matches a general ledger export, keeping the account column apart from the memo', () => {
    expect(guessGlColumns(['Date', 'Account Name', 'Memo', 'Debit', 'Credit'])).toEqual({
      date: 'Date',
      account: 'Account Name',
      memo: 'Memo',
      debit: 'Debit',
      credit: 'Credit',
    });
  });

  it('guesses day-first dates only when a date cannot be month first', () => {
    const dmy = parseCsv('Pay Date,Net\n25/01/2026,5\n02/02/2026,5');
    const mdy = parseCsv('Pay Date,Net\n01/25/2026,5');
    expect(guessDateFormat(dmy, 'Pay Date')).toBe('dmy');
    expect(guessDateFormat(mdy, 'Pay Date')).toBe('auto');
    expect(guessDateFormat(mdy, undefined)).toBe('auto');
  });

  it('takes the shape a file looks like', () => {
    expect(draftFromFile(parseCsv(SUMMARY_CSV)).shape).toBe('summary');
    expect(draftFromFile(parseCsv('Date,Account,Debit,Credit\n2026-01-15,Wages,100,0')).shape).toBe('gl');
  });
});

describe('buildCsvMapping', () => {
  const summaryDraft = (): MappingDraft => ({
    ...emptyDraft(),
    summaryColumns: { payDate: 'Pay Date', grossWages: 'Gross Wages', netPay: 'Net Pay', employerTaxes: 'Employer Taxes', reference: undefined },
    summaryAccounts: { net_pay: 'acc_bank', gross_wages: 'acc_wages', employer_taxes: undefined },
  });

  it('is null until the required columns are chosen', () => {
    expect(buildCsvMapping(emptyDraft())).toBeNull();
    expect(missingColumns(emptyDraft())).toEqual(['payDate', 'grossWages', 'netPay']);
    expect(missingColumns({ ...emptyDraft(), shape: 'gl' })).toEqual(['date', 'account', 'debit', 'credit']);
  });

  it('builds a summary mapping with only the chosen columns and the accounts that were set', () => {
    expect(buildCsvMapping(summaryDraft())).toEqual({
      shape: 'summary',
      dateFormat: 'auto',
      columns: { payDate: 'Pay Date', grossWages: 'Gross Wages', netPay: 'Net Pay', employerTaxes: 'Employer Taxes' },
      accounts: { gross_wages: 'acc_wages', net_pay: 'acc_bank' },
    });
  });

  it('asks for the account the net pay was paid from, and nothing else, before a summary can be checked', () => {
    expect(missingAccounts(emptyDraft())).toEqual(['net_pay']);
    expect(missingAccounts(summaryDraft())).toEqual([]);
    expect(missingAccounts({ ...emptyDraft(), shape: 'gl' })).toEqual([]);
  });

  it('builds a general ledger mapping with the labels the user assigned', () => {
    const draft: MappingDraft = {
      ...emptyDraft(),
      shape: 'gl',
      dateFormat: 'dmy',
      glColumns: { date: 'Date', account: 'Account', debit: 'Debit', credit: 'Credit', memo: '' },
      glAccounts: { Wages: 'acc_wages', 'Payroll clearing': '' },
    };
    expect(buildCsvMapping(draft)).toEqual({
      shape: 'gl',
      dateFormat: 'dmy',
      columns: { date: 'Date', account: 'Account', debit: 'Debit', credit: 'Credit' },
      accounts: { Wages: 'acc_wages' },
    });
  });
});

describe('draftFromSaved', () => {
  const saved: CsvMapping = {
    shape: 'summary',
    dateFormat: 'mdy',
    columns: { payDate: 'pay date', grossWages: 'Gross Wages', netPay: 'NET PAY' },
    accounts: { net_pay: 'acc_bank' },
  };

  it('applies a saved mapping whose columns all exist in the file, whatever their case', () => {
    const draft = draftFromSaved(saved, parseCsv(SUMMARY_CSV));
    expect(draft).toMatchObject({ shape: 'summary', dateFormat: 'mdy', summaryAccounts: { net_pay: 'acc_bank' } });
    expect(draft?.summaryColumns.payDate).toBe('pay date');
  });

  it('leaves a saved mapping alone when the file does not have its columns', () => {
    expect(draftFromSaved(saved, parseCsv('Date,Account,Debit,Credit\n1,2,3,4'))).toBeNull();
  });
});

describe('dry run verdict', () => {
  const payroll = (payDate: string, debit: number, credit: number): ImportedPayroll => ({
    importId: null,
    payDate,
    journalEntryId: null,
    entryNumber: null,
    summary: {},
    totalDebit: debit,
    lines: [
      { accountId: 'acc_wages', debit, credit: 0 },
      { accountId: 'acc_bank', debit: 0, credit },
    ],
  });
  const result = (imports: ImportedPayroll[], failed: CsvImportResult['failed'] = []): CsvImportResult => ({
    shape: 'summary',
    dryRun: true,
    imports,
    duplicates: [],
    failed,
  });

  it('adds the lines of an entry in whole cents', () => {
    expect(payrollBalance(payroll('2026-01-15', 0.1 + 0.2, 0.3))).toEqual({ debit: 0.3, credit: 0.3, balanced: true });
    expect(payrollBalance(payroll('2026-01-15', 100, 99.99)).balanced).toBe(false);
  });

  it('allows the import when every entry balances and something would post', () => {
    expect(judgeDryRun(result([payroll('2026-01-15', 100, 100), payroll('2026-01-31', 50.5, 50.5)]))).toEqual({
      unbalanced: [],
      toPost: 2,
      failed: 0,
      canImport: true,
    });
  });

  it('blocks the import when an entry does not balance, naming it', () => {
    const verdict = judgeDryRun(result([payroll('2026-01-15', 100, 100), payroll('2026-01-31', 100, 90)]));
    expect(verdict.unbalanced).toEqual(['2026-01-31']);
    expect(verdict.canImport).toBe(false);
  });

  it('blocks the import when a payroll failed or there is nothing to post', () => {
    expect(judgeDryRun(result([payroll('2026-01-15', 1, 1)], [{ payDate: '2026-01-15', error: 'twice' }])).canImport).toBe(false);
    expect(judgeDryRun(result([])).canImport).toBe(false);
    expect(judgeDryRun(null).canImport).toBe(false);
  });
});
