import { intlLocaleOf } from '@/app/weldflow/project/[projectId]/raid/_lib/locale';
import type { Language } from '@weldsuite/i18n/locales';

export function formatDate(iso: string | null | undefined, language: Language): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(intlLocaleOf(language), { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

/** A decimal string or number as money; without a currency just the number. */
export function formatMoney(value: string | number | null | undefined, currency: string | null | undefined, language: Language): string {
  if (value === null || value === undefined || value === '') return '';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value);
  const locale = intlLocaleOf(language);
  if (!currency) return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(amount);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
  } catch {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(amount)} ${currency}`;
  }
}
