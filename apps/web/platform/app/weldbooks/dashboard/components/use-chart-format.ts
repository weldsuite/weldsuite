import { useMemo } from 'react';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

/** `YYYY-MM` month keys as a UTC date, so no time zone moves them into the previous month. */
const monthDate = (key: string) => new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1));

/**
 * Axis and tooltip formatters for the dashboard charts: month names ("Oct",
 * "Oct 2026", "October 2026") in the user's date locale, and compact money
 * ("€12K") for the y axis, and signed percentages for changes.
 */
export function useChartFormat() {
  const { formatMoney, dateLocale, currency } = useWeldbooksFormat();

  return useMemo(() => {
    const short = new Intl.DateTimeFormat(dateLocale, { month: 'short', timeZone: 'UTC' });
    const long = new Intl.DateTimeFormat(dateLocale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const shortYear = new Intl.DateTimeFormat(dateLocale, { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const compact = new Intl.NumberFormat(dateLocale, {
      style: 'currency',
      currency: currency || 'EUR',
      notation: 'compact',
      maximumFractionDigits: 1,
    });
    // Stripe shows changes with two decimals and an explicit sign: "+12.5%", "-92.22%", "0%".
    const percent = new Intl.NumberFormat(dateLocale, { style: 'percent', maximumFractionDigits: 2, signDisplay: 'exceptZero' });
    return {
      formatMoney,
      monthShort: (key: string) => short.format(monthDate(key)),
      monthLong: (key: string) => long.format(monthDate(key)),
      monthYear: (key: string) => shortYear.format(monthDate(key)),
      compactMoney: (value: number) => compact.format(value),
      percent: (value: number) => percent.format(value / 100),
    };
  }, [formatMoney, dateLocale, currency]);
}
