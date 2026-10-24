import { describe, expect, it } from 'vitest';
import { parseInput, type ParseInputOptions } from './input';
import { formatValue, NL_LOCALE } from './number-format';

const opts: ParseInputOptions = { currentYear: 2026 };
const value = (text: string, o: ParseInputOptions = opts) => parseInput(text, o);

describe('parseInput', () => {
  it('recognises formulas, literals and blanks', () => {
    expect(value('=SUM(A1:A3)')).toEqual({ kind: 'formula', formula: 'SUM(A1:A3)' });
    expect(value('=')).toEqual({ kind: 'value', value: '=' });
    expect(value("'=not a formula")).toEqual({ kind: 'value', value: '=not a formula' });
    expect(value("'0123")).toEqual({ kind: 'value', value: '0123' });
    expect(value('')).toEqual({ kind: 'value', value: null });
    expect(value('   ')).toEqual({ kind: 'value', value: '   ' });
    expect(value('hello world')).toEqual({ kind: 'value', value: 'hello world' });
  });

  it('parses booleans and error literals', () => {
    expect(value('true')).toEqual({ kind: 'value', value: true });
    expect(value('False')).toEqual({ kind: 'value', value: false });
    expect(value('#N/A')).toEqual({ kind: 'value', value: { kind: 'error', code: '#N/A' } });
    expect(value('#div/0!')).toEqual({ kind: 'value', value: { kind: 'error', code: '#DIV/0!' } });
  });

  it('parses numbers', () => {
    expect(value('42')).toEqual({ kind: 'value', value: 42 });
    expect(value(' -3.5 ')).toEqual({ kind: 'value', value: -3.5 });
    expect(value('+7')).toEqual({ kind: 'value', value: 7 });
    expect(value('.5')).toEqual({ kind: 'value', value: 0.5 });
    expect(value('007')).toEqual({ kind: 'value', value: 7 });
    expect(value('(100)')).toEqual({ kind: 'value', value: -100 });
    expect(value('1,234')).toEqual({ kind: 'value', value: 1234, numFmt: '#,##0' });
    expect(value('1,234.5')).toEqual({ kind: 'value', value: 1234.5, numFmt: '#,##0.00' });
    expect(value('1e3')).toEqual({ kind: 'value', value: 1000, numFmt: '0.00E+00' });
    expect(value('1.5E-2')).toEqual({ kind: 'value', value: 0.015, numFmt: '0.00E+00' });
    expect(value('1,23')).toEqual({ kind: 'value', value: '1,23' });
    expect(value('1.2.3')).toEqual({ kind: 'value', value: '1.2.3' });
    expect(value('555-1234')).toEqual({ kind: 'value', value: '555-1234' });
  });

  it('parses percentages', () => {
    expect(value('12%')).toEqual({ kind: 'value', value: 0.12, numFmt: '0%' });
    expect(value('12.5%')).toEqual({ kind: 'value', value: 0.125, numFmt: '0.00%' });
    expect(value('-5%')).toEqual({ kind: 'value', value: -0.05, numFmt: '0%' });
  });

  it('parses currency', () => {
    expect(value('$1,234.50')).toEqual({ kind: 'value', value: 1234.5, numFmt: '"$"#,##0.00' });
    expect(value('$12')).toEqual({ kind: 'value', value: 12, numFmt: '"$"#,##0' });
    expect(value('-$5')).toEqual({ kind: 'value', value: -5, numFmt: '"$"#,##0' });
    expect(value('$-5')).toEqual({ kind: 'value', value: -5, numFmt: '"$"#,##0' });
    expect(value('($5.25)')).toEqual({ kind: 'value', value: -5.25, numFmt: '"$"#,##0.00' });
    expect(value('€ 12')).toEqual({ kind: 'value', value: 12, numFmt: '"€ "#,##0' });
    expect(value('12 €')).toEqual({ kind: 'value', value: 12, numFmt: '#,##0" €"' });
    expect(value('12€')).toEqual({ kind: 'value', value: 12, numFmt: '#,##0"€"' });
    const p = value('$1,234.50');
    if (p.kind === 'value') expect(formatValue(p.value, p.numFmt).text).toBe('$1,234.50');
  });

  it('uses the locale separators', () => {
    const nl: ParseInputOptions = { locale: NL_LOCALE, currentYear: 2026 };
    expect(value('1,5', nl)).toEqual({ kind: 'value', value: 1.5 });
    expect(value('1.234,50', nl)).toEqual({ kind: 'value', value: 1234.5, numFmt: '#,##0.00' });
    expect(value('€ 1.234,50', nl)).toEqual({ kind: 'value', value: 1234.5, numFmt: '"€ "#,##0.00' });
    expect(value('12,5%', nl)).toEqual({ kind: 'value', value: 0.125, numFmt: '0.00%' });
    expect(value('15/1/2026', nl)).toEqual({ kind: 'value', value: 46037, numFmt: 'd/m/yyyy' });
    expect(value('15 mei 2026', nl)).toEqual({ kind: 'value', value: 46157, numFmt: 'd mmm yyyy' });
    expect(value('1 maart 2026', nl)).toEqual({ kind: 'value', value: 46082, numFmt: 'd mmmm yyyy' });
  });

  it('parses mixed fractions', () => {
    expect(value('1 1/2')).toEqual({ kind: 'value', value: 1.5, numFmt: '# ?/?' });
    expect(value('0 3/16')).toEqual({ kind: 'value', value: 0.1875, numFmt: '# ??/??' });
  });

  it('parses dates', () => {
    expect(value('2026-01-15')).toEqual({ kind: 'value', value: 46037, numFmt: 'yyyy-mm-dd' });
    expect(value('1/15/2026')).toEqual({ kind: 'value', value: 46037, numFmt: 'm/d/yyyy' });
    expect(value('15/1/2026', { dateOrder: 'dmy' })).toEqual({ kind: 'value', value: 46037, numFmt: 'd/m/yyyy' });
    expect(value('15-01-2026')).toEqual({ kind: 'value', value: 46037, numFmt: 'dd-mm-yyyy' });
    expect(value('1/2/2026', { dateOrder: 'dmy' })).toMatchObject({ value: 46054 });
    expect(value('1/2/2026')).toMatchObject({ value: 46024 });
    expect(value('15 jan 2026')).toEqual({ kind: 'value', value: 46037, numFmt: 'd mmm yyyy' });
    expect(value('15-Jan-26')).toEqual({ kind: 'value', value: 46037, numFmt: 'd-mmm-yy' });
    expect(value('Jan 15, 2026')).toEqual({ kind: 'value', value: 46037, numFmt: 'mmm d, yyyy' });
    expect(value('January 15 2026')).toEqual({ kind: 'value', value: 46037, numFmt: 'mmmm d yyyy' });
    expect(value('Thursday, January 15, 2026')).toMatchObject({ value: 46037 });
    expect(value('jan 2026')).toEqual({ kind: 'value', value: 46023, numFmt: 'mmm yyyy' });
    expect(value('1/15/99')).toMatchObject({ value: 36175 });
    expect(value('1/15/29')).toMatchObject({ value: 47133 });
    expect(value('1/15')).toEqual({ kind: 'value', value: 46037, numFmt: 'd-mmm' });
    expect(value('2/29/1900')).toMatchObject({ value: 60 });
    expect(value('2/30/2026')).toEqual({ kind: 'value', value: '2/30/2026' });
    expect(value('13/13/2026')).toEqual({ kind: 'value', value: '13/13/2026' });
  });

  it('parses times and date-times', () => {
    expect(value('13:45')).toEqual({ kind: 'value', value: 13.75 / 24, numFmt: 'h:mm' });
    expect(value('13:45:10')).toEqual({ kind: 'value', value: (13 * 3600 + 45 * 60 + 10) / 86400, numFmt: 'h:mm:ss' });
    expect(value('1:45 PM')).toEqual({ kind: 'value', value: 13.75 / 24, numFmt: 'h:mm AM/PM' });
    expect(value('12:30 am')).toEqual({ kind: 'value', value: 0.5 / 24, numFmt: 'h:mm AM/PM' });
    expect(value('3 pm')).toEqual({ kind: 'value', value: 15 / 24, numFmt: 'h AM/PM' });
    expect(value('25:30')).toEqual({ kind: 'value', value: 25.5 / 24, numFmt: '[h]:mm' });
    expect(value('10:61')).toEqual({ kind: 'value', value: '10:61' });
    expect(value('2026-01-15 13:45')).toEqual({ kind: 'value', value: 46037 + 13.75 / 24, numFmt: 'yyyy-mm-dd h:mm' });
    expect(value('2026-01-15T13:45:00')).toEqual({ kind: 'value', value: 46037 + 13.75 / 24, numFmt: 'yyyy-mm-dd h:mm:ss' });
    expect(value('1/15/2026 1:45 PM')).toEqual({ kind: 'value', value: 46037 + 13.75 / 24, numFmt: 'm/d/yyyy h:mm AM/PM' });
    const p = value('1:45 PM');
    if (p.kind === 'value') expect(formatValue(p.value, p.numFmt).text).toBe('1:45 PM');
  });
});
