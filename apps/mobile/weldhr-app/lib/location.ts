/**
 * Where the phone is, for clocking in or out at a work location. This file
 * holds the logic (permission, a fix that may be slow, a fallback to the last
 * known one) against a small `LocationSource`; hooks/use-clock-location.ts
 * plugs expo-location into it. Foreground only: it asks for a fix at the
 * moment of the tap and never tracks.
 */

/** What the clock call sends as `location`. */
export interface ClockLocation {
  latitude: number;
  longitude: number;
  /** Metres; left out when the device does not say. */
  accuracy?: number;
}

/** The part of an expo-location position the clock needs. */
export interface Fix {
  coords: { latitude: number; longitude: number; accuracy: number | null };
}

export interface LocationSource {
  /** Asks (or checks) for foreground permission. */
  requestPermission(): Promise<{ granted: boolean }>;
  /** A fresh, accurate fix; may take a while indoors. */
  currentPosition(): Promise<Fix>;
  /** The last fix the device has, if recent enough. */
  lastKnownPosition(): Promise<Fix | null>;
}

export type LocateResult =
  | { status: 'ok'; location: ClockLocation }
  /** Permission was refused: the person has to allow it in Settings. */
  | { status: 'denied' }
  /** Permission is fine but the device gave no position (location services off, no signal). */
  | { status: 'unavailable' };

/** How long to wait for a fresh fix before settling for the last known one. */
export const FIX_TIMEOUT_MS = 10_000;

export function toClockLocation(fix: Fix): ClockLocation | null {
  const { latitude, longitude, accuracy } = fix.coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return accuracy != null && Number.isFinite(accuracy) && accuracy >= 0
    ? { latitude, longitude, accuracy: Math.round(accuracy) }
    : { latitude, longitude };
}

/** `promise`'s result, or null when it fails or takes longer than `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function locateForClock(source: LocationSource, timeoutMs: number = FIX_TIMEOUT_MS): Promise<LocateResult> {
  const permission = await source.requestPermission().catch(() => ({ granted: false }));
  if (!permission.granted) return { status: 'denied' };

  const fresh = await within(source.currentPosition(), timeoutMs);
  const fix = fresh ?? (await within(source.lastKnownPosition(), timeoutMs));
  const location = fix ? toClockLocation(fix) : null;
  return location ? { status: 'ok', location } : { status: 'unavailable' };
}
