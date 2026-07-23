/**
 * Zod schemas for the meeting-portal.
 *
 * Two roles:
 *   1. Validate API responses (meeting info, join result, waitlist status) at
 *      the client boundary so React state can rely on typed shapes.
 *   2. Validate API inputs (route handlers) so we don't trust raw form posts
 *      or query strings.
 */

import { z } from 'zod';

// ── Host controls ─────────────────────────────────────────────────────────

export const guestHostControlsSchema = z.object({
  hostManagement: z.boolean(),
  allowScreenShare: z.boolean(),
  allowMicrophone: z.boolean(),
  allowVideo: z.boolean(),
  allowHandRaise: z.boolean(),
  allowReactions: z.boolean(),
  allowAnnotations: z.boolean(),
  allowVirtualBackgrounds: z.boolean(),
  allowParticipantRecord: z.boolean(),
  allowThirdPartyAccess: z.boolean(),
  noiseCancellation: z.boolean(),
  enableCaptions: z.boolean(),
  autoRecord: z.boolean(),
  hostMustJoinFirst: z.boolean(),
  lockAfterStart: z.boolean(),
  autoEndOnInactivity: z.boolean(),
  autoEndInactivityMinutes: z.number().int().nonnegative(),
});

export type GuestHostControls = z.infer<typeof guestHostControlsSchema>;

/**
 * Default host-control policy used before /api/meeting/info responds. Matches
 * the permissive defaults DEFAULT_HOST_CONTROLS in weldmeet schemas. Living
 * next to the schema so changes stay in lock-step.
 */
export const DEFAULT_GUEST_HOST_CONTROLS: GuestHostControls = {
  hostManagement: true,
  allowScreenShare: true,
  allowMicrophone: true,
  allowVideo: true,
  allowHandRaise: true,
  allowReactions: true,
  allowAnnotations: true,
  allowVirtualBackgrounds: true,
  allowParticipantRecord: false,
  allowThirdPartyAccess: true,
  noiseCancellation: true,
  enableCaptions: false,
  autoRecord: false,
  hostMustJoinFirst: false,
  lockAfterStart: false,
  autoEndOnInactivity: true,
  autoEndInactivityMinutes: 10,
};

// ── Attendees (limited subset shown to guests) ────────────────────────────

export const guestAttendeeSchema = z.object({
  name: z.string(),
  avatar: z.string().optional(),
  role: z.string(),
});

export type GuestAttendee = z.infer<typeof guestAttendeeSchema>;

// ── Meeting info response ─────────────────────────────────────────────────

export const meetingInfoSchema = z.object({
  id: z.string(),
  title: z.string(),
  scheduledStart: z.string().nullable(),
  scheduledEnd: z.string().nullable(),
  meetingType: z.string(),
  status: z.string(),
  accessType: z.string(),
  organizerName: z.string(),
  hasActiveSession: z.boolean(),
  attendees: z.array(guestAttendeeSchema).optional(),
  hostControls: guestHostControlsSchema.optional(),
  waitingRoom: z.boolean().optional(),
});

export type MeetingInfo = z.infer<typeof meetingInfoSchema>;

// ── Join result ───────────────────────────────────────────────────────────

export const guestJoinResultSchema = z.object({
  // 'ended' — the meeting is completed (host closed it). Terminal: the guest
  // cannot rejoin, the client shows the "already ended" screen instead of
  // dropping into an infinite waiting/connecting poll.
  status: z.enum(['joined', 'waiting', 'waitlisted', 'ended']),
  sessionId: z.string().optional(),
  authToken: z.string().optional(),
  meetingId: z.string(),
  meetingTitle: z.string(),
  /** Set when status === 'waitlisted'. Poll the waitlist-status endpoint with this id. */
  waitlistId: z.string().optional(),
  /** Optional context for status === 'waiting' (e.g. 'host_must_join_first'). */
  reason: z.string().optional(),
});

export type GuestJoinResult = z.infer<typeof guestJoinResultSchema>;

// ── Waitlist status ───────────────────────────────────────────────────────

export const waitlistStatusSchema = z.enum(['pending', 'admitted', 'denied']);
export type WaitlistStatus = z.infer<typeof waitlistStatusSchema>;

export const waitlistStatusResponseSchema = z.object({
  status: waitlistStatusSchema,
});

// ── API input schemas ─────────────────────────────────────────────────────

export const meetingInfoQuerySchema = z.object({
  orgId: z.string().min(1),
  joinCode: z.string().min(1),
});

export const guestJoinInputSchema = z.object({
  orgId: z.string().min(1),
  joinCode: z.string().min(1),
  name: z.string().trim().min(1).max(255),
  email: z.string().trim().email().max(255),
  colorSeed: z.string().optional(),
});

export type GuestJoinInput = z.infer<typeof guestJoinInputSchema>;

/** Subset used by the RHF landing form (name + email only). */
export const guestJoinFormSchema = guestJoinInputSchema.pick({
  name: true,
  email: true,
});

export type GuestJoinFormInput = z.infer<typeof guestJoinFormSchema>;

export const guestLeaveInputSchema = z.object({
  orgId: z.string().min(1),
  meetingId: z.string().min(1),
  sessionId: z.string().min(1),
  email: z.string().trim().email().max(255),
});

export const waitlistStatusQuerySchema = z.object({
  orgId: z.string().min(1),
  waitlistId: z.string().min(1),
});

export const messagesListQuerySchema = z.object({
  orgId: z.string().min(1),
  email: z.string().trim().email().max(255),
  before: z.string().optional(),
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined) return 50;
      const n = typeof v === 'number' ? v : parseInt(v, 10);
      if (!Number.isFinite(n)) return 50;
      return Math.min(Math.max(n, 1), 100);
    }),
});

/** Attachment shape persisted on a meeting message (matches db ChatAttachment). */
export const messageAttachmentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  fileSize: z.number(),
  mimeType: z.string(),
  url: z.string(),
  thumbnailUrl: z.string().optional(),
});

export type MessageAttachmentInput = z.infer<typeof messageAttachmentSchema>;

export const messagesPostInputSchema = z
  .object({
    orgId: z.string().min(1),
    email: z.string().trim().email().max(255),
    name: z.string().trim().min(1).max(255),
    // Allow empty content for attachment-only messages — the refine below
    // guarantees there is either text or at least one attachment.
    content: z.string().trim().max(4000).default(''),
    /** Sanitized rich-text HTML from the composer's formatting toolbar. */
    htmlContent: z.string().max(20000).optional(),
    attachments: z.array(messageAttachmentSchema).max(10).optional(),
  })
  .refine((d) => d.content.length > 0 || (d.attachments?.length ?? 0) > 0, {
    message: 'Message must have content or attachments',
  });
