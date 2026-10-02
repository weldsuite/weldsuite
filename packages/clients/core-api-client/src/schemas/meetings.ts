import { z } from 'zod';

/**
 * ISO-8601 timestamp as sent by `Date.prototype.toISOString()`. Offsets
 * (`+02:00`) are accepted too; the route turns the string into a `Date`.
 */
const isoTimestamp = z.string().datetime({ offset: true });

/**
 * An attendee as sent on create / update. An email is enough, the route fills
 * in the rest. Only these keys are kept: the platform sends the full stored
 * shape back on PATCH, and anything else is dropped.
 *
 * The link / identity keys (userId, role, source, workspaceMemberId, personId,
 * contactId, counterpartyId) are accepted so that round trip validates, but the
 * server does NOT trust them: meet-api keeps what is already stored for the
 * same email and re-resolves new attendees from their email.
 */
export const meetingAttendeeInputSchema = z.object({
  userId: z.string().max(255).optional(),
  email: z.string().trim().email().max(255),
  name: z.string().trim().max(255).optional(),
  avatar: z.string().max(2048).nullish(),
  status: z.enum(['pending', 'accepted', 'declined', 'tentative']).optional(),
  role: z.enum(['organizer', 'attendee']).optional(),
  /** Marks a guest who walked in through the public link (kept so a PATCH round-trips it). */
  source: z.literal('walk_in').optional(),
  workspaceMemberId: z.string().max(64).nullish(),
  personId: z.string().max(64).nullish(),
  /** @deprecated legacy back-reference; new writes target personId. */
  contactId: z.string().max(64).nullish(),
  counterpartyId: z.string().max(64).nullish(),
});
export type MeetingAttendeeWriteInput = z.infer<typeof meetingAttendeeInputSchema>;

/**
 * The fields a client may write on a meeting. This is an allow-list, not a
 * passthrough: id, organizerId, status, deletedAt, timestamps, activeSessionId,
 * joinCode, chatChannelId, parentMeetingId and the in-call host controls (which
 * have their own organizer-only route, PATCH /:id/host-controls) are never
 * accepted here, and unknown keys are stripped.
 */
const meetingFields = {
  title: z.string().min(1).max(255),
  description: z.string().max(20000).nullish(),
  meetingType: z.enum(['video', 'audio']).optional(),
  accessType: z.enum(['workspace', 'invited_only', 'anyone_with_link']).optional(),
  waitingRoom: z.boolean().optional(),
  allowRecording: z.boolean().optional(),
  maxParticipants: z.number().int().positive().nullish(),
  attendees: z.array(meetingAttendeeInputSchema).max(200).optional(),
  scheduledStart: isoTimestamp.nullish(),
  scheduledEnd: isoTimestamp.nullish(),
  /** Id of the calendar event this meeting belongs to (see calendar-api `weldMeetingId`). */
  calendarEventId: z.string().max(30).nullish(),
  isRecurring: z.boolean().optional(),
  recurrenceRule: z.string().max(500).nullish(),
  tags: z.array(z.string().max(100)).max(50).nullish(),
};

export const createMeetingSchema = z.object({
  ...meetingFields,
  /**
   * Create the meeting on behalf of someone else. Honoured only for callers
   * holding `meetings:scope:all`; everyone else always organizes their own.
   */
  organizerId: z.string().min(1).max(255).optional(),
  /** Sent by the mobile app. Accepted and ignored: the calendar link is `calendarEventId`. */
  createCalendarEvent: z.boolean().optional(),
});

export const updateMeetingSchema = z.object(meetingFields).partial();
export type CreateMeetingInput = z.infer<typeof createMeetingSchema>;
export type UpdateMeetingInput = z.infer<typeof updateMeetingSchema>;

/**
 * POST /api/meetings/:id/invitations — invite people (workspace members, CRM
 * people or any email address) to a meeting. Each invitee is added to the
 * meeting's attendees and, unless `sendEmail` is false, emailed the join link.
 */
export const meetingInviteeSchema = z.object({
  email: z.string().trim().email().max(255),
  name: z.string().trim().max(255).optional(),
});
export const inviteMeetingAttendeesSchema = z.object({
  invitees: z.array(meetingInviteeSchema).min(1).max(50),
  sendEmail: z.boolean().optional(),
});
export type MeetingInviteeInput = z.infer<typeof meetingInviteeSchema>;
export type InviteMeetingAttendeesInput = z.infer<typeof inviteMeetingAttendeesSchema>;
