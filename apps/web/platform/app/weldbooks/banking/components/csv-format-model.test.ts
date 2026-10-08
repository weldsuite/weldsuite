import { describe, expect, it } from 'vitest';
import {
  detectCsvDelimiter,
  draftFromFormat,
  draftProblems,
  EMPTY_CSV_DRAFT,
  formatFromDraft,
  readCsvTable,
  type CsvFormatDraft,
} from './csv-format-model';
import type { CsvFormat } from '@/lib/api/domains/weldbooks-banking';

const CHASE = [
  'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #',
  'DEBIT,01/05/2026,"AMAZON, INC",-25.40,ACH_DEBIT,1000.00,',
  'CREDIT,01/06/2026,PAYROLL,2500.00,ACH_CREDIT,3500.00,',
  'CHECK,01/07/2026,CHECK 1042,-300.00,CHECK_PAID,3200.00,1042',
].join('\n');

const BOFA = [
  'Account Summary',
  'Beginning balance as of 01/01/2026,"1,000.00"',
  '',
  'Date;Description;Debit;Credit',
  '01/05/2026;Coffee;4,50;',
  '01/06/2026;Refund;;10,00',
].join('\n');

function draft(overrides: Partial<Omit<CsvFormatDraft, 'columns'>> & { columns?: Partial<CsvFormatDraft['columns']> } = {}): CsvFormatDraft {
  return {
    ...EMPTY_CSV_DRAFT,
    ...overrides,
    columns: { ...EMPTY_CSV_DRAFT.columns, date: 1, description: 2, amount: 3, ...overrides.columns },
  };
}

describe('readCsvTable', () => {
  it('reads the header and sample rows, keeping a quoted comma in one cell', () => {
    const table = readCsvTable(CHASE, { delimiter: null, skipRows: 0, hasHeader: true });
    expect(table.delimiter).toBe(',');
    expect(table.headers).toEqual(['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance', 'Check or Slip #']);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0][2]).toBe('AMAZON, INC');
  });

  it('skips preamble rows before the header and detects a semicolon delimiter', () => {
    const table = readCsvTable(BOFA, { delimiter: null, skipRows: 2, hasHeader: true });
    expect(table.delimiter).toBe(';');
    expect(table.headers).toEqual(['Date', 'Description', 'Debit', 'Credit']);
    expect(table.rows).toEqual([
      ['01/05/2026', 'Coffee', '4,50', ''],
      ['01/06/2026', 'Refund', '', '10,00'],
    ]);
  });

  it('names columns by position when the file has no header row', () => {
    const table = readCsvTable('01/05/2026,Coffee,-4.50\n01/06/2026,Refund,10.00', { delimiter: null, skipRows: 0, hasHeader: false });
    expect(table.headers).toEqual(['Column 1', 'Column 2', 'Column 3']);
    expect(table.rows).toHaveLength(2);
  });

  it('ignores a byte-order mark in front of the header', () => {
    const table = readCsvTable(`${String.fromCodePoint(0xfeff)}Date,Amount\n01/05/2026,1.00`, { delimiter: null, skipRows: 0, hasHeader: true });
    expect(table.headers).toEqual(['Date', 'Amount']);
  });

  it('honours an explicit delimiter over the detected one', () => {
    expect(detectCsvDelimiter('a;b;c\n1;2;3')).toBe(';');
    const table = readCsvTable('a;b;c\n1;2;3', { delimiter: ',', skipRows: 0, hasHeader: true });
    expect(table.headers).toEqual(['a;b;c']);
  });
});

