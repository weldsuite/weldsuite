import { formatValue } from '@weldsuite/sheets-engine';

/** Status-bar number: grouped, up to 2 decimals, no trailing decimal separator for whole numbers. */
export function formatStat(n: number, locale?: Parameters<typeof formatValue>[2]): string {
  const r = Math.round(n * 100) / 100;
  return formatValue(r, statPattern(r), locale).text;
}

/** As many decimals as `r` (already rounded to 2) needs. */
function statPattern(r: number): string {
  if (Number.isInteger(r)) return '#,##0';
  return Math.abs(r * 10 - Math.round(r * 10)) < 1e-9 ? '#,##0.0' : '#,##0.00';
}
