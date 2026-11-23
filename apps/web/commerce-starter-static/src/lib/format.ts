import { formatMoney, formatTaxRate } from '@weldsuite/commerce-sdk';

/** An amount in the shop's locale; shown as it came when it isn't a decimal string. */
export function money(amount: string, currency: string, locale: string): string {
  try {
    return formatMoney(amount, currency, { locale });
  } catch {
    return amount;
  }
}

export function taxRate(rate: string, locale: string): string {
  try {
    return formatTaxRate(rate, locale);
  } catch {
    return `${rate}%`;
  }
}

/** "NL" → "Netherlands". */
export function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function date(iso: string, locale: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(at);
}

/** Words for API status values ("on_invoice" → "On invoice"). */
export function statusLabel(status: string): string {
  const words = status.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
