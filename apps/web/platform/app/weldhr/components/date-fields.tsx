/**
 * WeldHR's date and time fields: the UI library's pickers, reading and
 * writing the plain values WeldHR forms keep ("2026-11-22", "09:30") and
 * showing them the way the WeldHR lists do ("22 Nov 2026", "9:30 AM" or
 * "09:30" per the user's clock preference), instead of the browser's own
 * date and time inputs in the browser's language.
 *
 * Both drop into a React Hook Form `{...field}` spread: `value` and
 * `onChange(value)` take the plain string, and the rest (id, name, onBlur,
 * aria attributes from `FormControl`) goes to the trigger button.
 */

import type { ComponentProps } from 'react';
import { DatePicker } from '@weldsuite/ui/components/date-picker';
import { TimePicker } from '@weldsuite/ui/components/time-picker';
import { useTranslations } from '@weldsuite/i18n/client';
import { useTimeFormat } from '@/app/weldcalendar/lib/calendar-format';
import { useDateLocale } from '@/lib/i18n/date-locale';
import { formatDate } from './shared';

/**
 * "YYYY-MM-DD" as that calendar day at local midnight. Built from its parts,
 * never parsed as UTC, so the day never shifts with the time zone.
 */
function toLocalDate(isoDate: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** The calendar day of a local date as "YYYY-MM-DD". */
function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

type HrDateInputProps = Omit<
  ComponentProps<typeof DatePicker>,
  'date' | 'onDateChange' | 'onChange' | 'disabledDays' | 'formatDate' | 'locale'
> & {
  /** "YYYY-MM-DD", or empty for no date. */
  value?: string | null;
  /** The picked day as "YYYY-MM-DD"; '' when the date is cleared (picking the selected day again). */
  onChange: (value: string) => void;
  /** First and last day that can be picked, "YYYY-MM-DD". */
  min?: string;
  max?: string;
  /** Month and year menus in the calendar, for a date far from today (a date of birth). */
  yearPicker?: boolean;
};

/** How far back the year menu of a `yearPicker` field reaches. */
const YEAR_PICKER_START = new Date(1920, 0);

export function HrDateInput({ value, onChange, min, max, placeholder, yearPicker, ...props }: Readonly<HrDateInputProps>) {
  const t = useTranslations();
  const { dateFnsLocale } = useDateLocale();
  const first = min ? toLocalDate(min) : undefined;
  const last = max ? toLocalDate(max) : undefined;
  const disabledDays = [first ? { before: first } : null, last ? { after: last } : null].filter(
    (matcher): matcher is { before: Date } | { after: Date } => matcher !== null,
  );

  return (
    <DatePicker
      {...props}
      date={value ? toLocalDate(value) : undefined}
      onDateChange={(date) => onChange(date ? toIsoDate(date) : '')}
      formatDate={(date) => formatDate(toIsoDate(date))}
      locale={dateFnsLocale}
      disabledDays={disabledDays.length > 0 ? disabledDays : undefined}
      placeholder={placeholder ?? t('weldhr.common.pickDate')}
      {...(yearPicker && {
        captionLayout: 'dropdown' as const,
        startMonth: first ?? YEAR_PICKER_START,
        endMonth: last ?? new Date(new Date().getFullYear() + 10, 11),
      })}
    />
  );
}

type HrTimeInputProps = Omit<
  ComponentProps<typeof TimePicker>,
  'onChange' | 'hourCycle' | 'hourLabel' | 'minuteLabel' | 'clearLabel' | 'value'
> & {
  /** "HH:mm", 24-hour, or empty for no time. */
  value?: string | null;
  /** The picked time as "HH:mm"; '' when a `clearable` field is cleared. */
  onChange: (value: string) => void;
};

export function HrTimeInput({ value, onChange, placeholder, ...props }: Readonly<HrTimeInputProps>) {
  const t = useTranslations();
  const timeFormat = useTimeFormat();
  return (
    <TimePicker
      {...props}
      value={value || undefined}
      onChange={onChange}
      hourCycle={timeFormat === '24h' ? 24 : 12}
      hourLabel={t('weldhr.common.hour')}
      minuteLabel={t('weldhr.common.minute')}
      clearLabel={t('common.ui.form.clear')}
      placeholder={placeholder ?? t('weldhr.common.pickTime')}
    />
  );
}
