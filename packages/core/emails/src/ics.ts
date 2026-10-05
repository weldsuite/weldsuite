/**
 * RFC 5545 iCalendar builder for the .ics attached to calendar, meeting and
 * booking emails. Replaces calendar-api's `generateIcs` and
 * `@weldsuite/transactional-email`'s `buildIcsInvite`.
 */

import { isValidTimeZone } from './format';
import type { OutgoingAttachment } from './transport';

export type IcsMethod = 'REQUEST' | 'CANCEL' | 'PUBLISH';

export interface IcsPerson {
  email: string;
  name?: string | null;
}

export interface IcsAttendee extends IcsPerson {
  role?: 'REQ-PARTICIPANT' | 'OPT-PARTICIPANT';
}

export interface IcsEvent {
  /** Stable per event, e.g. `${eventId}@weldsuite.org`. */
  uid: string;
  method?: IcsMethod;
  /** Must grow with every revision of the same UID; see `nextIcsSequence`. */
  sequence?: number;
  title: string;
  description?: string | null;
  location?: string | null;
  start?: string | Date | null;
  end?: string | Date | null;
  /** All-day events are written as DATE values (DTEND exclusive) in `timezone`. */
  allDay?: boolean | null;
  /** IANA zone used to resolve the calendar day of all-day events. */
  timezone?: string | null;
  organizer?: IcsPerson | null;
  attendees?: IcsAttendee[];
  url?: string | null;
  /**
   * Video-conference join link. Becomes LOCATION when there is no physical
   * location, is spelled out as "Join: <url>" in DESCRIPTION, and is advertised
   * to Google/Outlook via X-GOOGLE-CONFERENCE. Ignored for CANCEL.
   */
  meetingUrl?: string | null;
  /** Defaults to CANCELLED for CANCEL, else CONFIRMED. */
  status?: 'CONFIRMED' | 'CANCELLED' | 'TENTATIVE';
  /** Product in PRODID, e.g. "WeldCalendar". */
  product?: string;
}

/**
 * A SEQUENCE that increases with every revision sent for a UID: clients ignore
 * a REQUEST/CANCEL whose sequence is not higher than the one they hold. Seconds
 * since the epoch is monotonic without persisting a counter, and fits the
 * 32-bit integer clients expect.
 */
export function nextIcsSequence(now: number = Date.now()): number {
  return Math.floor(now / 1000);
}

/** UTC date-time form, e.g. 20261001T210000Z. */
function utcStamp(value: string | Date): string {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** The calendar day of `value` in `timeZone` as [year, month, day]. */
function zonedYmd(value: string | Date, timeZone: string): [number, number, number] {
  const text = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
  const [y = 1970, m = 1, d = 1] = text.split('-').map(Number);
  return [y, m, d];
}

function dateOnly([y, m, d]: [number, number, number], plusDays = 0): string {
  return new Date(Date.UTC(y, m - 1, d + plusDays)).toISOString().slice(0, 10).replace(/-/g, '');
}

function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Parameter values containing , ; : must be quoted (and cannot contain quotes). */
function paramValue(text: string): string {
  return `"${text.replace(/["\r\n]/g, ' ')}"`;
}

/** A mailto: value with nothing that could end the content line. */
function mailto(email: string): string {
  return `mailto:${email.replace(/[\s;:,"<>]/g, '')}`;
}

const MAX_OCTETS = 75;
const encoder = new TextEncoder();

/** Fold a content line to 75 octets without splitting a UTF-8 character. */
function fold(line: string): string {
  if (encoder.encode(line).length <= MAX_OCTETS) return line;
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  let limit = MAX_OCTETS;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (octets + size > limit) {
      parts.push(current);
      current = '';
      octets = 0;
      limit = MAX_OCTETS - 1; // the leading space of a continuation line
    }
    current += ch;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export function buildIcs(event: IcsEvent): string {
  const method = event.method ?? 'REQUEST';
  const cancelled = method === 'CANCEL';
  const joinUrl = cancelled ? undefined : event.meetingUrl?.trim() || undefined;
  const url = event.url?.trim() || joinUrl;

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//WeldSuite//${(event.product ?? 'WeldSuite').replace(/[^\w .-]/g, '')}//EN`,
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${utcStamp(new Date())}`,
    `SEQUENCE:${event.sequence ?? 0}`,
    `SUMMARY:${escapeText(event.title)}`,
  ];

  if (event.organizer?.email) {
    const cn = event.organizer.name?.trim() ? `;CN=${paramValue(event.organizer.name.trim())}` : '';
    lines.push(`ORGANIZER${cn}:${mailto(event.organizer.email)}`);
  }
  for (const attendee of event.attendees ?? []) {
    if (!attendee.email) continue;
    const cn = attendee.name?.trim() ? `;CN=${paramValue(attendee.name.trim())}` : '';
    const role = attendee.role ?? 'REQ-PARTICIPANT';
    lines.push(`ATTENDEE;ROLE=${role};PARTSTAT=NEEDS-ACTION;RSVP=TRUE${cn}:${mailto(attendee.email)}`);
  }

  if (event.start) {
    if (event.allDay) {
      const zone = isValidTimeZone(event.timezone) ? event.timezone : 'UTC';
      lines.push(`DTSTART;VALUE=DATE:${dateOnly(zonedYmd(event.start, zone))}`);
      // DTEND of a DATE event is exclusive: the day after the last day.
      lines.push(`DTEND;VALUE=DATE:${dateOnly(zonedYmd(event.end ?? event.start, zone), 1)}`);
    } else {
      lines.push(`DTSTART:${utcStamp(event.start)}`);
      // Never emit a DTEND that is not after DTSTART.
      if (event.end && new Date(event.end).getTime() > new Date(event.start).getTime()) {
        lines.push(`DTEND:${utcStamp(event.end)}`);
      }
    }
  }

  const description = [event.description?.trim(), joinUrl ? `Join: ${joinUrl}` : undefined]
    .filter((p): p is string => !!p)
    .join('\n\n');
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  const location = event.location?.trim() || joinUrl;
  if (location) lines.push(`LOCATION:${escapeText(location)}`);
  if (url) lines.push(`URL:${url.replace(/[\r\n]/g, '')}`);
  if (joinUrl) lines.push(`X-GOOGLE-CONFERENCE:${joinUrl.replace(/[\r\n]/g, '')}`);

  lines.push(`STATUS:${event.status ?? (cancelled ? 'CANCELLED' : 'CONFIRMED')}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');

  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** The .ics as an email attachment, with the METHOD in the content type (Outlook needs it). */
export function icsAttachment(event: IcsEvent, filename = 'invite.ics'): OutgoingAttachment {
  const method = event.method ?? 'REQUEST';
  return {
    filename,
    content: buildIcs(event),
    contentType: `text/calendar; method=${method}; charset=UTF-8`,
  };
}
