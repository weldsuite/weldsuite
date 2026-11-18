/**
 * Display helpers for scheduled report emails: the sentence that says when a
 * schedule runs, and what it sends.
 */

import type { HelpdeskReportScheduleDto } from '@weldsuite/core-api-client/schemas/helpdesk-analytics';
import type { TranslationsType } from '@/lib/i18n/types';

export type ReportSchedulesT = TranslationsType['helpdesk']['reportSchedules'];

type Timing = Pick<HelpdeskReportScheduleDto, 'frequency' | 'dayOfWeek' | 'dayOfMonth' | 'hour' | 'timezone'>;

export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** "Every Monday at 08:00 (Europe/Amsterdam)", "Every day at ...", "On day 15 of every month at ...". */
export function scheduleWhen(schedule: Timing, t: ReportSchedulesT): string {
  const time = formatHour(schedule.hour);
  const { timezone } = schedule;
  if (schedule.frequency === 'weekly') {
    const day = t.weekdays[schedule.dayOfWeek ?? 1] ?? '';
    return t.when.weekly.replace('{day}', day).replace('{time}', time).replace('{timezone}', timezone);
  }
  if (schedule.frequency === 'monthly') {
    return t.when.monthly
      .replace('{day}', String(schedule.dayOfMonth ?? 1))
      .replace('{time}', time)
      .replace('{timezone}', timezone);
  }
  return t.when.daily.replace('{time}', time).replace('{timezone}', timezone);
}

export function recipientsLabel(count: number, t: ReportSchedulesT): string {
  return count === 1 ? t.recipientsCountOne : t.recipientsCount.replace('{count}', String(count));
}

/** What the schedule sends: the overview and its period, or the saved report's title. */
export function scheduleSubject(
  schedule: Pick<HelpdeskReportScheduleDto, 'reportId' | 'reportTitle' | 'range'>,
  t: ReportSchedulesT,
): { label: string; deleted: boolean } {
  if (schedule.reportId === null) {
    return { label: t.overviewWithRange.replace('{range}', t.ranges[schedule.range]), deleted: false };
  }
  if (schedule.reportTitle === null) return { label: t.savedReportDeleted, deleted: true };
  return { label: schedule.reportTitle, deleted: false };
}
