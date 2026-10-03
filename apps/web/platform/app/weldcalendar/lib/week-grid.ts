/**
 * Week-start aware helpers shared by every month grid (main month view, year
 * view, mobile month list, sidebar mini-calendar).
 */

import { addDays, endOfMonth, startOfMonth, startOfWeek } from 'date-fns';
import { WEEK_STARTS_ON } from './calendar-format';

type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The weeks (arrays of 7 consecutive days) that cover `month`, starting each
 * row on `weekStartsOn`. Days before the 1st / after the last belong to the
 * neighbouring months. `minWeeks` pads with whole trailing weeks (the year view
 * keeps every month the same height).
 */
export function buildMonthGrid(
  month: Date,
  options: { weekStartsOn?: WeekStart; minWeeks?: number } = {},
): Date[][] {
  const { weekStartsOn = WEEK_STARTS_ON, minWeeks = 0 } = options;
  const monthEnd = endOfMonth(month);
  let day = startOfWeek(startOfMonth(month), { weekStartsOn });
  const weeks: Date[][] = [];
  while (day <= monthEnd || weeks.length < minWeeks) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(day);
      day = addDays(day, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/**
 * Re-order a Sunday-first list of seven weekday labels so it starts on
 * `weekStartsOn`.
 */
export function orderWeekdays<T>(sundayFirst: readonly T[], weekStartsOn: WeekStart = WEEK_STARTS_ON): T[] {
  return Array.from({ length: sundayFirst.length }, (_, i) => sundayFirst[(i + weekStartsOn) % sundayFirst.length]);
}
