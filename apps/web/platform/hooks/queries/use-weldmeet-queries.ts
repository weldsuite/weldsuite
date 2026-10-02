/**
 * WeldMeet React Query Hooks
 *
 * TanStack Query hooks for meetings and sessions.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { RecordingStatus } from '@weldsuite/app-api-client/schemas/weldmeet-recordings';
import type {
  HostControls,
  HostControlsInput,
} from '@weldsuite/core-api-client/schemas/weldmeet';
import type {
  CreateMeetingRequest,
  UpdateMeetingRequest,
  ListMeetingsParams,
  MeetingAttendee,
} from '@/lib/api/domains/weldmeet';

export type { HostControls, HostControlsInput };

// ============================================================================
// Types
// ============================================================================

export interface Meeting extends Partial<HostControls> {
  id: string;
  title: string;
  description?: string;
  calendarEventId?: string;
  organizerId: string;
  attendees: MeetingAttendee[];
  meetingType: 'video' | 'audio';
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  accessType: 'workspace' | 'invited_only' | 'anyone_with_link';
  waitingRoom: boolean;
  allowRecording: boolean;
  maxParticipants?: number;
  joinCode: string;
  activeSessionId?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  isRecurring: boolean;
  recurrenceRule?: string;
  parentMeetingId?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MeetingSession {
  id: string;
  meetingId: string;
  sessionType: 'video' | 'audio';
  status: 'waiting' | 'active' | 'ended';
  cfAppId?: string;
  startedBy: string;
  startedByName: string;
  participants: MeetingSessionParticipant[];
  startedAt?: string;
  endedAt?: string;
  duration?: number;
  maxParticipants: number;
  recordingEnabled: boolean;
  recordingUrl?: string;
  createdAt: string;
  updatedAt: string;
}

interface MeetingSessionParticipant {
  userId: string;
  userName: string;
  userAvatar?: string;
  joinedAt: string;
  leftAt?: string;
  cfSessionId: string;
  hasAudio: boolean;
  hasVideo: boolean;
  hasScreenShare: boolean;
}

// ============================================================================
// Query Keys
// ============================================================================

export const weldmeetKeys = {
  all: ['weldmeet'] as const,
  meetings: (params?: ListMeetingsParams) => [...weldmeetKeys.all, 'meetings', params] as const,
  meeting: (id: string) => [...weldmeetKeys.all, 'meeting', id] as const,
  upcoming: (params?: { days?: number; limit?: number }) => [...weldmeetKeys.all, 'upcoming', params] as const,
  session: (meetingId: string) => [...weldmeetKeys.all, 'session', meetingId] as const,
  sessionDetail: (meetingId: string, sessionId: string) => [...weldmeetKeys.all, 'session', meetingId, sessionId] as const,
  latestSession: (meetingId: string) => [...weldmeetKeys.all, 'latest-session', meetingId] as const,
};

// ============================================================================
// Meeting Queries
// ============================================================================

export function useMeetings(params?: ListMeetingsParams) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldmeetKeys.meetings(params),
    queryFn: async () => {
      const client = await getClient();
      const qs = new URLSearchParams();
      if (params?.pageSize) qs.set('limit', String(params.pageSize));
      if (params?.search) qs.set('search', params.search);
      if (params?.status) qs.set('status', params.status);
      if (params?.counterpartyId) qs.set('counterpartyId', params.counterpartyId);
      if (params?.personId) qs.set('personId', params.personId);
      const query = qs.toString();
      const res = await client.get<{ data: Meeting[]; pagination: unknown } | null>(`/meetings${query ? '?' + query : ''}`);
      return res ?? { data: [], pagination: null };
    },
  });
}

export function useMeeting(id: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldmeetKeys.meeting(id),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: Meeting }>(`/meetings/${id}`);
      return (res.data ?? null) as Meeting | null;
    },
    enabled: !!id,
  });
}

export function useUpcomingMeetings(params?: { days?: number; limit?: number }) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldmeetKeys.upcoming(params),
    queryFn: async () => {
      const client = await getClient();
      const qs = new URLSearchParams();
      if (params?.days) qs.set('days', String(params.days));
      if (params?.limit) qs.set('limit', String(params.limit));
      const query = qs.toString();
      const res = await client.get<{ data: Meeting[] }>(`/meetings/upcoming${query ? '?' + query : ''}`);
      return (res.data ?? []) as Meeting[];
    },
  });
}
export function useLatestSession(meetingId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldmeetKeys.latestSession(meetingId),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: MeetingSession | null }>(`/meeting-sessions/latest?meetingId=${encodeURIComponent(meetingId)}`);
      return (res.data ?? null) as MeetingSession | null;
    },
    enabled: !!meetingId,
  });
}

// ============================================================================
// Meeting Mutations
// ============================================================================

export function useCreateMeeting() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateMeetingRequest) => {
      const client = await getClient();
      const res = await client.post<{ data: { id: string; joinCode: string } }>('/meetings', data);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldmeetKeys.all });
    },
  });
}

export function useUpdateMeeting() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateMeetingRequest }) => {
      const client = await getClient();
      const res = await client.patch<{ data: unknown }>(`/meetings/${id}`, data);
      return res.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: weldmeetKeys.meeting(variables.id) });
      queryClient.invalidateQueries({ queryKey: weldmeetKeys.all });
    },
  });
}

export interface InviteToMeetingResult {
  attendees: MeetingAttendee[];
  /** Attendees added by this call; `emailSent` is false when no invitation email went out. */
  invited: { email: string; name: string; emailSent: boolean }[];
  /** Emails that were already on the meeting (left untouched). */
  alreadyInvited: string[];
}

