/**
 * Locale-aware date helpers for the platform.
 *
 * The UI language (`useI18n().language`) picks both the date-fns `Locale`
 * (for `format(date, pattern, { locale })`) and the BCP 47 tag for `Intl`
 * formatters, so dates follow the language chosen in Settings > Appearance
 * instead of always rendering in US English.
 */
import { useCallback, useMemo } from 'react';
import { format as dateFnsFormat, type Locale } from 'date-fns';
import { enUS } from 'date-fns/locale/en-US';
import { es } from 'date-fns/locale/es';
import { fr } from 'date-fns/locale/fr';
import { nl } from 'date-fns/locale/nl';
import { localeConfig, type Language } from '@/lib/i18n/locales';
import { useI18n } from '@/lib/i18n/provider';

const DATE_FNS_LOCALES: Record<Language, Locale> = { en: enUS, nl, fr, es };

export function getDateFnsLocale(language: Language): Locale {
  return DATE_FNS_LOCALES[language] ?? enUS;
}

export function getIntlLocale(language: Language): string {
  return localeConfig[language]?.intlLocale ?? 'en-US';
}

type DateInput = Date | string | number | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Oct 12" / "12 okt" */
export function formatShortDate(value: DateInput, language: Language): string {
  const date = toDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat(getIntlLocale(language), { month: 'short', day: 'numeric' }).format(date);
}

/** "Oct 12, 2026" / "12 okt 2026" */
export function formatMediumDate(value: DateInput, language: Language): string {
  const date = toDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat(getIntlLocale(language), {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

/** "Fri, Oct 9, 2026" / "vr 9 okt 2026" */
export function formatWeekdayDate(value: DateInput, language: Language): string {
  const date = toDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat(getIntlLocale(language), {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

/** "Oct 2026" / "okt 2026" */
export function formatMonthYear(value: DateInput, language: Language): string {
  const date = toDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat(getIntlLocale(language), { month: 'short', year: 'numeric' }).format(date);
}

/**
 * Hook bundling the locale-aware date formatters for the current UI language.
 * The returned helpers are stable until the language changes.
 */
export function useDateLocale() {
  const { language } = useI18n();
  const dateFnsLocale = useMemo(() => getDateFnsLocale(language), [language]);
  const intlLocale = useMemo(() => getIntlLocale(language), [language]);

  const formatShort = useCallback((value: DateInput) => formatShortDate(value, language), [language]);
  const formatMedium = useCallback((value: DateInput) => formatMediumDate(value, language), [language]);
  const formatWeekday = useCallback((value: DateInput) => formatWeekdayDate(value, language), [language]);
  const formatMonthYearLabel = useCallback((value: DateInput) => formatMonthYear(value, language), [language]);
  /** date-fns `format` with the current locale applied. */
  const formatPattern = useCallback(
    (value: Date | number, pattern: string) => dateFnsFormat(value, pattern, { locale: dateFnsLocale }),
    [dateFnsLocale],
  );

  return {
    language,
    dateFnsLocale,
    intlLocale,
    formatShort,
    formatMedium,
    formatWeekday,
    formatMonthYear: formatMonthYearLabel,
    formatPattern,
  };
}
