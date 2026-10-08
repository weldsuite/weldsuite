import { describe, expect, it } from 'vitest';
import { CsvFormatRequiredError, detectFormat, parseBankFile } from './index';
import {
  detectCsvFormat,
  parseCsvAmount,
  parseCsvDate,
  parseCsvWithFormat,
  readCsvRecords,
} from './csv-format';
import type { CsvFormat } from './types';

/** US bank export: month-first dates, parentheses for money out, thousands commas, a quoted comma. */
const PARENTHESES_MDY = `Account Summary for Business Checking
Generated 02/01/2026

Posting Date,Description,Amount,Check Number,Balance
01/05/2026,"OFFICE LANDLORD LLC, RENT",(1250.00),1042,"3,750.00"
01/12/2026,ACH CREDIT ACME CORP INV 2001,"4,800.50",,"8,550.50"
01/13/2026,"CARD PURCHASE ""STAPLES""",(64.20),,"8,486.30"
1/31/2026,MONTHLY SERVICE FEE,(12.00),,"8,474.30"
`;

const US_FORMAT: CsvFormat = {
  dateFormat: 'MDY',
  decimalSeparator: '.',
  thousandsSeparator: ',',
  negativeStyle: 'parentheses',
  columns: { date: 'Posting Date', description: 'Description', amount: 'Amount', checkNumber: 'Check Number' },
  hasHeader: true,
  skipRows: 2,
};

describe('CSV amounts and dates', () => {
  const us = { decimalSeparator: '.', thousandsSeparator: ',' } as const;
  const eu = { decimalSeparator: ',', thousandsSeparator: '.' } as const;

  it('reads every way of writing a negative', () => {
    expect(parseCsvAmount('(1,234.56)', us)).toBe(-1234.56);
    expect(parseCsvAmount('-$1,234.56', us)).toBe(-1234.56);
    expect(parseCsvAmount('$1,234.56-', us)).toBe(-1234.56);
    expect(parseCsvAmount('1,234.56 DR', us)).toBe(-1234.56);
    expect(parseCsvAmount('+12.5', us)).toBe(12.5);
    expect(parseCsvAmount('1.234,56', eu)).toBe(1234.56);
    expect(parseCsvAmount('(1.234,56)', eu)).toBe(-1234.56);
    expect(parseCsvAmount('1 234,56', { decimalSeparator: ',', thousandsSeparator: ' ' })).toBe(1234.56);
    expect(parseCsvAmount('abc', us)).toBeNull();
    expect(parseCsvAmount('', us)).toBeNull();
  });

  it('reads the declared date order and never guesses', () => {
    expect(parseCsvDate('01/02/2026', 'MDY')).toBe('2026-01-02');
    expect(parseCsvDate('01/02/2026', 'DMY')).toBe('2026-02-01');
    expect(parseCsvDate('2026-01-02', 'DMY')).toBe('2026-01-02');
    expect(parseCsvDate('1/2/26', 'MDY')).toBe('2026-01-02');
    expect(parseCsvDate('01/02/2026 12:00:00 AM', 'MDY')).toBe('2026-01-02');
    expect(parseCsvDate('Jan 5, 2026', 'MDY')).toBe('2026-01-05');
    expect(parseCsvDate('5-Jan-2026', 'MDY')).toBe('2026-01-05');
    expect(parseCsvDate('20260105', 'MDY')).toBe('2026-01-05');
    expect(parseCsvDate('13/01/2026', 'MDY')).toBeNull();
    expect(parseCsvDate('02/30/2026', 'MDY')).toBeNull();
  });
});

describe('CSV records', () => {
  it('keeps quoted commas, doubled quotes and line breaks inside a cell', () => {
    const records = readCsvRecords('a,"b, c","say ""hi""","line1\nline2"\n\nx,y,z,w\n', ',');
    expect(records.map((r) => r.cells)).toEqual([
      ['a', 'b, c', 'say "hi"', 'line1\nline2'],
      ['x', 'y', 'z', 'w'],
    ]);
    expect(records.map((r) => r.line)).toEqual([1, 4]);
  });
});

