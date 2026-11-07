/** Where a snoozed inbox item wakes up: 09:00 local time on the chosen day. */
const WAKE_HOUR = 9;

function wakeAt(day: Date): Date {
  const wake = new Date(day);
  wake.setHours(WAKE_HOUR, 0, 0, 0);
  return wake;
}

/** 09:00 tomorrow. */
export function snoozeUntilTomorrow(now: Date = new Date()): string {
  const day = new Date(now);
  day.setDate(day.getDate() + 1);
  return wakeAt(day).toISOString();
}

/** 09:00 next Monday (a Monday today counts as next week, not now). */
export function snoozeUntilNextWeek(now: Date = new Date()): string {
  const day = new Date(now);
  const untilMonday = ((8 - day.getDay()) % 7) || 7;
  day.setDate(day.getDate() + untilMonday);
  return wakeAt(day).toISOString();
}

/** 09:00 on a picked day. */
export function snoozeUntilDate(date: Date): string {
  return wakeAt(date).toISOString();
}
