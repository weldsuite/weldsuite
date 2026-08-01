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
 * DST makes the mapping non-unique twice a year, so both offsets in play around
 * a transition are probed (a day either side) and every candidate instant is
 * checked back against the zone. A candidate is real only if the zone actually
 * shows the requested wall clock at it, which is what rules out gap times.
 *
 *  - Ambiguous (fall-back) times, which occur twice, take the EARLIER instant.
 *  - Gap times, which never occur, take the instant just after the transition.
 *
 * That matches Temporal's `disambiguation: 'compatible'`. Resolving from a
 * single probe instead looks simpler but is not deterministic across zones: it
 * returns the first occurrence for `America/New_York` and the second for
 * `Europe/Amsterdam`, because which side of the transition the naive-as-UTC
 * probe lands on depends on the sign of the offset.
 *
 * Returns null when the value or the zone can't be parsed, so callers can fall
 * back rather than schedule at a silently wrong moment.
 */
const OFFSET_PROBE_MS = 24 * 60 * 60 * 1000;

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
    const before = zoneOffsetMs(new Date(naiveAsUtc - OFFSET_PROBE_MS), timeZone);
    const after = zoneOffsetMs(new Date(naiveAsUtc + OFFSET_PROBE_MS), timeZone);
    const candidates =
      before === after ? [naiveAsUtc - before] : [naiveAsUtc - before, naiveAsUtc - after];

    const real = candidates.filter(
      (candidate) => zoneOffsetMs(new Date(candidate), timeZone) === naiveAsUtc - candidate,
    );
    // No real candidate means the wall clock falls in a gap; the later instant
    // is the one just past the transition.
    return new Date(real.length > 0 ? Math.min(...real) : Math.max(...candidates));
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