describe('parseCsvWithFormat', () => {
  it('reads parentheses negatives, MDY dates, thousands commas and check numbers after a preamble', () => {
    const result = parseCsvWithFormat(PARENTHESES_MDY, US_FORMAT);
    expect(result.errors).toEqual([]);
    expect(result.transactions).toHaveLength(4);
    const [rent, deposit, staples, fee] = result.transactions;
    expect(rent).toMatchObject({ date: '2026-01-05', amount: -1250, checkNumber: '1042', description: 'OFFICE LANDLORD LLC, RENT' });
    expect(deposit).toMatchObject({ date: '2026-01-12', amount: 4800.5 });
    expect(staples.description).toBe('CARD PURCHASE "STAPLES"');
    expect(fee).toMatchObject({ date: '2026-01-31', amount: -12 });
    expect(result.dateRange).toEqual({ from: '2026-01-05', to: '2026-01-31' });
  });

  it('reads the same dates day-first when the format says so', () => {
    const file = 'Date,Memo,Amount\n03/04/2026,Test,10.00\n';
    const base: CsvFormat = {
      dateFormat: 'MDY', decimalSeparator: '.', thousandsSeparator: ',', negativeStyle: 'minus',
      columns: { date: 'Date', description: 'Memo', amount: 'Amount' }, hasHeader: true, skipRows: 0,
    };
    expect(parseCsvWithFormat(file, base).transactions[0].date).toBe('2026-03-04');
    expect(parseCsvWithFormat(file, { ...base, dateFormat: 'DMY' }).transactions[0].date).toBe('2026-04-03');
  });

  it('reads separate debit and credit columns, semicolon delimited with decimal commas', () => {
    const file = [
      'Datum;Omschrijving;Debet;Credit',
      '15-01-2026;Hosting;1.234,56;',
      '16-01-2026;Klant betaling;;2.000,00',
      '17-01-2026;Footer;;',
    ].join('\n');
    const result = parseCsvWithFormat(file, {
      dateFormat: 'DMY', decimalSeparator: ',', thousandsSeparator: '.', negativeStyle: 'debit_credit_columns',
      columns: { date: 'Datum', description: 'Omschrijving', debit: 'Debet', credit: 'Credit' }, hasHeader: true, skipRows: 0,
    });
    expect(result.errors).toEqual([]);
    expect(result.transactions.map((t) => [t.date, t.amount])).toEqual([
      ['2026-01-15', -1234.56],
      ['2026-01-16', 2000],
    ]);
  });

  it('reads trailing minus and files without a header, by column position', () => {
    const file = '01/05/2026,-12.50,*,,COFFEE\n01/06/2026,100.00-,*,1043,REFUND REVERSAL\n';
    const result = parseCsvWithFormat(file, {
      dateFormat: 'MDY', decimalSeparator: '.', thousandsSeparator: ',', negativeStyle: 'trailing_minus',
      columns: { date: 0, amount: 1, checkNumber: 3, description: 4 }, hasHeader: false, skipRows: 0,
    });
    expect(result.transactions.map((t) => [t.amount, t.checkNumber, t.description])).toEqual([
      [-12.5, undefined, 'COFFEE'],
      [-100, '1043', 'REFUND REVERSAL'],
    ]);
  });

  it('reports unreadable rows and a missing column, and keeps the rest', () => {
    const file = 'Date,Memo,Amount\n01/05/2026,Fine,10.00\n13/45/2026,Bad date,5.00\n01/06/2026,Bad amount,ten\n';
    const format: CsvFormat = {
      dateFormat: 'MDY', decimalSeparator: '.', thousandsSeparator: ',', negativeStyle: 'minus',
      columns: { date: 'Date', description: 'Memo', amount: 'Amount' }, hasHeader: true, skipRows: 0,
    };
    const result = parseCsvWithFormat(file, format);
    expect(result.transactions).toHaveLength(1);
    expect(result.errors.map((e) => e.line)).toEqual([3, 4]);

    const missing = parseCsvWithFormat(file, { ...format, columns: { ...format.columns, amount: 'Total' } });
    expect(missing.transactions).toEqual([]);
    expect(missing.errors[0].message).toMatch(/Amount column "Total" was not found/);
  });
});

