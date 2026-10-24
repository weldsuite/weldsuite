import { EN_LOCALE, NL_LOCALE, type FormatLocale, type FormulaLocale } from '@weldsuite/sheets-engine';

export type NumberFormatKey =
  | 'automatic'
  | 'plainText'
  | 'number'
  | 'percent'
  | 'scientific'
  | 'accounting'
  | 'currency'
  | 'date'
  | 'time'
  | 'dateTime'
  | 'duration';

/** Format codes for the toolbar's format menu, with an example of each. `null` clears the format. */
export function numberFormats(language: string): Record<NumberFormatKey, { code: string | null; example: string }> {
  const dutch = language === 'nl';
  const date = dutch ? 'd-m-yyyy' : 'm/d/yyyy';
  return {
    automatic: { code: null, example: '' },
    plainText: { code: '@', example: '' },
    number: { code: '#,##0.00', example: dutch ? '1.000,12' : '1,000.12' },
    percent: { code: '0.00%', example: dutch ? '10,12%' : '10.12%' },
    scientific: { code: '0.00E+00', example: dutch ? '1,01E+03' : '1.01E+03' },
    accounting: { code: '_("€"* #,##0.00_);_("€"* (#,##0.00);_("€"* "-"??_);_(@_)', example: dutch ? '€ (1.000,12)' : '€ (1,000.12)' },
    currency: { code: '"€ "#,##0.00', example: dutch ? '€ 1.000,12' : '€ 1,000.12' },
    date: { code: date, example: dutch ? '26-9-2026' : '9/26/2026' },
    time: { code: 'h:mm:ss', example: '15:59:00' },
    dateTime: { code: `${date} h:mm:ss`, example: dutch ? '26-9-2026 15:59:00' : '9/26/2026 15:59:00' },
    duration: { code: '[h]:mm:ss', example: '24:01:00' },
  };
}

/** Display and input conventions for the user's language. */
export function sheetLocale(language: string): { format: FormatLocale; formula: FormulaLocale } {
  if (language === 'nl') return { format: NL_LOCALE, formula: { decimal: ',' } };
  return { format: EN_LOCALE, formula: { decimal: '.' } };
}
