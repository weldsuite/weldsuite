import { formatValue } from '@weldsuite/sheets-engine';

/** Status-bar number: grouped, up to 2 decimals, no trailing decimal separator for whole numbers. */
export function formatStat(n: number, locale?: Parameters<typeof formatValue>[2]): string {
  const r = Math.round(n * 100) / 100;
  const tenths = Math.round(r * 10);
  const pattern = Number.isInteger(r) ? '#,##0' : Math.abs(r * 10 - tenths) < 1e-9 ? '#,##0.0' : '#,##0.00';
  return formatValue(r, pattern, locale).text;
}
