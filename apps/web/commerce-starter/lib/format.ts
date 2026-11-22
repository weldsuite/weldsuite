import { formatMoney, formatTaxRate } from '@weldsuite/commerce-sdk';

/* Display helpers, usable on the server and in client components. */

export function money(amount: string, currency: string, locale: string): string {
  return formatMoney(amount, currency, { locale });
}

export function taxRate(rate: string, locale: string): string {
  return formatTaxRate(rate, locale);
}

export function date(iso: string, locale: string, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(at);
}

/** "NL" → "Netherlands". */
export function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Words for API status values ("on_invoice" → "On invoice"). */
export function statusLabel(status: string): string {
  const words = status.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
