import { describe, expect, it } from 'vitest';
import { EN_LOCALE, NL_LOCALE } from '@weldsuite/sheets-engine';
import { formatStat } from './stats-format';

describe('formatStat', () => {
  it('prints whole numbers without a decimal separator', () => {
    expect(formatStat(6, EN_LOCALE)).toBe('6');
    expect(formatStat(3, EN_LOCALE)).toBe('3');
    expect(formatStat(1234567, EN_LOCALE)).toBe('1,234,567');
  });
  it('shows up to two decimals', () => {
    expect(formatStat(591.04, EN_LOCALE)).toBe('591.04');
    expect(formatStat(2.5, EN_LOCALE)).toBe('2.5');
    expect(formatStat(10 / 3, EN_LOCALE)).toBe('3.33');
    expect(formatStat(2.999, EN_LOCALE)).toBe('3');
  });
  it('uses the workbook locale', () => {
    expect(formatStat(1234.5, NL_LOCALE)).toBe('1.234,5');
  });
});
