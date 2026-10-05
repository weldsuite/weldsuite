import { describe, expect, it } from 'vitest';
import { buildIcs, icsAttachment, nextIcsSequence, type IcsEvent } from './ics';

const START = '2026-10-01T21:00:00.000Z';
const END = '2026-10-01T22:00:00.000Z';
const MEETING_URL = 'https://meet.weldsuite.org/r/abc-defg-hij';

/** Undo RFC 5545 line folding so assertions can match whole properties. */
const unfold = (ics: string) => ics.replace(/\r\n /g, '');

const event: IcsEvent = {
  uid: 'evt_1@weldsuite.org',
  title: 'Planning',
  start: START,
  end: END,
  organizer: { name: 'Gert', email: 'gert@acme.com' },
  attendees: [{ email: 'guest@example.com' }],
};

describe('buildIcs', () => {
  it('writes the calendar envelope with the product in PRODID', () => {
    const ics = buildIcs({ ...event, product: 'WeldCalendar' });
    expect(ics).toContain('PRODID:-//WeldSuite//WeldCalendar//EN');
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('UID:evt_1@weldsuite.org');
    expect(ics).toContain('STATUS:CONFIRMED');
  });

  it('uses the meeting URL as LOCATION and URL when there is no physical location', () => {
    const ics = unfold(buildIcs({ ...event, meetingUrl: MEETING_URL }));
    expect(ics).toContain(`LOCATION:${MEETING_URL}`);
    expect(ics).toContain(`URL:${MEETING_URL}`);
    expect(ics).toContain(`Join: ${MEETING_URL}`);
    expect(ics).toContain(`X-GOOGLE-CONFERENCE:${MEETING_URL}`);
  });

  it('keeps a physical location and moves the meeting URL into DESCRIPTION', () => {
    const ics = unfold(buildIcs({ ...event, location: 'Room 4, Main St', meetingUrl: MEETING_URL }));
    expect(ics).toContain('LOCATION:Room 4\\, Main St');
    expect(ics).not.toContain(`LOCATION:${MEETING_URL}`);
    expect(ics).toContain(`DESCRIPTION:Join: ${MEETING_URL}`);
  });

  it('writes DTSTART/DTEND in UTC and drops a DTEND that is not after DTSTART', () => {
    expect(buildIcs(event)).toContain('DTSTART:20261001T210000Z');
    expect(buildIcs(event)).toContain('DTEND:20261001T220000Z');
    const bad = buildIcs({ ...event, end: '2026-09-30T22:00:00.000Z' });
    expect(bad).not.toContain('DTEND');
  });

  it('writes all-day events as DATE values with an exclusive end', () => {
    const ics = buildIcs({
      ...event,
      allDay: true,
      timezone: 'Europe/Amsterdam',
      start: '2026-09-30T22:00:00.000Z',
      end: '2026-10-01T21:59:59.000Z',
    });
    expect(ics).toContain('DTSTART;VALUE=DATE:20261001');
    expect(ics).toContain('DTEND;VALUE=DATE:20261002');
  });

  it('escapes text values and quotes CN parameters', () => {
    const ics = unfold(
      buildIcs({
        ...event,
        title: 'A, B; C\\D',
        description: 'line1\nline2\r\nline3',
        organizer: { name: 'Doe, John: CEO', email: 'gert@acme.com' },
        attendees: [{ email: 'guest@example.com', name: 'Guest "G"' }],
      }),
    );
    expect(ics).toContain('SUMMARY:A\\, B\\; C\\\\D');
    expect(ics).toContain('DESCRIPTION:line1\\nline2\\nline3');
    expect(ics).toContain('ORGANIZER;CN="Doe, John: CEO":mailto:gert@acme.com');
    expect(ics).toContain('ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN="Guest  G ":mailto:guest@example.com');
  });

  it('keeps an address from injecting properties', () => {
    const ics = buildIcs({ ...event, attendees: [{ email: 'a@b.c\r\nX-EVIL:1' }] });
    expect(ics).not.toMatch(/^X-EVIL/m);
  });

  it('folds lines longer than 75 octets and uses CRLF throughout', () => {
    const ics = buildIcs({ ...event, description: 'x'.repeat(200) + 'é'.repeat(50) });
    const encoder = new TextEncoder();
    for (const line of ics.split('\r\n')) expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/);
    expect(unfold(ics)).toContain(`DESCRIPTION:${'x'.repeat(200)}${'é'.repeat(50)}`);
  });

  it('CANCEL: METHOD CANCEL, STATUS CANCELLED and no join details', () => {
    const ics = buildIcs({ ...event, method: 'CANCEL', meetingUrl: MEETING_URL, sequence: 9 });
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('SEQUENCE:9');
    expect(ics).not.toContain(MEETING_URL);
  });
});

describe('icsAttachment', () => {
  it('is plain text with the method in the content type', () => {
    const att = icsAttachment({ ...event, method: 'CANCEL' });
    expect(att.filename).toBe('invite.ics');
    expect(att.contentType).toBe('text/calendar; method=CANCEL; charset=UTF-8');
    expect(att.content).toContain('BEGIN:VCALENDAR');
  });
});

describe('nextIcsSequence', () => {
  it('is seconds since the epoch', () => {
    expect(nextIcsSequence(1_700_000_000_123)).toBe(1_700_000_000);
  });
});
