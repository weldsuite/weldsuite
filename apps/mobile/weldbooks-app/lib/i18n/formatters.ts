import { useMemo } from 'react';

import { useOptionalAccountingEntity } from '@/contexts/AccountingEntityContext';
import {
  formatCompactCurrency,
  formatCurrency,
  parseAmount,
} from '@/lib/currency';
import {
  dateInputPlaceholder,
  formatDate,
  formatDateInput,
  formatShortDate,
  parseDateInput,
} from '@/lib/date';
import { resolveFormatLocale, resolveJurisdictionContext } from '@/lib/jurisdiction';

import { useI18n } from './provider';

/**
 * Money, dates and typed numbers for the screen's context.
 *
 * Money defaults to the active entity's base currency (a document passes its
 * own), and everything is formatted in the entity's locale: a US entity reads
 * $1,234.56 and 08/05/2026, a Dutch one €1.234,56 and 5 aug. 2026 (see
 * `resolveFormatLocale`).
 *
 * The functions only change identity when the language, currency or locale
 * does — not when the entity list refreshes — so a screen can list them as
 * effect dependencies without re-running (and re-fetching) on every refresh.
 */
export function useLocaleFormatters() {
  const { language } = useI18n();
  const activeEntity = useOptionalAccountingEntity()?.activeEntity ?? null;
  const { currency: entityCurrency, entityLocale } = resolveJurisdictionContext(activeEntity);

  return useMemo(() => {
    const intlLocale = resolveFormatLocale(language, entityLocale);

    return {
      /** The locale money and dates are formatted in. */
      intlLocale,
      /** The active entity's base currency. */
      currency: entityCurrency,
      formatCurrency: (amount: number | string | null | undefined, currency: string = entityCurrency) =>
        formatCurrency(amount, currency, intlLocale),
      formatCompactCurrency: (
        amount: number | string | null | undefined,
        currency: string = entityCurrency,
      ) => formatCompactCurrency(amount, currency, intlLocale),
      formatDate: (value: string | null | undefined) => formatDate(value, intlLocale),
      formatShortDate: (value: string | null | undefined) => formatShortDate(value, intlLocale),
      /** An amount the user typed. */
      parseAmount: (value: string) => parseAmount(value, intlLocale),
      /** Placeholder of a date field: MM/DD/YYYY for US entities, otherwise YYYY-MM-DD. */
      datePlaceholder: dateInputPlaceholder(intlLocale),
      /** A `YYYY-MM-DD` date as a date field shows it. */
      formatDateInput: (isoDate: string) => formatDateInput(isoDate, intlLocale),
      /** What a date field holds → `YYYY-MM-DD`, or null when it is not a real day. */
      parseDateInput: (text: string) => parseDateInput(text, intlLocale),
    };
  }, [language, entityCurrency, entityLocale]);
}
