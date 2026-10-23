import { describe, expect, it } from 'vitest';
import { err } from '../values';
import { EN_LOCALE, formatCategory, formatValue, isDateFormat, NL_LOCALE } from './number-format';

const fmt = (v: number | string, code: string | undefined, locale = EN_LOCALE) => formatValue(v, code, locale).text;

describe('formatValue: General and non-numbers', () => {
  it('formats General', () => {
    expect(fmt(1234.5, undefined)).toBe('1234.5');
    expect(fmt(1234.5, 'General')).toBe('1234.5');
    expect(fmt(1234.5, 'general', NL_LOCALE)).toBe('1234,5');
    expect(fmt(1e20, undefined)).toBe('1E+20');
    expect(fmt(0.1 + 0.2, undefined)).toBe('0.3');
  });

  it('ignores the code for booleans, errors and blanks', () => {
    expect(formatValue(true, '0.00').text).toBe('TRUE');
    expect(formatValue(err('#N/A'), '0.00').text).toBe('#N/A');
    expect(formatValue(null, '0.00').text).toBe('');
  });

  it('falls back to General for invalid codes', () => {
    expect(fmt(5, '"unterminated')).toBe('5');
    expect(fmt(5, '[Red')).toBe('5');
    expect(fmt(5, '0;0;0;0;0')).toBe('5');
  });
});

