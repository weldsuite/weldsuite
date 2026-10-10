import type { Locale } from '@/lib/i18n';

/** A stored amount (decimal string) or a plain number, as a currency string in the viewer's language. */
export function formatMoney(amount: string | number, currency: string, locale: Locale): string {
  const value = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(value)) return String(amount);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value);
  } catch {
    // An unknown currency code makes Intl throw; show the plain figure instead.
    return `${value.toFixed(2)} ${currency}`;
  }
}

/** `married_jointly` → `Married jointly`. Last-resort label for a code nobody translated. */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase() : key;
}
