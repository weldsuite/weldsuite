/**
 * Formatting for the WeldReach engage pages. Numbers and dates come from the
 * module-wide `useReachFormat` (`@/lib/reach/format`); this adds the null-safe
 * variants the tables need, and the small helpers around names and weekdays.
 */

import { useMemo } from 'react';
import { useReachFormat as useBaseReachFormat } from '@/lib/reach/format';

type DateInput = string | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function useReachFormat() {
  const base = useBaseReachFormat();

  return useMemo(() => {
    const iso = (value: DateInput) => toDate(value)?.toISOString() ?? null;
    return {
      intlLocale: base.locale,
      number: base.number,
      /** `ratio` is 0..1. */
      percent: base.percent,
      /** Empty text for a missing or unreadable value. */
      dateTime: (value: DateInput) => {
        const date = iso(value);
        return date ? base.dateTime(date) : '';
      },
      date: (value: DateInput) => {
        const date = iso(value);
        return date ? base.date(date) : '';
      },
      relative: (value: DateInput) => {
        const date = iso(value);
        return date ? base.relative(date) : '';
      },
    };
  }, [base]);
}

/** Relative time with the absolute value on hover; an em dash when empty. */
export function RelativeTime({
  value,
  className,
}: Readonly<{ value: string | null | undefined; className?: string }>) {
  const format = useReachFormat();
  if (!value) return <span className={className}>—</span>;
  return (
    <time dateTime={value} title={format.dateTime(value)} className={className}>
      {format.relative(value)}
    </time>
  );
}

/** Full name from the parts a prospect carries, or `null` when there is none. */
export function personName(person: {
  firstName?: string | null;
  lastName?: string | null;
}): string | null {
  const name = [person.firstName, person.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' ');
  return name || null;
}

/** ISO weekday numbers (1 = Monday … 7 = Sunday) with a short localized name. */
export function weekdayLabels(intlLocale: string): Array<{ day: number; label: string }> {
  // 2024-01-01 is a Monday.
  const formatter = new Intl.DateTimeFormat(intlLocale, { weekday: 'short', timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, index) => ({
    day: index + 1,
    label: formatter.format(new Date(Date.UTC(2024, 0, 1 + index))),
  }));
}
