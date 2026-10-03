import { format } from 'date-fns';
import { useUserPreferences } from '@/hooks/queries/use-settings-queries';

/**
 * First day of the week on every WeldCalendar surface: the main grid, the
 * sidebar mini-calendar, date pickers, the booking editor and the booking
 * portal. Monday, like the rest of the platform.
 */
export const WEEK_STARTS_ON = 1 as const;

/** The user's clock preference (`/user-preferences` `timeFormat`). */
export type TimeFormat = '12h' | '24h';

export function toTimeFormat(value: string | null | undefined): TimeFormat {
  return value === '24h' ? '24h' : '12h';
}

/** The signed-in user's 12h/24h preference; 12h until preferences load. */
export function useTimeFormat(): TimeFormat {
  const { data } = useUserPreferences();
  return toTimeFormat(data?.timeFormat);
}

/** "6:00 PM" (12h) or "18:00" (24h). */
export function formatClock(date: Date, timeFormat: TimeFormat): string {
  return format(date, timeFormat === '24h' ? 'HH:mm' : 'h:mm a');
}

/**
 * Short form for tight spots such as month-view chips: "6 PM" / "6:30 PM" in
 * 12h, "18:00" in 24h.
 */
export function formatClockCompact(date: Date, timeFormat: TimeFormat): string {
  if (timeFormat === '24h') return format(date, 'HH:mm');
  return format(date, date.getMinutes() === 0 ? 'h a' : 'h:mm a');
}

/** "8:00 AM – 9:00 AM" / "08:00 – 09:00". */
export function formatClockRange(start: Date, end: Date, timeFormat: TimeFormat): string {
  return `${formatClock(start, timeFormat)} – ${formatClock(end, timeFormat)}`;
}
