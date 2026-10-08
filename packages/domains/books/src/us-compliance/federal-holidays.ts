/**
 * Legal holidays in the District of Columbia, which is what decides whether a
 * federal tax due date rolls forward (IRC section 7503): the federal holidays,
 * DC Emancipation Day (16 April) and Inauguration Day.
 *
 * A holiday on a Sunday is observed on the Monday after; a holiday on a
 * Saturday is observed on the Friday before (5 U.S.C. 6103(b), which DC
 * follows; Emancipation Day on Saturday 16 April 2022 is why the 2022 filing
 * deadline was 18 April). Inauguration Day only moves from a Sunday.
 */

import { addDays, formatIso, lastWeekdayOfMonth, nthWeekdayOfMonth, weekdayOf } from './dates';

export interface LegalHoliday {
  /** The day deadlines roll over: the observed day when the holiday fell on a weekend. */
  date: string;
  name: string;
}

const MON = 1;
const THU = 4;

function observed(date: string, saturdayToFriday = true): string {
  const weekday = weekdayOf(date);
  if (weekday === 0) return addDays(date, 1);
  if (weekday === 6 && saturdayToFriday) return addDays(date, -1);
  return date;
}

function holidaysStartingIn(year: number): LegalHoliday[] {
  const list: LegalHoliday[] = [
    { date: observed(formatIso(year, 1, 1)), name: "New Year's Day" },
    { date: nthWeekdayOfMonth(year, 1, MON, 3), name: 'Birthday of Martin Luther King, Jr.' },
    { date: nthWeekdayOfMonth(year, 2, MON, 3), name: "Washington's Birthday" },
    { date: observed(formatIso(year, 4, 16)), name: 'DC Emancipation Day' },
    { date: lastWeekdayOfMonth(year, 5, MON), name: 'Memorial Day' },
    { date: observed(formatIso(year, 6, 19)), name: 'Juneteenth National Independence Day' },
    { date: observed(formatIso(year, 7, 4)), name: 'Independence Day' },
    { date: nthWeekdayOfMonth(year, 9, MON, 1), name: 'Labor Day' },
    { date: nthWeekdayOfMonth(year, 10, MON, 2), name: "Columbus Day / Indigenous Peoples' Day" },
    { date: observed(formatIso(year, 11, 11)), name: 'Veterans Day' },
    { date: nthWeekdayOfMonth(year, 11, THU, 4), name: 'Thanksgiving Day' },
    { date: observed(formatIso(year, 12, 25)), name: 'Christmas Day' },
  ];
  if ((year - 1937) % 4 === 0 && year >= 1937) {
    list.push({ date: observed(formatIso(year, 1, 20), false), name: 'Inauguration Day' });
  }
  return list;
}

/** The legal holidays (observed days) that fall inside a calendar year, in date order. */
export function legalHolidays(year: number): LegalHoliday[] {
  const prefix = `${year}-`;
  // New Year's Day of next year can be observed on 31 December of this one.
  const all = [...holidaysStartingIn(year), ...holidaysStartingIn(year + 1)];
  const seen = new Set<string>();
  return all
    .filter((holiday) => holiday.date.startsWith(prefix))
    .filter((holiday) => (seen.has(holiday.date) ? false : (seen.add(holiday.date), true)))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function legalHolidayOn(date: string): LegalHoliday | null {
  const year = Number(date.slice(0, 4));
  return legalHolidays(year).find((holiday) => holiday.date === date) ?? null;
}

export function isLegalHoliday(date: string): boolean {
  return legalHolidayOn(date) !== null;
}

export function isBusinessDay(date: string): boolean {
  const weekday = weekdayOf(date);
  return weekday !== 0 && weekday !== 6 && !isLegalHoliday(date);
}

/** The date itself when it is a business day, otherwise the next business day (IRC section 7503). */
export function rollToBusinessDay(date: string): string {
  let current = date;
  while (!isBusinessDay(current)) current = addDays(current, 1);
  return current;
}