describe('formatValue: numbers', () => {
  it('fills digit placeholders', () => {
    expect(fmt(1234.5, '#,##0.00')).toBe('1,234.50');
    expect(fmt(1234567.891, '#,##0')).toBe('1,234,568');
    expect(fmt(1234567.891, '#,##0.00')).toBe('1,234,567.89');
    expect(fmt(1e15, '#,##0')).toBe('1,000,000,000,000,000');
    expect(fmt(0, '#,##0')).toBe('0');
    expect(fmt(0, '#')).toBe('');
    expect(fmt(123, '00000')).toBe('00123');
    expect(fmt(5, '#.##')).toBe('5.');
    expect(fmt(5.1, '0.##')).toBe('5.1');
    expect(fmt(1.5, '0.0#')).toBe('1.5');
    expect(fmt(1.567, '0.0#')).toBe('1.57');
    expect(fmt(0.5, '#.00')).toBe('.50');
    expect(fmt(1.5, '0.??')).toBe('1.5 ');
    expect(fmt(5551234567, '(###) ###-####')).toBe('(555) 123-4567');
    expect(fmt(123456789, '000-00-0000')).toBe('123-45-6789');
  });

  it('rounds half away from zero on the decimal value', () => {
    expect(fmt(0.005, '0.00')).toBe('0.01');
    expect(fmt(1.005, '0.00')).toBe('1.01');
    expect(fmt(2.675, '0.00')).toBe('2.68');
    expect(fmt(-0.005, '0.00')).toBe('-0.01');
    expect(fmt(0.05, '0.0')).toBe('0.1');
    expect(fmt(2.5, '0')).toBe('3');
    expect(fmt(9.995, '0.00')).toBe('10.00');
    expect(fmt(-0.4, '0')).toBe('-0');
  });

  it('scales by trailing commas and percent', () => {
    expect(fmt(12345678, '0.0,,"M"')).toBe('12.3M');
    expect(fmt(1234567, '#,##0,')).toBe('1,235');
    expect(fmt(1500, '0.0,"K"')).toBe('1.5K');
    expect(fmt(0.125, '0%')).toBe('13%');
    expect(fmt(0.125, '0.00%')).toBe('12.50%');
    expect(fmt(0.07, '0%')).toBe('7%');
  });

  it('renders scientific notation', () => {
    expect(fmt(12345, '0.00E+00')).toBe('1.23E+04');
    expect(fmt(0.000123, '0.00E+00')).toBe('1.23E-04');
    expect(fmt(0, '0.00E+00')).toBe('0.00E+00');
    expect(fmt(-12345, '0.0E+0')).toBe('-1.2E+4');
    expect(fmt(12345, '##0.0E+0')).toBe('12.3E+3');
    expect(fmt(9.999, '0.00E+00')).toBe('1.00E+01');
    expect(fmt(12345, '0.00e-00')).toBe('1.23e04');
  });

  it('renders fractions', () => {
    expect(fmt(1.5, '# ?/?')).toBe('1 1/2');
    expect(fmt(0.5, '# ?/?')).toBe(' 1/2');
    expect(fmt(2, '# ?/?')).toBe('2    ');
    expect(fmt(0, '# ?/?')).toBe('0    ');
    expect(fmt(-1.25, '# ?/?')).toBe('-1 1/4');
    expect(fmt(1.25, '# ??/16')).toBe('1  4/16');
    expect(fmt(0.75, '?/?')).toBe('3/4');
    expect(fmt(1.5, '?/?')).toBe('3/2');
    expect(fmt(Math.PI, '# ??/??')).toBe('3 14/99');
    expect(fmt(0.5, '# ??/??')).toBe('  1/2 ');
    expect(fmt(0.999, '# ?/?')).toBe('1    ');
  });

  it('chooses sections and drops the sign in the negative one', () => {
    expect(fmt(-5, '0;(0)')).toBe('(5)');
    expect(fmt(5, '0;(0)')).toBe('5');
    expect(fmt(0, '0;(0);"zero"')).toBe('zero');
    expect(fmt(0, '0;-0;;@')).toBe('');
    expect(fmt(-5, '0.00')).toBe('-5.00');
    expect(fmt(-1234.5, '"$"#,##0.00')).toBe('-$1,234.50');
    expect(fmt(-5, '"x"')).toBe('-x');
  });

  it('applies conditions', () => {
    const code = '[>=100]"big";[<0]"neg";"small"';
    expect(fmt(150, code)).toBe('big');
    expect(fmt(-5, code)).toBe('neg');
    expect(fmt(50, code)).toBe('small');
    expect(fmt(-5, '[<0]0.0;0')).toBe('5.0');
    expect(fmt(-5, '[>=100]0.0;0')).toBe('-5');
    expect(fmt(150, '[>=100]0.0;0')).toBe('150.0');
  });

  it('returns colours', () => {
    expect(formatValue(-5, '0.00;[Red]-0.00')).toEqual({ text: '-5.00', color: '#ff0000' });
    expect(formatValue(5, '0.00;[Red]-0.00')).toEqual({ text: '5.00' });
    expect(formatValue(5, '[Blue]0').color).toBe('#0000ff');
    expect(formatValue(5, '[Color10]0').color).toBe('#008000');
    expect(formatValue(5, '[color 3]0').color).toBe('#ff0000');
  });

  it('handles literals, spacing, fill and currency tags', () => {
    expect(fmt(5, '_(0_)')).toBe(' 5 ');
    expect(fmt(1234, '* #,##0')).toBe('1,234');
    expect(fmt(5, '\\$0')).toBe('$5');
    expect(fmt(5, '0 "kg"')).toBe('5 kg');
    expect(fmt(1234.5, '[$€-413] #,##0.00')).toBe('€ 1,234.50');
    expect(fmt(1234.5, '[$€-413] #,##0.00', NL_LOCALE)).toBe('€ 1.234,50');
    expect(fmt(5, '[$USD] 0')).toBe('USD 5');
    expect(fmt(5, '[$-409]0.0')).toBe('5.0');
    expect(fmt(5, '[Red]General')).toBe('5');
  });

  it('formats with the NL locale', () => {
    expect(fmt(1234.5, '#,##0.00', NL_LOCALE)).toBe('1.234,50');
    expect(fmt(0.125, '0.0%', NL_LOCALE)).toBe('12,5%');
    expect(fmt(1234567, '#,##0', NL_LOCALE)).toBe('1.234.567');
  });
});

describe('formatValue: text', () => {
  it('uses the text section', () => {
    expect(fmt('abc', '0;-0;"zero";"text: "@')).toBe('text: abc');
    expect(fmt('Bob', '"Name: "@')).toBe('Name: Bob');
    expect(fmt('abc', '0.00')).toBe('abc');
    expect(fmt(5, '@')).toBe('5');
    expect(fmt('x', ';;;')).toBe('');
    expect(fmt(5, ';;;')).toBe('');
  });
});