describe('detectCsvFormat', () => {
  it('proposes the US layout for a typical export and finds the header after a preamble', () => {
    const proposal = detectCsvFormat(PARENTHESES_MDY);
    expect(proposal.format).toMatchObject({
      dateFormat: 'MDY',
      decimalSeparator: '.',
      thousandsSeparator: ',',
      negativeStyle: 'parentheses',
      hasHeader: true,
      skipRows: 2,
      columns: { date: 'Posting Date', description: 'Description', amount: 'Amount', checkNumber: 'Check Number' },
    });
    // 01/05, 01/12, 01/13 and 1/31: the 31 can only be a day, so the order is known.
    expect(proposal.dateOrderAmbiguous).toBe(false);
    expect(parseCsvWithFormat(PARENTHESES_MDY, proposal.format).transactions).toHaveLength(4);
  });

  it('flags a file whose dates could be read either way', () => {
    const proposal = detectCsvFormat('Date,Description,Amount\n01/02/2026,A,1.00\n03/04/2026,B,2.00\n');
    expect(proposal.format.dateFormat).toBe('MDY');
    expect(proposal.dateOrderAmbiguous).toBe(true);
    expect(proposal.warnings.join(' ')).toMatch(/confirm the order/);
  });

  it('reads day-first and decimal commas from the data', () => {
    const proposal = detectCsvFormat('Date;Description;Amount\n15/01/2026;A;1.234,56\n16/01/2026;B;-2,50\n');
    expect(proposal.format).toMatchObject({ dateFormat: 'DMY', decimalSeparator: ',', thousandsSeparator: '.', delimiter: ';' });
    expect(proposal.dateOrderAmbiguous).toBe(false);
  });

  it('proposes debit and credit columns', () => {
    const proposal = detectCsvFormat('Date,Description,Debit,Credit,Balance\n01/15/2026,A,10.00,,90.00\n01/16/2026,B,,5.00,95.00\n');
    expect(proposal.format.negativeStyle).toBe('debit_credit_columns');
    expect(proposal.format.columns).toMatchObject({ debit: 'Debit', credit: 'Credit' });
    expect(proposal.format.columns.amount).toBeUndefined();
  });

  it('works out the columns of a file without a header', () => {
    const file = '"01/05/2026","-12.50","*","","COFFEE SHOP DOWNTOWN"\n"01/06/2026","100.00","*","","DEPOSIT FROM CLIENT"\n';
    const proposal = detectCsvFormat(file);
    expect(proposal.format.hasHeader).toBe(false);
    expect(proposal.format.columns).toMatchObject({ date: 0, amount: 1, description: 4 });
    const parsed = parseCsvWithFormat(file, proposal.format);
    expect(parsed.transactions.map((t) => t.amount)).toEqual([-12.5, 100]);
  });
});

describe('parseBankFile with CSV', () => {
  it('asks for a layout when the CSV is not a known bank export', () => {
    expect(detectFormat(PARENTHESES_MDY, 'activity.csv')).toBe('csv');
    let thrown: unknown;
    try {
      parseBankFile(PARENTHESES_MDY);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CsvFormatRequiredError);
    expect((thrown as CsvFormatRequiredError).proposal.format.dateFormat).toBe('MDY');
  });

  it('uses the confirmed layout, and still reads a known Dutch export without one', () => {
    const result = parseBankFile(PARENTHESES_MDY, 'csv', { csvFormat: US_FORMAT });
    expect(result.transactions).toHaveLength(4);

    const ing = [
      '"Datum","Naam / Omschrijving","Rekening","Tegenrekening","Code","Af Bij","Bedrag (EUR)","Mutatiesoort","Mededelingen"',
      '"20260105","Klant BV","NL91INGB0001234567","NL20INGB0007654321","OV","Bij","121,00","Overschrijving","Factuur 1"',
    ].join('\n');
    const dutch = parseBankFile(ing);
    expect(dutch.transactions).toHaveLength(1);
    expect(dutch.transactions[0]).toMatchObject({ date: '2026-01-05', amount: 121 });
  });
});
