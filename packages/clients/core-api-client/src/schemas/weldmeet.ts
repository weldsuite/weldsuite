import { z } from 'zod';

// ============================================================================
// Shared
// ============================================================================

export const meetingAttendeeSchema = z.object({
  userId: z.string().optional().default(''),
  email: z.string().email(),
  name: z.string().min(1),
  avatar: z.string().optional(),
  status: z.enum(['pending', 'accepted', 'declined', 'tentative']).default('pending'),
  role: z.enum(['organizer', 'attendee']).default('attendee'),
  workspaceMemberId: z.string().nullish(),
  /** Canonical link going forward (identity layer). */
  personId: z.string().nullish(),
  /** @deprecated kept for historical rows; new writes target personId. */
  contactId: z.string().nullish(),
});

export type MeetingAttendeeInput = z.infer<typeof meetingAttendeeSchema>;

const validMeetingStatuses = ['scheduled', 'in_progress', 'completed', 'cancelled'] as const;
export type MeetingStatus = (typeof validMeetingStatuses)[number];

// ============================================================================
// Host controls
// ============================================================================

/**
 * Host-control policy fields on a meeting. Mirrors the `meetings` table
 * columns added for the in-meeting Host Controls panel. Defaults to all true
 * EXCEPT `autoRecord`, `hostMustJoinFirst`, `lockAfterStart`, `enableCaptions`,
 * `allowParticipantRecord` — these default false to preserve current behaviour
 * for existing meetings.
 */
export const hostControlsSchema = z.object({
  hostManagement: z.boolean().optional(),
  allowScreenShare: z.boolean().optional(),
  allowMicrophone: z.boolean().optional(),
  allowVideo: z.boolean().optional(),
  allowHandRaise: z.boolean().optional(),
  allowReactions: z.boolean().optional(),
  allowAnnotations: z.boolean().optional(),
  allowVirtualBackgrounds: z.boolean().optional(),
  allowParticipantRecord: z.boolean().optional(),
  allowThirdPartyAccess: z.boolean().optional(),
  noiseCancellation: z.boolean().optional(),
  enableCaptions: z.boolean().optional(),
  autoRecord: z.boolean().optional(),
  hostMustJoinFirst: z.boolean().optional(),
  lockAfterStart: z.boolean().optional(),
  autoEndOnInactivity: z.boolean().optional(),
  autoEndInactivityMinutes: z.number().int().min(1).max(180).optional(),
});

export type HostControlsInput = z.infer<typeof hostControlsSchema>;

export interface HostControls {
  hostManagement: boolean;
  allowScreenShare: boolean;
  allowMicrophone: boolean;
  allowVideo: boolean;
  allowHandRaise: boolean;
  allowReactions: boolean;
  allowAnnotations: boolean;
  allowVirtualBackgrounds: boolean;
  allowParticipantRecord: boolean;
  allowThirdPartyAccess: boolean;
  noiseCancellation: boolean;
  enableCaptions: boolean;
  autoRecord: boolean;
  hostMustJoinFirst: boolean;
  lockAfterStart: boolean;
  autoEndOnInactivity: boolean;
  autoEndInactivityMinutes: number;
}

export const DEFAULT_HOST_CONTROLS: HostControls = {
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

// ============================================================================
// Mutations — instant meeting (already shipped)
// ============================================================================

export const startInstantMeetingSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  meetingType: z.enum(['video', 'audio']).optional(),
  accessType: z.enum(['workspace', 'invited_only', 'anyone_with_link']).optional(),
  waitingRoom: z.boolean().optional(),
});

export type StartInstantMeetingInput = z.infer<typeof startInstantMeetingSchema>;

// ============================================================================
// Mutations — meeting CRUD
// ============================================================================

export const createMeetingSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  meetingType: z.enum(['video', 'audio']).default('video'),
  accessType: z.enum(['workspace', 'invited_only', 'anyone_with_link']).default('workspace'),
  waitingRoom: z.boolean().default(false),
  allowRecording: z.boolean().default(true),
  maxParticipants: z.number().int().positive().optional(),
  attendees: z.array(meetingAttendeeSchema).default([]),
  scheduledStart: z.string().datetime().optional(),
  scheduledEnd: z.string().datetime().optional(),
  isRecurring: z.boolean().default(false),
  recurrenceRule: z.string().optional(),
  createCalendarEvent: z.boolean().default(false),
  tags: z.array(z.string()).optional(),
}).merge(hostControlsSchema);

export type CreateMeetingInput = z.infer<typeof createMeetingSchema>;

