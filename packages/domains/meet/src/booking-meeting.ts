/**
 * WeldMeet meetings for booking-page bookings.
 *
 * A booking page whose location is "WeldMeet" (video, no custom link) gets a
 * real meeting for every booking: created together with the booking's calendar
 * event, linked to it through `meetings.calendar_event_id`, and kept in step
 * when the booking is rescheduled or cancelled. The same link the platform's
 * calendar uses (`calendar-meeting-sync` in calendar-api), so editing the event
 * in the platform later keeps working: it finds the meeting by that column and
 * sees the join code inside the event's `meeting_url`.
 *
 * Used by the public booking portal (Next.js), which has no Hono context and no
 * Worker bindings, so it only depends on a tenant Drizzle handle.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '@weldsuite/db/schema';
import type { MeetingAttendee } from '@weldsuite/db/schema/meetings';

/** A tenant Drizzle handle, or a transaction on one. */
export type BookingMeetingDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Production meeting portal. Used when no portal URL is configured. */
export const DEFAULT_MEETING_PORTAL_URL = 'https://meet.weldsuite.org';

export function getMeetingPortalUrl(configured: string | null | undefined): string {
  return (configured?.trim() || DEFAULT_MEETING_PORTAL_URL).replace(/\/+$/, '');
}

/** The public guest link: `<portal>/<workspaceId>/<joinCode>`. */
export function buildMeetingJoinUrl(portalUrl: string, workspaceId: string, joinCode: string): string {
  return `${portalUrl}/${encodeURIComponent(workspaceId)}/${encodeURIComponent(joinCode)}`;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

function joinCodeSegment(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/**
 * `wm-abc-def-ghi`, from the Web Crypto RNG: with `anyone_with_link` the code is
 * the only thing gating entry. Same format as meet-api's join codes.
 */
export function generateJoinCode(): string {
  return `wm-${joinCodeSegment()}-${joinCodeSegment()}-${joinCodeSegment()}`;
}

export interface BookingMeetingPerson {
  email: string;
  name?: string | null;
  /** RSVP the person starts with; the booker has accepted by booking. */
  status?: MeetingAttendee['status'];
}

export interface CreateBookingMeetingInput {
  /** Id for the new `meetings` row (the caller owns id generation). */
  id: string;
  title: string;
  /** The calendar event of the booking; stored on the meeting. */
  eventId: string;
  /** Clerk user id of the page owner, who hosts the meeting. */
  hostUserId: string;
  /** Clerk organization id of the workspace: the meeting portal resolves the tenant from it. */
  workspaceId: string;
  /** Meeting portal origin; defaults to production. */
  portalUrl?: string | null;
  start: Date;
  end: Date;
  /** The booker and the guests. The host is added as organizer. */
  attendees: readonly BookingMeetingPerson[];
}

export interface BookingMeeting {
  id: string;
  joinCode: string;
  joinUrl: string;
}

/** The host as the first attendee (organizer, accepted), when they are a workspace member. */
async function hostAttendee(db: BookingMeetingDb, hostUserId: string): Promise<MeetingAttendee | null> {
  const { workspaceMembers } = schema;
  const [member] = await db
    .select({
      id: workspaceMembers.id,
      name: workspaceMembers.name,
      email: workspaceMembers.email,
      picture: workspaceMembers.picture,
    })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, hostUserId))
    .limit(1);
  if (!member) return null;

  const email = member.email?.trim().toLowerCase() ?? '';
  return {
    userId: hostUserId,
    email,
    name: member.name?.trim() || email || 'Organizer',
    status: 'accepted',
    role: 'organizer',
    workspaceMemberId: member.id,
    ...(member.picture ? { avatar: member.picture } : {}),
  };
}

/**
 * Creates the scheduled WeldMeet meeting of a booking.
 *
 * Open to anyone with the link (the booker and guests are external people)
 * with the waiting room on, like a meeting started from the calendar. Run it in
 * the same transaction as the booking's event so neither exists without the other.
 */
export async function createBookingMeeting(
  db: BookingMeetingDb,
  input: CreateBookingMeetingInput,
): Promise<BookingMeeting> {
  const host = await hostAttendee(db, input.hostUserId);

  const attendees: MeetingAttendee[] = host ? [host] : [];
  const seen = new Set(attendees.map((a) => a.email));
  for (const person of input.attendees) {
    const email = person.email.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    attendees.push({
      userId: '',
      email,
      name: person.name?.trim() || email,
      status: person.status ?? 'pending',
      role: 'attendee',
    });
  }

  const joinCode = generateJoinCode();
  const now = new Date();
  await db.insert(schema.meetings).values({
    id: input.id,
    title: input.title,
    calendarEventId: input.eventId,
    organizerId: input.hostUserId,
    attendees,
    meetingType: 'video',
    status: 'scheduled',
    accessType: 'anyone_with_link',
    waitingRoom: true,
    allowRecording: false,
    joinCode,
    scheduledStart: input.start,
    scheduledEnd: input.end,
    createdAt: now,
    updatedAt: now,
  });

  return {
    id: input.id,
    joinCode,
    joinUrl: buildMeetingJoinUrl(getMeetingPortalUrl(input.portalUrl), input.workspaceId, joinCode),
  };
}

/**
 * Moves the still-scheduled meeting of an event to a new time. A meeting that
 * is running or finished is history and is left alone. Returns how many
 * meetings changed.
 */
export async function rescheduleBookingMeeting(
  db: BookingMeetingDb,
  params: { eventId: string; start: Date; end: Date },
): Promise<number> {
  const { meetings } = schema;
  const updated = await db
    .update(meetings)
    .set({ scheduledStart: params.start, scheduledEnd: params.end, updatedAt: new Date() })
    .where(
      and(
        eq(meetings.calendarEventId, params.eventId),
        isNull(meetings.deletedAt),
        eq(meetings.status, 'scheduled'),
      ),
    )
    .returning({ id: meetings.id });
  return updated.length;
}

/**
 * Cancels the still-scheduled meeting of an event (the booking was cancelled),
 * the way calendar-api does when an event is cancelled. Returns how many
 * meetings changed.
 */
export async function cancelBookingMeeting(db: BookingMeetingDb, eventId: string): Promise<number> {
  const { meetings } = schema;
  const cancelled = await db
    .update(meetings)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(
      and(
        eq(meetings.calendarEventId, eventId),
        isNull(meetings.deletedAt),
        eq(meetings.status, 'scheduled'),
      ),
    )
    .returning({ id: meetings.id });
  return cancelled.length;
}
