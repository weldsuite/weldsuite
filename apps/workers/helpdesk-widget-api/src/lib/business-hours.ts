/**
 * Business Hours Utility
 *
 * Computes availability based on configured business hours.
 * Uses native Intl + Date APIs (no external dependencies, works in CF Workers).
 */

interface DayHours {
  isOpen: boolean;
  openTime?: string;
  closeTime?: string;
}

interface Holiday {
  date: string;
  name: string;
  isRecurring?: boolean;
}

interface BusinessHours {
  timezone: string;
  monday?: DayHours;
  tuesday?: DayHours;
  wednesday?: DayHours;
  thursday?: DayHours;
  friday?: DayHours;
  saturday?: DayHours;
  sunday?: DayHours;
  holidays?: Holiday[];
}

export interface AvailabilityResult {
  isWithinOfficeHours: boolean;
  nextOpenTime: string | null;
}

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/**
 * Get the current time components in a specific timezone.
 */
function getTimeInTimezone(date: Date, timezone: string): { hours: number; minutes: number; dayOfWeek: number; dateStr: string } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const hours = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
  const minutes = parseInt(parts.find(p => p.type === 'minute')?.value || '0');

  // Get day of week (0=Sunday)
  const weekday = parts.find(p => p.type === 'weekday')?.value || '';
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dayMap[weekday] ?? 0;

  const year = parts.find(p => p.type === 'year')?.value || '';
  const month = parts.find(p => p.type === 'month')?.value || '';
  const day = parts.find(p => p.type === 'day')?.value || '';
  const dateStr = `${year}-${month}-${day}`;

  return { hours, minutes, dayOfWeek, dateStr };
}

/**
 * Parse a time string "HH:MM" into hours and minutes.
 */
function parseTime(time: string): { hours: number; minutes: number } {
  const [h, m] = time.split(':').map(Number);
  return { hours: h || 0, minutes: m || 0 };
}

/**
 * Check if a date matches any holiday.
 */
function isHoliday(dateStr: string, holidays?: Holiday[]): boolean {
  if (!holidays || holidays.length === 0) return false;

  const [year, month, day] = dateStr.split('-');
  const monthDay = `${month}-${day}`;

  return holidays.some(h => {
    if (h.isRecurring) {
      // Match month-day only
      const [, hMonth, hDay] = h.date.split('-');
      return `${hMonth}-${hDay}` === monthDay;
    }
    return h.date === dateStr;
  });
}

/**
 * Compute availability based on business hours configuration.
 */
export function computeAvailability(businessHours: BusinessHours | null | undefined): AvailabilityResult {
  if (!businessHours || !businessHours.timezone) {
    return { isWithinOfficeHours: true, nextOpenTime: null };
  }

  const now = new Date();
  const { hours, minutes, dayOfWeek, dateStr } = getTimeInTimezone(now, businessHours.timezone);
  const currentMinutes = hours * 60 + minutes;

  // Check if today is a holiday
  if (isHoliday(dateStr, businessHours.holidays)) {
    const nextOpen = findNextOpenTime(businessHours, now, 1);
    return { isWithinOfficeHours: false, nextOpenTime: nextOpen };
  }

  // Check current day's schedule
  const dayKey = DAY_KEYS[dayOfWeek] as keyof BusinessHours;
  const todayHours = businessHours[dayKey] as DayHours | undefined;

  if (!todayHours || !todayHours.isOpen) {
    const nextOpen = findNextOpenTime(businessHours, now, 1);
    return { isWithinOfficeHours: false, nextOpenTime: nextOpen };
  }

  const openTime = todayHours.openTime ? parseTime(todayHours.openTime) : { hours: 0, minutes: 0 };
  const closeTime = todayHours.closeTime ? parseTime(todayHours.closeTime) : { hours: 23, minutes: 59 };
  const openMinutes = openTime.hours * 60 + openTime.minutes;
  const closeMinutes = closeTime.hours * 60 + closeTime.minutes;

  if (currentMinutes >= openMinutes && currentMinutes < closeMinutes) {
    return { isWithinOfficeHours: true, nextOpenTime: null };
  }

  // Currently outside hours today
  if (currentMinutes < openMinutes) {
    // Haven't opened yet today
    const nextOpen = buildISOTime(now, businessHours.timezone, 0, todayHours.openTime || '09:00');
    return { isWithinOfficeHours: false, nextOpenTime: nextOpen };
  }

  // Past close time, find next open day
  const nextOpen = findNextOpenTime(businessHours, now, 1);
  return { isWithinOfficeHours: false, nextOpenTime: nextOpen };
}

/**
 * Find the next open time starting from daysAhead days in the future.
 */
function findNextOpenTime(businessHours: BusinessHours, now: Date, daysAhead: number): string | null {
  for (let i = daysAhead; i <= 7; i++) {
    const futureDate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const { dayOfWeek, dateStr } = getTimeInTimezone(futureDate, businessHours.timezone);

    if (isHoliday(dateStr, businessHours.holidays)) continue;

    const dayKey = DAY_KEYS[dayOfWeek] as keyof BusinessHours;
    const dayHours = businessHours[dayKey] as DayHours | undefined;

    if (dayHours?.isOpen) {
      return buildISOTime(now, businessHours.timezone, i, dayHours.openTime || '09:00');
    }
  }

  return null;
}

/**
 * Build an ISO timestamp for a given day offset and time in a timezone.
 */
function buildISOTime(now: Date, timezone: string, daysAhead: number, time: string): string {
  const futureDate = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const { hours, minutes } = parseTime(time);

  // Get the date components in the target timezone
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dateStr = formatter.format(futureDate);

  // Get timezone offset
  const offsetFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'shortOffset',
  });
  const offsetParts = offsetFormatter.formatToParts(futureDate);
  const offsetStr = offsetParts.find(p => p.type === 'timeZoneName')?.value || 'UTC';

  // Parse offset like "GMT+1", "GMT-5:30", "GMT"
  let offset = '+00:00';
  const offsetMatch = offsetStr.match(/GMT([+-]?)(\d{1,2})(?::(\d{2}))?/);
  if (offsetMatch) {
    const sign = offsetMatch[1] || '+';
    const h = offsetMatch[2].padStart(2, '0');
    const m = (offsetMatch[3] || '00').padStart(2, '0');
    offset = `${sign}${h}:${m}`;
  }

  const hStr = hours.toString().padStart(2, '0');
  const mStr = minutes.toString().padStart(2, '0');

  return `${dateStr}T${hStr}:${mStr}:00${offset}`;
}
