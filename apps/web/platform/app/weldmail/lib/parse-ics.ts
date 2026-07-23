/**
 * Minimal, dependency-free iCalendar (RFC 5545) parser.
 *
 * Scoped to what WeldMail needs: pulling the first VEVENT out of an `.ics`
 * calendar invite attachment so we can offer a "Add to Weld Calendar" button
 * on the message. It is intentionally small — it does NOT aim to be a
 * full-fidelity iCal implementation (no RRULE expansion, no embedded VTIMEZONE
 * parsing), just enough to map an invite onto a CalendarEvent. TZID-qualified
 * times ARE resolved through the runtime's IANA database (`Intl`), so zoned
 * invites land at the correct instant.
 */

export interface ParsedIcsEvent {
  uid?: string;
  summary?: string;
  description?: string;
  location?: string;
  /** ISO 8601 string suitable for `new Date()`. */
  start?: string;
  /** ISO 8601 string suitable for `new Date()`. */
  end?: string;
  allDay: boolean;
  organizer?: { email?: string; name?: string };
  attendees: { email?: string; name?: string }[];
  url?: string;
  rrule?: string;
  /** iCal METHOD (REQUEST, CANCEL, REPLY, PUBLISH …), upper-cased. */
  method?: string;
  /** VEVENT STATUS (CONFIRMED, TENTATIVE, CANCELLED …), upper-cased. */
  status?: string;
}

/** Unescape RFC 5545 TEXT values (\n \, \; \\). */
function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/** Unfold folded lines: a CRLF followed by a space or tab is a continuation. */
function unfoldLines(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

interface RawProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Split "NAME;PARAM=x;PARAM2=y:value" into its parts. */
function parseProp(line: string): RawProp | null {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;
  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const headParts = head.split(';');
  const name = headParts[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < headParts.length; i++) {
    const eq = headParts[i].indexOf('=');
    if (eq === -1) continue;
    params[headParts[i].slice(0, eq).toUpperCase()] = headParts[i].slice(eq + 1);
  }
  return { name, params, value };
}

/**
 * Common Microsoft/Outlook TZID values → IANA zone ids. Outlook labels
 * DTSTART/DTEND with Windows zone names (e.g. `W. Europe Standard Time`) that
 * `Intl.DateTimeFormat` doesn't understand; mapping the frequent ones keeps
 * those (very common) invites from silently falling back to the viewer's zone.
 */
const WINDOWS_TZ_TO_IANA: Record<string, string> = {
  'utc': 'UTC',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'e. europe standard time': 'Europe/Chisinau',
  'gtb standard time': 'Europe/Bucharest',
  'fle standard time': 'Europe/Kyiv',
  'w. central africa standard time': 'Africa/Lagos',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'pacific standard time': 'America/Los_Angeles',
  'india standard time': 'Asia/Kolkata',
  'china standard time': 'Asia/Shanghai',
  'tokyo standard time': 'Asia/Tokyo',
  'aus eastern standard time': 'Australia/Sydney',
};

/** Resolve a raw TZID param (possibly quoted, possibly a Windows name) to IANA. */
function normalizeTzid(tzid: string): string {
  const cleaned = tzid.replace(/^"(.*)"$/, '$1').trim();
  return WINDOWS_TZ_TO_IANA[cleaned.toLowerCase()] ?? cleaned;
}

/** Milliseconds `timeZone` is ahead of UTC at the given instant. */
function tzOffsetMs(timeZone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) map[p.type] = p.value;
  const hour = map.hour === '24' ? '0' : map.hour;
  const asIfUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(hour),
    Number(map.minute),
    Number(map.second),
  );
  return asIfUtc - utcMs;
}

/**
 * Convert a wall-clock time expressed in `tzid` into the correct UTC instant.
 * Returns `null` when the zone can't be resolved so the caller can fall back to
 * the viewer's local time (no worse than the previous behaviour).
 */
function wallTimeInZoneToUtc(
  y: number,
  mo0: number,
  da: number,
  h: number,
  mi: number,
  s: number,
  tzid: string,
): Date | null {
  const zone = normalizeTzid(tzid);
  try {
    const guessUtc = Date.UTC(y, mo0, da, h, mi, s);
    // Two passes so times near a DST transition resolve to the right side.
    let offset = tzOffsetMs(zone, guessUtc);
    offset = tzOffsetMs(zone, guessUtc - offset);
    const d = new Date(guessUtc - offset);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null; // Unknown/invalid zone — Intl throws a RangeError.
  }
}

