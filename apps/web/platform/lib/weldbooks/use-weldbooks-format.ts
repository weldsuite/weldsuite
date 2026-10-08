import { useCallback, useMemo } from 'react';
import { useCurrentEntityCurrency } from '@/hooks/use-current-entity-currency';
import { useUserPreferences } from '@/hooks/queries/use-settings-queries';
import { useI18n } from '@/lib/i18n/provider';
import {
  formatWeldbooksDate,
  formatWeldbooksDateTime,
  formatWeldbooksMonth,
  localToday,
  weldbooksDateLocale,
} from './format';

/**
 * The one money + date formatter for WeldBooks screens.
 *
 * - Money: the selected entity's currency and locale (a document can pass its
 *   own currency).
 * - Dates: the user's `dateFormat` preference when they chose one, otherwise
 *   the medium style of the UI language with the entity's region.
 * - `today()`: the calendar date in the user's time zone preference, else
 *   the browser's — never UTC.
 */
export function useWeldbooksFormat() {
  const { formatMoney, currency, entityCurrency, locale: entityLocale, entity } = useCurrentEntityCurrency();
  const { language } = useI18n();
  const { data: preferences } = useUserPreferences();

  const dateFormat = preferences?.dateFormat ?? null;
  // The column default is 'UTC', which would put "today" on the wrong day for
  // everyone east or west of it; only honour a zone that isn't the default.
  const timeZone = preferences?.timezone && preferences.timezone !== 'UTC' ? preferences.timezone : null;
  const dateLocale = useMemo(() => weldbooksDateLocale(language, entityLocale), [language, entityLocale]);

  const formatDate = useCallback(
    (value: string | Date | null | undefined, empty?: string) =>
      formatWeldbooksDate(value, { locale: dateLocale, dateFormat, empty }),
    [dateLocale, dateFormat],
  );

  const formatDateTime = useCallback(
    (value: string | Date | null | undefined, empty?: string) =>
      formatWeldbooksDateTime(value, { locale: dateLocale, timeZone, empty }),
    [dateLocale, timeZone],
  );

  const formatMonth = useCallback(
    (value: string | Date | null | undefined) => formatWeldbooksMonth(value, { locale: dateLocale }),
    [dateLocale],
  );

  const today = useCallback(() => localToday(timeZone), [timeZone]);

  return {
    formatMoney,
    formatDate,
    formatDateTime,
    formatMonth,
    today,
    currency,
    entityCurrency,
    entityLocale,
    dateLocale,
    entity,
  };
}
