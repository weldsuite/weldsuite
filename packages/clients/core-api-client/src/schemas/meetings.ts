import { z } from 'zod';

/**
 * ISO-8601 timestamp as sent by `Date.prototype.toISOString()`. Offsets
 * (`+02:00`) are accepted too; the route turns the string into a `Date`.
 */
const isoTimestamp = z.string().datetime({ offset: true });

/** An attendee as sent on create: an email is enough, the route fills in the rest. */
const createAttendeeSchema = z
  .object({
    email: z.string().email(),
    name: z.string().optional(),
  })
  .passthrough();

const meetingFields = {
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  scheduledAt: z.string().optional(),
  durationMinutes: z.number().int().optional(),
  hostId: z.string().nullish(),
  participants: z.array(z.string()).optional(),
  metadata: z.unknown().optional(),
  meetingType: z.enum(['video', 'audio']).optional(),
  accessType: z.enum(['workspace', 'invited_only', 'anyone_with_link']).optional(),
  waitingRoom: z.boolean().optional(),
  allowRecording: z.boolean().optional(),
  scheduledStart: isoTimestamp.nullish(),
  scheduledEnd: isoTimestamp.nullish(),
  /** Id of the calendar event this meeting belongs to (see calendar-api `weldMeetingId`). */
  calendarEventId: z.string().max(30).nullish(),
};

export const createMeetingSchema = z
  .object({
    ...meetingFields,
    attendees: z.array(createAttendeeSchema).optional(),
  })
  .passthrough();

// PATCH keeps `attendees` loose: existing callers send the full stored shape
// (userId, status, role, ...) and it is written as given.
export const updateMeetingSchema = z
  .object({
    ...meetingFields,
    attendees: z.array(z.unknown()).optional(),
  })
  .partial()
  .passthrough();
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