describe('formatFromDraft: column mapping to the request payload', () => {
  const table = readCsvTable(CHASE, { delimiter: null, skipRows: 0, hasHeader: true });

  it('names mapped columns by their header text and drops unmapped ones', () => {
    const format = formatFromDraft(draft({ columns: { checkNumber: 6 } }), table.headers);
    expect(format).toEqual({
      dateFormat: 'MDY',
      decimalSeparator: '.',
      thousandsSeparator: ',',
      negativeStyle: 'minus',
      columns: { date: 'Posting Date', description: 'Description', amount: 'Amount', checkNumber: 'Check or Slip #' },
      hasHeader: true,
      skipRows: 0,
    });
  });

  it('points at a column by index when its header is not unique', () => {
    const headers = ['Date', 'Amount', 'Amount', 'Memo'];
    const format = formatFromDraft(draft({ columns: { date: 0, description: 3, amount: 2 } }), headers);
    expect(format?.columns).toEqual({ date: 'Date', description: 'Memo', amount: 2 });
  });

  it('uses indexes when the file has no header row', () => {
    const format = formatFromDraft(draft({ hasHeader: false, columns: { date: 0, description: 1, amount: 2 } }), ['Column 1', 'Column 2', 'Column 3']);
    expect(format?.columns).toEqual({ date: 0, description: 1, amount: 2 });
    expect(format?.hasHeader).toBe(false);
  });

  it('sends debit and credit columns, and no amount column, for separate debit and credit columns', () => {
    const headers = ['Date', 'Description', 'Debit', 'Credit'];
    const format = formatFromDraft(
      draft({
        negativeStyle: 'debit_credit_columns',
        decimalSeparator: ',',
        thousandsSeparator: '.',
        dateFormat: 'DMY',
        delimiter: ';',
        skipRows: 3,
        columns: { date: 0, description: 1, amount: 1, debit: 2, credit: 3 },
      }),
      headers,
    );
    expect(format).toEqual({
      dateFormat: 'DMY',
      decimalSeparator: ',',
      thousandsSeparator: '.',
      negativeStyle: 'debit_credit_columns',
      columns: { date: 'Date', description: 'Description', debit: 'Debit', credit: 'Credit' },
      hasHeader: true,
      skipRows: 3,
      delimiter: ';',
    });
  });

  it('leaves the delimiter out when it is detected from the file', () => {
    const format = formatFromDraft(draft(), table.headers) as CsvFormat;
    expect('delimiter' in format).toBe(false);
  });

  it('is null until the required columns are mapped', () => {
    expect(formatFromDraft(draft({ columns: { amount: null } }), table.headers)).toBeNull();
    expect(draftProblems(draft({ columns: { amount: null } }))).toEqual(['amount']);
    expect(draftProblems(draft({ columns: { date: null, description: null } }))).toEqual(['date', 'description']);
    expect(draftProblems(draft({ negativeStyle: 'debit_credit_columns', columns: { debit: null, credit: null } }))).toEqual(['debit_credit']);
  });

  it('refuses identical decimal and thousands separators', () => {
    const same = draft({ decimalSeparator: '.', thousandsSeparator: '.' });
    expect(draftProblems(same)).toContain('separators');
    expect(formatFromDraft(same, table.headers)).toBeNull();
  });
});

describe('draftFromFormat', () => {
  const headers = ['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance', 'Check or Slip #'];

  it('resolves header text (ignoring case and punctuation) and indexes to column positions', () => {
    const format: CsvFormat = {
      dateFormat: 'MDY',
      decimalSeparator: '.',
      thousandsSeparator: ',',
      negativeStyle: 'parentheses',
      columns: { date: 'posting date', description: 2, amount: 'AMOUNT', checkNumber: 'Check or Slip #', payee: 'Missing' },
      hasHeader: true,
      skipRows: 1,
      delimiter: ',',
    };
    const result = draftFromFormat(format, headers);
    expect(result.columns).toMatchObject({ date: 1, description: 2, amount: 3, checkNumber: 6, payee: null });
    expect(result).toMatchObject({ negativeStyle: 'parentheses', skipRows: 1, delimiter: ',' });
  });

  it('round-trips a draft through the format', () => {
    const original = draft({ dateFormat: 'YMD', thousandsSeparator: ' ', columns: { reference: 5, payee: 0 } });
    const format = formatFromDraft(original, headers);
    expect(format).not.toBeNull();
    expect(draftFromFormat(format as CsvFormat, headers)).toEqual(original);
  });
});