describe('formatValue: dates and times', () => {
  it('formats dates', () => {
    expect(fmt(45672, 'dd-mm-yyyy')).toBe('15-01-2025');
    expect(fmt(46037, 'yyyy-mm-dd')).toBe('2026-01-15');
    expect(fmt(46037, 'm/d/yy')).toBe('1/15/26');
    expect(fmt(46037, 'dddd, mmmm d, yyyy')).toBe('Thursday, January 15, 2026');
    expect(fmt(46037, 'ddd d mmm')).toBe('Thu 15 Jan');
    expect(fmt(46037, 'mmmmm')).toBe('J');
    expect(fmt(46037, 'DD/MM/YYYY')).toBe('15/01/2026');
    expect(fmt(60, 'yyyy-mm-dd')).toBe('1900-02-29');
    expect(fmt(61, 'yyyy-mm-dd')).toBe('1900-03-01');
    expect(fmt(0, 'yyyy-mm-dd')).toBe('1900-01-00');
    expect(fmt(46037, 'dddd d mmmm yyyy', NL_LOCALE)).toBe('donderdag 15 januari 2026');
    expect(fmt(46037, 'd mmm yy', NL_LOCALE)).toBe('15 jan 26');
  });

  it('formats times with the minutes rule', () => {
    expect(fmt(0.5, 'h:mm AM/PM')).toBe('12:00 PM');
    expect(fmt(0, 'h:mm AM/PM')).toBe('12:00 AM');
    expect(fmt(0.75, 'h:mm a/p')).toBe('6:00 p');
    expect(fmt(0.75, 'hh:mm A/P')).toBe('06:00 P');
    expect(fmt(0.5, 'h:mm AM/PM', NL_LOCALE)).toBe('12:00 p.m.');
    expect(fmt(0.75 + 5 / 86400, 'h:mm:ss')).toBe('18:00:05');
    expect(fmt(125 / 86400, 'mm:ss')).toBe('02:05');
    expect(fmt(46037.5, 'yyyy-mm-dd hh:mm')).toBe('2026-01-15 12:00');
    expect(fmt(46037 + 9.5 / 24, 'd-m-yyyy h:mm')).toBe('15-1-2026 9:30');
  });

  it('rounds to the shown precision', () => {
    expect(fmt(0.5 + 1.25 / 86400, 'h:mm:ss.000')).toBe('12:00:01.250');
    expect(fmt(0.5 + 1.26 / 86400, 'ss.0')).toBe('01.3');
    expect(fmt(0.999999999, 'h:mm:ss')).toBe('0:00:00');
    expect(fmt(46037.999999999, 'yyyy-mm-dd')).toBe('2026-01-16');
    expect(fmt(23 / 24 + 59 / 1440 + 59.4 / 86400, 'h:mm')).toBe('23:59');
  });

  it('formats elapsed time', () => {
    expect(fmt(1.5, '[h]:mm')).toBe('36:00');
    expect(fmt(1.5 + 30 / 86400, '[h]:mm:ss')).toBe('36:00:30');
    expect(fmt(125 / 86400, '[mm]:ss')).toBe('02:05');
    expect(fmt(3725 / 86400, '[ss]')).toBe('3725');
    expect(fmt(3725 / 86400, '[m]')).toBe('62');
  });

  it('overflows for dates it cannot show', () => {
    expect(formatValue(-1, 'yyyy-mm-dd')).toEqual({ text: '########', overflow: true });
    expect(formatValue(3e6, 'yyyy')).toMatchObject({ overflow: true });
  });
});

describe('formatCategory', () => {
  it('classifies codes', () => {
    expect(formatCategory(undefined)).toBe('general');
    expect(formatCategory('General')).toBe('general');
    expect(formatCategory('0.00')).toBe('number');
    expect(formatCategory('#,##0')).toBe('number');
    expect(formatCategory('0%')).toBe('percent');
    expect(formatCategory('"$"#,##0.00')).toBe('currency');
    expect(formatCategory('[$€-413] #,##0')).toBe('currency');
    expect(formatCategory('0.00E+00')).toBe('scientific');
    expect(formatCategory('# ?/?')).toBe('fraction');
    expect(formatCategory('dd-mm-yyyy')).toBe('date');
    expect(formatCategory('h:mm')).toBe('time');
    expect(formatCategory('h:mm AM/PM')).toBe('time');
    expect(formatCategory('yyyy-mm-dd h:mm')).toBe('datetime');
    expect(formatCategory('[h]:mm')).toBe('duration');
    expect(formatCategory('@')).toBe('text');
    expect(formatCategory('"bad')).toBe('general');
  });

  it('detects date formats', () => {
    expect(isDateFormat('mm:ss')).toBe(true);
    expect(isDateFormat('d-mmm')).toBe(true);
    expect(isDateFormat('0.00')).toBe(false);
    expect(isDateFormat(undefined)).toBe(false);
  });
});
