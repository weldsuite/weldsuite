import { formatCompactCurrency, formatCurrency } from '@/lib/currency';
import { formatDate, formatShortDate } from '@/lib/date';

import { useI18n } from './provider';

/** Date and money formatters bound to the active profile language. */
export function useLocaleFormatters() {
  const { intlLocale } = useI18n();

  return {
    intlLocale,
    formatCurrency: (
      amount: number | string | null | undefined,
      currency = 'EUR',
    ) => formatCurrency(amount, currency, intlLocale),
    formatCompactCurrency: (
      amount: number | string | null | undefined,
      currency = 'EUR',
    ) => formatCompactCurrency(amount, currency, intlLocale),
    formatDate: (value: string | null | undefined) => formatDate(value, intlLocale),
    formatShortDate: (value: string | null | undefined) => formatShortDate(value, intlLocale),
  };
}
