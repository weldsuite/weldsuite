/**
 * Formatting for the payroll screens. Money arrives in two shapes: payslip
 * lines and run totals are integer cents, stored amounts (compensation,
 * payslip totals, filing amounts) are decimal strings in currency units.
 */

import { formatDate, formatMoney } from '../../components/shared';

export { humanizeKey, parseNumberInput } from './text';

export function formatCents(cents: number | null | undefined, currency: string): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  return formatMoney(cents / 100, currency);
}

export function formatDecimal(value: string | number | null | undefined, currency: string): string {
  if (value === null || value === undefined || value === '') return '—';
  const amount = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(amount) ? formatMoney(amount, currency) : '—';
}

/** Cents → a signed variance label such as "+€ 12.30", for the net-pay variance column. */
export function formatSignedDecimal(value: number, currency: string): string {
  const formatted = formatMoney(Math.abs(value), currency);
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `−${formatted}`;
  return formatted;
}

export function periodRange(start: string, end: string): string {
  return `${formatDate(start)} – ${formatDate(end)}`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 3 })}%`;
}

/** Hours, days or any decimal quantity on a payslip or input line. */
export function formatQuantity(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const amount = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(amount) ? amount.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(value);
}

/** The current calendar year, for the year filters. */
export function currentYear(): number {
  return new Date().getFullYear();
}

/** A list of years to pick from: next year back to five years ago. */
export function yearOptions(): number[] {
  const year = currentYear();
  return Array.from({ length: 7 }, (_, i) => year + 1 - i);
}


/** Filings carry no currency of their own: Dutch ones are in euros, US ones in dollars. */
export function countryCurrency(country: 'NL' | 'US'): string {
  return country === 'NL' ? 'EUR' : 'USD';
}