export const updateMeetingSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  meetingType: z.enum(['video', 'audio']).optional(),
  accessType: z.enum(['workspace', 'invited_only', 'anyone_with_link']).optional(),
  waitingRoom: z.boolean().optional(),
  allowRecording: z.boolean().optional(),
  maxParticipants: z.number().int().positive().nullable().optional(),
  attendees: z.array(meetingAttendeeSchema).optional(),
  scheduledStart: z.string().datetime().optional(),
  scheduledEnd: z.string().datetime().optional(),
  tags: z.array(z.string()).optional(),
  sendNotification: z.boolean().default(false),
}).merge(hostControlsSchema);

export type UpdateMeetingInput = z.infer<typeof updateMeetingSchema>;

export const listMeetingsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  status: z.string().optional(),
});

export type ListMeetingsQuery = z.infer<typeof listMeetingsQuerySchema>;

export const upcomingMeetingsQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(365).default(7),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export type UpcomingMeetingsQuery = z.infer<typeof upcomingMeetingsQuerySchema>;

export const cancelMeetingQuerySchema = z.object({
  sendNotification: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (typeof v === 'string' ? v === 'true' : !!v)),
});

export type CancelMeetingQuery = z.infer<typeof cancelMeetingQuerySchema>;

// ============================================================================
// Response Interfaces
// ============================================================================

export interface MeetingSessionParticipantSummary {
  userId: string;
  userName: string;
  userAvatar?: string;
  joinedAt: string;
  cfSessionId?: string;
}

export interface MeetingAttendee {
  userId: string;
  email: string;
  name: string;
  avatar?: string;
  status: 'pending' | 'accepted' | 'declined' | 'tentative';
  role: 'organizer' | 'attendee';
  workspaceMemberId?: string;
  /** Canonical link going forward (identity layer). */
  personId?: string;
  /** @deprecated kept for historical rows; new writes target personId. */
  contactId?: string;
}

export interface Meeting extends HostControls {
  id: string;
  title: string;
  description: string | null;
  calendarEventId: string | null;
  organizerId: string;
  attendees: MeetingAttendee[];
  meetingType: 'video' | 'audio';
  status: MeetingStatus;
  accessType: 'workspace' | 'invited_only' | 'anyone_with_link';
  waitingRoom: boolean;
  allowRecording: boolean;
  maxParticipants: number | null;
  joinCode: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  isRecurring: boolean;
  recurrenceRule: string | null;
  parentMeetingId: string | null;
  activeSessionId: string | null;
  chatChannelId: string | null;
  tags: string[] | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface MeetingSessionParticipant {
  userId: string;
  userName: string;
  userAvatar?: string;
  joinedAt: string;
  leftAt?: string;
  cfSessionId?: string;
  hasAudio?: boolean;
  hasVideo?: boolean;
  hasScreenShare?: boolean;
  workspaceMemberId?: string;
  /** Canonical link going forward (identity layer). */
  personId?: string;
  /** @deprecated kept for historical rows; new writes target personId. */
  contactId?: string;
}

export interface MeetingSession {
  id: string;
  meetingId: string;
  sessionType: 'video' | 'audio';
  status: 'waiting' | 'active' | 'ended';
  cfAppId: string | null;
  startedBy: string;
  startedByName: string | null;
  participants: MeetingSessionParticipant[];
  startedAt: string | null;
  endedAt: string | null;
  duration: number | null;
  maxParticipants: number | null;
  recordingEnabled: boolean;
  recordingUrl: string | null;
  recordingKey: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Single-shot response from POST /api/weldmeet/sessions/start-instant.
 */
export interface StartInstantMeetingResult {
  meetingId: string;
  sessionId: string;
  rtkMeetingId: string;
  authToken: string;
  joinCode: string;
  participants: MeetingSessionParticipantSummary[];
}

export interface StartSessionResult {
  sessionId: string;
  status: 'waiting' | 'active';
  rtkMeetingId: string;
  /** Only set when ?join=true was passed. */
  authToken?: string;
  participants?: MeetingSessionParticipant[];
}

export interface JoinSessionResult {
  sessionId: string;
  authToken: string;
  participants: MeetingSessionParticipant[];
}

export interface RecordingSummary {
  sessionId: string;
  meetingId: string;
  recordingUrl: string | null;
  recordingKey: string | null;
  cfAppId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  duration: number | null;
  maxParticipants: number | null;
  meetingTitle: string;
  meetingType: 'video' | 'audio';
}

export interface CloudflareRecording {
  id: string;
  download_url?: string;
  status?: string;
  duration?: number;
  size?: number;
  started_at?: string;
  ended_at?: string;
}

export interface SessionRecordingsResult {
  recordings: CloudflareRecording[];
  savedUrl: string | null;
}

export interface CancelMeetingResult {
  ok: true;
}

export interface DeleteMeetingResult {
  ok: true;
}

export interface UpdateMeetingResult {
  id: string;
}

export interface CreateMeetingResult {
  id: string;
  joinCode: string;
}

export interface StopRecordingResult {
  ok: true;
  recordingUrl?: string;
}

export interface OkResult {
  ok: true;
}
