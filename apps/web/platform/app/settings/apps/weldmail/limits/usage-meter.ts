/**
 * Pure helpers behind the "Sending limits" meters (outbound mail guard):
 * how full a window is, and how loudly to say so.
 */

export type MeterTone = 'ok' | 'warning' | 'full';

/** From this share of the limit on, the meter turns amber. */
export const METER_WARNING_RATIO = 0.8;

/**
 * How full the window is, 0 to 100. No limit (`null`) is never full; a limit of
 * 0 ("none allowed", e.g. new contacts while restricted) is full as soon as
 * anything was used, and empty before.
 */
export function meterPercent(used: number, limit: number | null): number {
  if (limit === null) return 0;
  if (limit <= 0) return used > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

export function meterTone(used: number, limit: number | null): MeterTone {
  if (limit === null) return 'ok';
  if (used >= limit && (limit > 0 || used > 0)) return 'full';
  if (limit > 0 && used / limit >= METER_WARNING_RATIO) return 'warning';
  return 'ok';
}
