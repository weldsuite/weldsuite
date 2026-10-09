/** Small pieces shared by the absenteeism dialogs and lists. */

import { errorMessage, shiftIsoDate, todayIso } from '../../components/shared';

/** The API answers in English; the two conflicts an employee can run into get a translated line. */
export function absenceFailure(err: unknown, t: (path: string) => string): string {
  const message = errorMessage(err, t('weldhr.absenteeism.form.failed'));
  const lower = message.toLowerCase();
  if (lower.includes('already an open')) return t('weldhr.absenteeism.form.alreadyOpen');
  if (lower.includes('overlap')) return t('weldhr.absenteeism.form.overlap');
  return message;
}

/**
 * The last sick day to suggest when reporting recovered: the last working day
 * before today (someone back on Monday was last sick on Friday), but never
 * before the first sick day.
 */
export function suggestedLastSickDay(startDate: string, today: string = todayIso()): string {
  let day = shiftIsoDate(today, -1);
  while ([0, 6].includes(new Date(`${day}T12:00:00`).getDay())) day = shiftIsoDate(day, -1);
  return day < startDate ? startDate : day;
}

/** Days can be fractional: a half first day counts as 0.5. */
export function formatDays(days: number): string {
  return days.toLocaleString(undefined, { maximumFractionDigits: 1 });
}
