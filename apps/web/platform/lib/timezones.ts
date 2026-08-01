export interface TimezoneOption {
  id: string;
  label: string;
}

export function getUtcOffset(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    const off = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT';
    return off === 'GMT' ? 'GMT+00:00' : off.replace(/^GMT/, 'GMT');
  } catch {
    return 'GMT';
  }
}

/** The viewer's own IANA zone, used as the last-resort default. */
export function getBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Offset of `timeZone` from UTC at `instant`, in milliseconds (east positive).
 *
 * Works by asking Intl what wall clock `instant` shows in the zone, then
 * measuring how far that is from the same wall clock read as UTC. Throws
 * RangeError on an unknown zone, which is what the callers below catch.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);

  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    // Some engines render midnight as hour 24 under hour12:false.
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  // Intl formats to whole seconds, so compare against a second-floored instant
  // or the sub-second remainder leaks into the offset.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Read a `datetime-local` value (`YYYY-MM-DDTHH:mm`) as wall-clock time in
 * `timeZone` and return the absolute instant it denotes.
 *
 * `new Date('2026-08-05T14:30')` interprets the string in the *browser's* zone,
 * which is why a timezone picker next to a datetime-local input is inert unless
 * the conversion is done explicitly.
 *
 * Two passes: guess the instant using the offset that applies at the
 * naive-as-UTC time, then re-measure at the guessed instant so a DST boundary
 * between the two is accounted for. Gap times (the hour that does not exist on
 * a spring-forward day) resolve to the instant just after the transition;
 * ambiguous times on a fall-back day resolve to the first occurrence.
 *
 * Returns null when the value or the zone can't be parsed, so callers can fall
 * back rather than schedule at a silently wrong moment.
 */
export function zonedWallClockToInstant(wallClock: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(wallClock);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const naiveAsUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0),
  );
  if (Number.isNaN(naiveAsUtc)) return null;

  try {
    const firstOffset = zoneOffsetMs(new Date(naiveAsUtc), timeZone);
    const guess = naiveAsUtc - firstOffset;
    const secondOffset = zoneOffsetMs(new Date(guess), timeZone);
    return new Date(secondOffset === firstOffset ? guess : naiveAsUtc - secondOffset);
  } catch {
    return null;
  }
}

/**
 * Inverse of `zonedWallClockToInstant`: render an absolute instant as the
 * `datetime-local` value (`YYYY-MM-DDTHH:mm`) a viewer in `timeZone` would read
 * off the clock. Used to populate the input when editing a scheduled post, so
 * the time shown matches the zone the post was scheduled in.
 *
 * Returns an empty string when the instant or zone can't be parsed.
 */
export function instantToZonedWallClock(instant: string | Date, timeZone: string): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return '';
  try {
    const shifted = new Date(date.getTime() + zoneOffsetMs(date, timeZone));
    return shifted.toISOString().slice(0, 16);
  } catch {
    return '';
  }
}

export const TIMEZONES: TimezoneOption[] = (() => {
  const ids =
    typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : ['UTC', 'Europe/Amsterdam', 'America/New_York'];

  const list = ['UTC', ...ids.filter((tz) => tz !== 'UTC').sort()];
  return list.map((id) => ({
    id,
    label: `${id.replace(/_/g, ' ')} (${getUtcOffset(id)})`,
  }));
})();