/**
 * Invite people to a meeting by email: workspace members, CRM people or any
 * address. meet-api adds them to `attendees` (pending) and emails the join link.
 */
export function useInviteToMeeting() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      meetingId,
      invitees,
      sendEmail,
    }: {
      meetingId: string;
      invitees: { email: string; name?: string }[];
      sendEmail?: boolean;
    }) => {
      const client = await getClient();
      const res = await client.post<{ data: InviteToMeetingResult }>(
        `/meetings/${meetingId}/invitations`,
        { invitees, sendEmail },
      );
      return res.data;
    },
    onSuccess: (result, { meetingId }) => {
      queryClient.setQueryData(weldmeetKeys.meeting(meetingId), (prev: Meeting | null | undefined) =>
        prev ? { ...prev, attendees: result.attendees } : prev,
      );
      queryClient.invalidateQueries({ queryKey: weldmeetKeys.all });
    },
  });
}

export function useDeleteMeeting() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete(`/meetings/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldmeetKeys.all });
    },
  });
}

export function useCancelMeeting() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, sendNotification }: { id: string; sendNotification?: boolean }) => {
      const client = await getClient();
      await client.patch(`/meetings/${id}/cancel${sendNotification ? '?sendNotification=true' : ''}`);
    },
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: weldmeetKeys.meeting(id) });
      queryClient.invalidateQueries({ queryKey: weldmeetKeys.all });
    },
  });
}

/**
 * Patch the in-meeting host-control policy for a meeting. Uses core-api's
 * narrow `/host-controls` endpoint (organizer-only). On success, optimistically
 * merges the returned controls into the cached meeting so the panel reflects
 * the change without a refetch round-trip — and lets the caller forward the
 * same payload over RTK broadcastMessage('host-controls-updated', ...) so
 * remote participants get the change instantly.
 */
export function useUpdateHostControls() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ meetingId, patch }: { meetingId: string; patch: HostControlsInput }) => {
      const client = await getClient();
      const res = await client.patch<{ data: HostControls }>(`/meetings/${meetingId}/host-controls`, patch);
      return { meetingId, controls: res.data };
    },
    onSuccess: ({ meetingId, controls }) => {
      queryClient.setQueryData(weldmeetKeys.meeting(meetingId), (prev: Meeting | null | undefined) => {
        if (!prev) return prev;
        return { ...prev, ...controls } as Meeting;
      });
    },
  });
}export function useJoinByCode() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (joinCode: string) => {
      const client = await getClient();
      const res = await client.get<{ data: Meeting }>(`/meetings/join/${joinCode}`);
      return res.data as Meeting;
    },
  });
}

// ============================================================================
// Recording list
// ============================================================================

/**
 * One recorded session of a meeting, as listed by `GET /meetings/recordings`.
 * State only: there are no file URLs here. Play / download go through
 * `POST /meeting-sessions/:id/recording/access` (see use-weldmeet-recording-queries).
 */
export interface MeetingRecordingEntry {
  sessionId: string;
  meetingId: string;
  /** null = a legacy row that predates the recorder state and has not been backfilled yet. */
  recordingStatus: RecordingStatus | null;
  recordingDurationSeconds: number | null;
  recordingSizeBytes: number | null;
  hasAudio: boolean;
  hasTranscript: boolean;
  hasSummary: boolean;
  summaryStatus: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Session (meeting) duration in seconds. */
  duration: number | null;
  maxParticipants: number;
  meetingTitle: string;
  meetingType: string;
}

export function useRecordingsList() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...weldmeetKeys.all, 'recordings-list'] as const,
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: MeetingRecordingEntry[] }>('/meetings/recordings');
      return (res.data ?? []) as MeetingRecordingEntry[];
    },
    // Rows flip processing -> ready on their own; keep them fresh while any is in flight.
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.recordingStatus === 'processing' || r.recordingStatus === 'recording')
        ? 10_000
        : false,
  });
}
