import { z } from 'zod';

export const createMeetingSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  scheduledAt: z.string().optional(),
  durationMinutes: z.number().int().optional(),
  hostId: z.string().nullish(),
  participants: z.array(z.string()).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateMeetingSchema = createMeetingSchema.partial();
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
