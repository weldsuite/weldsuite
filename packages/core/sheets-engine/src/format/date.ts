/**
 * Excel's 1900 date system. A date is a serial number of days: 1 is
 * 1900-01-01, 60 is the non-existent 1900-02-29 that Excel keeps for Lotus
 * compatibility, 61 is 1900-03-01. Times are the fraction of a day.
 *
 * All conversions are calendar arithmetic in UTC; the timezone only enters
 * through NOW()/TODAY(), which receive the local offset from the host.
 */

const MS_PER_DAY = 86_400_000;
/** 1899-12-30, the epoch for serials >= 61. */
const EPOCH = Date.UTC(1899, 11, 30);

export interface YMD {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
}

/**
 * DATE(year, month, day) semantics: months and days overflow into the next
 * unit, years 0–1899 are taken as 1900 + year. Returns NaN when out of range.
 */
export function serialFromYMD(year: number, month: number, day: number): number {
  let y = Math.trunc(year);
  if (y >= 0 && y < 1900) y += 1900;
  if (y < 1900 || y > 9999) return NaN;
  const ms = Date.UTC(y, 0, 1) + 0; // anchor, then add months/days to allow overflow
  const d = new Date(ms);
  d.setUTCMonth(Math.trunc(month) - 1);
  d.setUTCDate(Math.trunc(day));
  const serial = serialFromUtcMs(d.getTime());
  return serial < 0 ? NaN : serial;
}

/** Serial for a UTC timestamp (date part and time fraction). */
export function serialFromUtcMs(ms: number): number {
  const days = (ms - EPOCH) / MS_PER_DAY;
  // Serials up to 59 sit one day off the real calendar because of the fake leap day.
  return days < 61 ? days - 1 : days;
}

export function utcMsFromSerial(serial: number): number {
  const days = serial < 61 ? serial + 1 : serial;
  return EPOCH + days * MS_PER_DAY;
}

export function ymdFromSerial(serial: number): YMD {
  const whole = Math.floor(serial);
  if (whole === 60) return { year: 1900, month: 2, day: 29 };
  if (whole === 0) return { year: 1900, month: 1, day: 0 };
  const d = new Date(utcMsFromSerial(whole));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export interface HMS {
  hour: number;
  minute: number;
  second: number;
  /** Milliseconds, rounded. */
  ms: number;
}

export function hmsFromSerial(serial: number): HMS {
  const frac = serial - Math.floor(serial);
  let total = Math.round(frac * MS_PER_DAY);
  if (total >= MS_PER_DAY) total = MS_PER_DAY - 1;
  const hour = Math.floor(total / 3_600_000);
  const minute = Math.floor((total % 3_600_000) / 60_000);
  const second = Math.floor((total % 60_000) / 1000);
  return { hour, minute, second, ms: total % 1000 };
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayFromSerial(serial: number): number {
  const whole = Math.floor(serial);
  // Serial 1 (1900-01-01) is reported by Excel as a Sunday because of the leap-year bug.
  if (whole < 61) return (whole + 6) % 7;
  return new Date(utcMsFromSerial(whole)).getUTCDay();
}

/** The local wall-clock serial for an instant, given Date#getTimezoneOffset minutes. */
export function localSerial(epochMs: number, timezoneOffsetMinutes: number): number {
  return serialFromUtcMs(epochMs - timezoneOffsetMinutes * 60_000);
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
