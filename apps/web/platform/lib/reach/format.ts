/**
 * Number, money and date formatting for WeldReach screens, in the UI language.
 */

import { useMemo } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { localeConfig } from '@/lib/i18n/locales';

export interface ReachFormat {
  locale: string;
  number: (value: number) => string;
  /** `rate` is a fraction: 0.034 becomes "3.4%". */
  percent: (rate: number) => string;
  /** `cents` in the currency's minor unit, rendered without decimals when whole. */
  money: (cents: number, currency: string) => string;
  date: (iso: string) => string;
  dateTime: (iso: string) => string;
  /** "3 minutes ago" / "in 2 days". */
  relative: (iso: string) => string;
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 30],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
];

export function createReachFormat(locale: string): ReachFormat {
  const numberFormat = new Intl.NumberFormat(locale);
  const percentFormat = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const dateFormat = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' });
  const dateTimeFormat = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const relativeFormat = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  return {
    locale,
    number: (value) => numberFormat.format(value),
    percent: (rate) => percentFormat.format(rate),
    money: (cents, currency) => {
      const amount = cents / 100;
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currency.toUpperCase(),
        minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(amount);
    },
    date: (iso) => dateFormat.format(new Date(iso)),
    dateTime: (iso) => dateTimeFormat.format(new Date(iso)),
    relative: (iso) => {
      let amount = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
      let unit: Intl.RelativeTimeFormatUnit = 'second';
      for (const [candidate, size] of RELATIVE_UNITS) {
        unit = candidate;
        if (Math.abs(amount) < size) break;
        amount = Math.round(amount / size);
      }
      return relativeFormat.format(amount, unit);
    },
  };
}

export function useReachFormat(): ReachFormat {
  const { language } = useI18n();
  const locale = localeConfig[language]?.intlLocale ?? 'en-US';
  return useMemo(() => createReachFormat(locale), [locale]);
}
