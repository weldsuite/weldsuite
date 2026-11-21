import { describe, expect, it } from 'vitest';
import { formatValue } from '@weldsuite/sheets-engine';
import { numberFormats, sheetLocale, type NumberFormatKey } from './number-formats';

const SAMPLE = 1000.123;

describe('number format menu', () => {
  for (const language of ['en', 'nl']) {
    const locale = sheetLocale(language).format;
    const formats = numberFormats(language);

    it(`${language}: every example is what its code renders`, () => {
      const skip: NumberFormatKey[] = ['automatic', 'plainText', 'date', 'time', 'dateTime', 'duration'];
      for (const [key, { code, example }] of Object.entries(formats) as [NumberFormatKey, { code: string | null; example: string }][]) {
        if (skip.includes(key) || !code) continue;
        const text = formatValue(key === 'percent' ? SAMPLE / 100 : SAMPLE, code, locale).text;
        // Accounting pads with spaces; compare without them.
        expect(text.replace(/\s+/g, ' ').trim(), key).toBe(example);
      }
    });

    it(`${language}: percent is grouped`, () => {
      expect(formatValue(199.8, formats.percent.code ?? '', locale).text).toBe(language === 'nl' ? '19.980,00%' : '19,980.00%');
    });
  }

  it('negative currency follows the language', () => {
    expect(formatValue(-15.5, numberFormats('en').currency.code ?? '', sheetLocale('en').format).text).toBe('-€15.50');
    expect(formatValue(-15.5, numberFormats('nl').currency.code ?? '', sheetLocale('nl').format).text).toBe('€ -15,50');
  });
});
