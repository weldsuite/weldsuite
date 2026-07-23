/**
 * WeldMeet domain types.
 *
 * Request shapes shared by the WeldMeet UI and `hooks/queries/use-weldmeet-queries.ts`,
 * which talks to app-api directly via `useAppApiClient()`.
 *
 * This module used to also export a `weldmeetWorkerApi` transport bound to the
 * obsolete api-worker. The WeldMeet → app-api migration rewrote the hooks against
 * `/api/meetings` + `/api/meeting-sessions`, leaving the transport module-private
 * and unreferenced; it was removed in W5c. The types below are the live surface.
 */

// ============================================================================
// Request Types
// ============================================================================

export interface MeetingAttendee {
  userId: string;
  email: string;
  name: string;
  avatar?: string;
  status: 'pending' | 'accepted' | 'declined' | 'tentative';
  role: 'organizer' | 'attendee';
}

export interface CreateMeetingRequest {
  title: string;
  description?: string;
  meetingType?: 'video' | 'audio';
  accessType?: 'workspace' | 'invited_only' | 'anyone_with_link';
  waitingRoom?: boolean;
  allowRecording?: boolean;
  maxParticipants?: number;
  attendees?: MeetingAttendee[];
  scheduledStart?: string;
  scheduledEnd?: string;
  isRecurring?: boolean;
  recurrenceRule?: string;
  createCalendarEvent?: boolean;
  tags?: string[];
}

export interface UpdateMeetingRequest {
  title?: string;
  description?: string;
  meetingType?: 'video' | 'audio';
  accessType?: 'workspace' | 'invited_only' | 'anyone_with_link';
  waitingRoom?: boolean;
  allowRecording?: boolean;
  maxParticipants?: number | null;
  attendees?: MeetingAttendee[];
  scheduledStart?: string;
  scheduledEnd?: string;
  tags?: string[];
}

export interface ListMeetingsParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  /** Filter to meetings where an attendee has this counterparty (Company or Person). */
  counterpartyId?: string;
  /** Filter to meetings where the given Person is an attendee. */
  personId?: string;
}