/**
 * Parse an iCal date/time value into an ISO string.
 *
 * Handles the common forms:
 *   - `VALUE=DATE`            → `20240115`            (all-day)
 *   - UTC                     → `20240115T090000Z`
 *   - TZID local              → `TZID=...:20240115T090000`  (resolved via Intl)
 *   - floating local          → `20240115T090000`
 *
 * A TZID-qualified time is resolved through the runtime IANA database so it
 * lands at the correct instant. A floating time (no TZID, no `Z`) is, per RFC
 * 5545, interpreted in the viewer's local zone.
 */
function parseIcsDate(prop: RawProp): { iso?: string; allDay: boolean } {
  const value = prop.value.trim();
  const isDateOnly = prop.params.VALUE === 'DATE' || /^\d{8}$/.test(value);

  if (isDateOnly) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(value);
    if (!m) return { iso: undefined, allDay: true };
    // Midnight local time; consumers treat this as an all-day event.
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
    return { iso: isNaN(d.getTime()) ? undefined : d.toISOString(), allDay: true };
  }

  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!m) {
    // Last resort: let the Date constructor try.
    const d = new Date(value);
    return { iso: isNaN(d.getTime()) ? undefined : d.toISOString(), allDay: false };
  }
  const [, y, mo, da, h, mi, s, z] = m;
  let d: Date;
  if (z === 'Z') {
    d = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(s)));
  } else if (prop.params.TZID) {
    // TZID-qualified local time → resolve through the named zone, falling back
    // to the viewer's local wall-clock only if the zone can't be resolved.
    d =
      wallTimeInZoneToUtc(
        Number(y),
        Number(mo) - 1,
        Number(da),
        Number(h),
        Number(mi),
        Number(s),
        prop.params.TZID,
      ) ?? new Date(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(s));
  } else {
    // Floating time (no TZID, no Z) → interpret as local wall-clock time.
    d = new Date(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(s));
  }
  return { iso: isNaN(d.getTime()) ? undefined : d.toISOString(), allDay: false };
}

/** Pull the "mailto:" address and CN param out of an ORGANIZER/ATTENDEE prop. */
function parsePerson(prop: RawProp): { email?: string; name?: string } {
  const email = prop.value.replace(/^mailto:/i, '').trim() || undefined;
  const name = prop.params.CN ? unescapeText(prop.params.CN) : undefined;
  return { email, name };
}

/**
 * Parse the first VEVENT from an iCalendar payload. Returns `null` when the
 * text isn't a calendar object or contains no VEVENT.
 */
export function parseIcs(raw: string): ParsedIcsEvent | null {
  if (!raw || !/BEGIN:VCALENDAR/i.test(raw)) return null;

  const lines = unfoldLines(raw);
  let method: string | undefined;
  let inEvent = false;
  const event: ParsedIcsEvent = { allDay: false, attendees: [] };
  let foundEvent = false;

  for (const line of lines) {
    const prop = parseProp(line);
    if (!prop) continue;

    if (prop.name === 'METHOD' && !inEvent) {
      method = prop.value.trim().toUpperCase();
      continue;
    }
    if (prop.name === 'BEGIN' && prop.value.toUpperCase() === 'VEVENT') {
      inEvent = true;
      foundEvent = true;
      continue;
    }
    if (prop.name === 'END' && prop.value.toUpperCase() === 'VEVENT') {
      break; // Only the first VEVENT is needed.
    }
    if (!inEvent) continue;

    switch (prop.name) {
      case 'UID':
        event.uid = prop.value.trim();
        break;
      case 'SUMMARY':
        event.summary = unescapeText(prop.value);
        break;
      case 'DESCRIPTION':
        event.description = unescapeText(prop.value);
        break;
      case 'LOCATION':
        event.location = unescapeText(prop.value);
        break;
      case 'URL':
        event.url = prop.value.trim();
        break;
      case 'RRULE':
        event.rrule = prop.value.trim();
        break;
      case 'STATUS':
        event.status = prop.value.trim().toUpperCase();
        break;
      case 'DTSTART': {
        const { iso, allDay } = parseIcsDate(prop);
        event.start = iso;
        if (allDay) event.allDay = true;
        break;
      }
      case 'DTEND': {
        const { iso } = parseIcsDate(prop);
        event.end = iso;
        break;
      }
      case 'ORGANIZER':
        event.organizer = parsePerson(prop);
        break;
      case 'ATTENDEE':
        event.attendees.push(parsePerson(prop));
        break;
      default:
        break;
    }
  }

  if (!foundEvent) return null;
  event.method = method;
  return event;
}
