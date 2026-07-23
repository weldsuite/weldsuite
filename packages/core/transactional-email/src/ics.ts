/**
 * RFC 5545 iCalendar invite builder.
 *
 * Used to attach `.ics` files to outbound transactional emails so recipients
 * can add the event to their calendar.
 */

interface IcsAttendee {
  email: string;
  name?: string;
  role?: 'REQ-PARTICIPANT' | 'OPT-PARTICIPANT';
}

export interface BuildIcsParams {
  uid: string;
  sequence?: number;
  method?: 'REQUEST' | 'CANCEL' | 'PUBLISH';
  summary: string;
  description?: string | null;
  location?: string | null;
  startTime: string | Date;
  endTime: string | Date;
  organizer: { email: string; name?: string };
  attendees: IcsAttendee[];
  status?: 'CONFIRMED' | 'CANCELLED' | 'TENTATIVE';
}

function toIcsDate(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

// RFC 5545 §3.1: lines longer than 75 *octets* must be folded.
// We measure bytes via TextEncoder so multibyte UTF-8 codepoints don't blow the limit.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function foldLine(line: string): string {
  const bytes = encoder.encode(line);
  if (bytes.length <= 75) return line;

  const chunks: string[] = [];
  let offset = 0;
  let isFirst = true;
  // First chunk gets up to 75 bytes; continuation chunks reserve 1 byte for the leading space.
  while (offset < bytes.length) {
    const max = isFirst ? 75 : 74;
    let end = Math.min(offset + max, bytes.length);
    // Don't split a multibyte UTF-8 sequence: backtrack until we're at a code-point boundary.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    chunks.push((isFirst ? '' : ' ') + decoder.decode(bytes.subarray(offset, end)));
    offset = end;
    isFirst = false;
  }
  return chunks.join('\r\n');
}

export function buildIcsInvite(params: BuildIcsParams): string {
  const method = params.method ?? 'REQUEST';
  const status = params.status ?? 'CONFIRMED';
  const sequence = params.sequence ?? 0;
  const dtstamp = toIcsDate(new Date());

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WeldSuite//Booking Portal//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${params.uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${toIcsDate(params.startTime)}`,
    `DTEND:${toIcsDate(params.endTime)}`,
    `SEQUENCE:${sequence}`,
    `STATUS:${status}`,
    `SUMMARY:${escapeText(params.summary)}`,
  ];

  if (params.description) {
    lines.push(`DESCRIPTION:${escapeText(params.description)}`);
  }
  if (params.location) {
    lines.push(`LOCATION:${escapeText(params.location)}`);
  }

  const orgCn = params.organizer.name ? `;CN=${escapeText(params.organizer.name)}` : '';
  lines.push(`ORGANIZER${orgCn}:mailto:${params.organizer.email}`);

  for (const a of params.attendees) {
    const cn = a.name ? `;CN=${escapeText(a.name)}` : '';
    const role = a.role ?? 'REQ-PARTICIPANT';
    lines.push(
      `ATTENDEE;ROLE=${role};PARTSTAT=NEEDS-ACTION;RSVP=TRUE${cn}:mailto:${a.email}`,
    );
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');

  return lines.map(foldLine).join('\r\n');
}
