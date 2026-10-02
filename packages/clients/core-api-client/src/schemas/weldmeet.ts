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

// One definition: the strict allow-list schemas live in ./meetings (they are what
// POST /meetings and PATCH /meetings/:id validate against).
export {
  createMeetingSchema,
  updateMeetingSchema,
  type CreateMeetingInput,
  type UpdateMeetingInput,
} from './meetings';

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
  /**
   * Rejoin stints. joinedAt / leftAt describe the CURRENT stint; total time in
   * the meeting = priorSeconds + (leftAt - joinedAt). Absent when never rejoined.
   */
  firstJoinedAt?: string;
  /** Seconds spent in earlier stints. */
  priorSeconds?: number;
  /** Number of stints (1 = never rejoined). */
  stints?: number;
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
  /** @deprecated Legacy expiring Cloudflare URL. Use the recordings routes (`recording/access`). */
  recordingUrl: string | null;
  /** @deprecated Legacy marker. */
  recordingKey: string | null;
  // RealtimeKit recorder state (server-owned, optional so older payloads still type-check).
  rtkSessionId?: string | null;
  /** null = never recorded; recording | processing | ready | failed | unavailable | deleted */
  recordingStatus?: 'recording' | 'processing' | 'ready' | 'failed' | 'unavailable' | 'deleted' | null;
  recordingDurationSeconds?: number | null;
  recordingSizeBytes?: number | null;
  recordingReadyAt?: string | null;
  recordingError?: string | null;
  aiTranscribeRequested?: boolean | null;
  aiSummarizeRequested?: boolean | null;
  aiLanguage?: string | null;
  summaryStatus?: 'pending' | 'processing' | 'completed' | 'failed' | null;
  /** Markdown. */
  summaryText?: string | null;
  summarySource?: 'rtk' | 'workers_ai' | null;
  summaryGeneratedAt?: string | null;
  summaryError?: string | null;
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
  /**
   * Always null now: recordings are private. Mint a playable URL with
   * `POST /meeting-sessions/:sessionId/recording/access`.
   */
  recordingUrl: string | null;
  /** @deprecated Legacy marker, always null. */
  recordingKey: string | null;
  cfAppId: string | null;
  /** null = legacy row that predates the recorder state. */
  recordingStatus?: 'recording' | 'processing' | 'ready' | 'failed' | 'unavailable' | 'deleted' | null;
  hasAudio?: boolean;
  hasTranscript?: boolean;
  hasSummary?: boolean;
  recordingDurationSeconds?: number | null;
  recordingSizeBytes?: number | null;
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
  /** @deprecated No longer returned: the recording is copied to private storage after the stop. */
  recordingUrl?: string;
}

export interface OkResult {
  ok: true;
}
