/**
 * Format a duration given in minutes as "2h 15m", "45m" or "3h".
 *
 * Decimal hours ("2.3h") hide the minutes people actually logged and round a
 * one-minute timer to "0h", so time is shown as hours and minutes instead.
 */
export function formatHoursMinutes(totalMinutes: number): string {
  const safe = Number.isFinite(totalMinutes) ? Math.max(0, Math.round(totalMinutes)) : 0;
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;

  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/** Same as {@link formatHoursMinutes} for a value in (decimal) hours. */
export function formatHoursDecimalAsHm(hours: number): string {
  return formatHoursMinutes(hours * 60);
}
