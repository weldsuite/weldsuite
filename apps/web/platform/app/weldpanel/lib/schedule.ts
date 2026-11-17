/** Schedules of scheduled reports: weekday names, hours, time zones and the sentence a list row shows. */

import type { PanelSubscriptionSchedule } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';

/** Sunday first, as the API counts them (0 = Sunday). */
export function weekdayNames(locale: string): string[] {
  // 4 January 1970 was a Sunday.
  return Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(1970, 0, 4 + day))));
}

/** `9` → `09:00` (or `9 AM` where the locale says so). */
export function hourLabel(hour: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(1970, 0, 1, hour)));
}

const COMMON_ZONES = ['UTC', 'Europe/Amsterdam', 'Europe/Brussels', 'Europe/Berlin', 'Europe/Paris', 'Europe/London', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney'];

/** Every IANA time zone the browser knows (UTC first), with `current` kept even when the list lacks it. */
export function timeZones(current?: string): string[] {
  let zones: string[] = COMMON_ZONES;
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    // Older browsers: the common ones.
  }
  const all = ['UTC', ...zones.filter((z) => z !== 'UTC')];
  return current && !all.includes(current) ? [current, ...all] : all;
}

export interface ScheduleTexts {
  daily: string;
  weekly: string;
  monthly: string;
}

/** "Every Monday at 09:00 (Europe/Amsterdam)". */
export function scheduleText(
  schedule: PanelSubscriptionSchedule,
  texts: ScheduleTexts,
  locale: string,
  format: (template: string, values: Record<string, string>) => string,
): string {
  const time = hourLabel(schedule.hour, locale);
  let text = format(texts.daily, { time });
  if (schedule.frequency === 'weekly') text = format(texts.weekly, { weekday: weekdayNames(locale)[schedule.weekday ?? 1] ?? '', time });
  else if (schedule.frequency === 'monthly') text = format(texts.monthly, { day: String(schedule.monthDay ?? 1), time });
  return `${text} (${schedule.timezone.replaceAll('_', ' ')})`;
}
