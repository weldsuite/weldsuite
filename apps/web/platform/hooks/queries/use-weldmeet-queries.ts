/**
 * WeldMeet React Query Hooks
 *
 * TanStack Query hooks for meetings and sessions.
 */

import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
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
      const res = await client.get<any>(`/meetings${query ? '?' + query : ''}`);
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

function useActiveSession(meetingId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldmeetKeys.session(meetingId),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: MeetingSession | null }>(`/meeting-sessions/active?meetingId=${encodeURIComponent(meetingId)}`);
      return (res.data ?? null) as MeetingSession | null;
    },
    enabled: !!meetingId,
    refetchInterval: 10_000,
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
      const res = await client.patch<{ data: any }>(`/meetings/${id}`, data);
      return res.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: weldmeetKeys.meeting(variables.id) });
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
}

// ============================================================================
// Session Mutations
// ============================================================================

function useStartSession() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (meetingId: string) => {
      const client = await getClient();
      const res = await client.post<{ data: { sessionId: string; status: string; rtkMeetingId: string } }>('/meeting-sessions/start', { meetingId });
      return res.data;
    },
    onSuccess: (_, meetingId) => {
      queryClient.invalidateQueries({ queryKey: weldmeetKeys.session(meetingId) });
      queryClient.invalidateQueries({ queryKey: weldmeetKeys.meeting(meetingId) });
    },
  });
}

function useJoinSession() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ sessionId }: { meetingId: string; sessionId: string }) => {
      const client = await getClient();
      const res = await client.post<{ data: { sessionId: string; authToken: string; participants: MeetingSessionParticipant[] } }>(`/meeting-sessions/${sessionId}/join`);
      return res.data;
    },
  });
}

function useLeaveSession() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ meetingId, sessionId }: { meetingId: string; sessionId: string }) => {
      const client = await getClient();
      await client.post(`/meeting-sessions/${sessionId}/leave`);
    },
    onSuccess: (_, { meetingId }) => {
      queryClient.invalidateQueries({ queryKey: weldmeetKeys.session(meetingId) });
      queryClient.invalidateQueries({ queryKey: weldmeetKeys.meeting(meetingId) });
    },
  });
}

function useEndSession() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ meetingId, sessionId }: { meetingId: string; sessionId: string }) => {
      const client = await getClient();
      await client.post(`/meeting-sessions/${sessionId}/end`);
    },
    onSuccess: (_, { meetingId }) => {
      queryClient.invalidateQueries({ queryKey: weldmeetKeys.session(meetingId) });
      queryClient.invalidateQueries({ queryKey: weldmeetKeys.meeting(meetingId) });
    },
  });
}

export function useJoinByCode() {
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
// Recording Queries
// ============================================================================

export interface MeetingRecordingEntry {
  sessionId: string;
  meetingId: string;
  recordingUrl: string | null;
  recordingKey: string | null;
  startedAt: string | null;
  endedAt: string | null;
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
  });
}

// ============================================================================
// Recording Mutations
// ============================================================================

function useStartRecording() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ sessionId }: { meetingId: string; sessionId: string }) => {
      const client = await getClient();
      await client.post(`/meeting-sessions/${sessionId}/recording/start`);
    },
  });
}

function useStopRecording() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ sessionId }: { meetingId: string; sessionId: string }) => {
      const client = await getClient();
      const res = await client.post<{ data: { ok: boolean; recordingUrl?: string } }>(`/meeting-sessions/${sessionId}/recording/stop`);
      return res.data;
    },
  });
}

function useSessionRecordings(meetingId: string, sessionId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...weldmeetKeys.all, 'recordings', meetingId, sessionId] as const,
    queryFn: async () => {
      const client = await getClient();
      // app-api returns { data: { recordings: any[]; savedUrl: string | null } }
      const res = await client.get<{ data: { recordings: any[]; savedUrl: string | null } }>(`/meeting-sessions/${sessionId}/recordings`);
      return res.data;
    },
    enabled: !!meetingId && !!sessionId,
  });
}

// ============================================================================
// Meeting Recording + Transcription
// ============================================================================

export function useMeetingRecordingUrl(meetingId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...weldmeetKeys.all, 'recording-url', meetingId] as const,
    queryFn: async () => {
      const client = await getClient();
      // app-api returns { data: { url, sessionId, duration } } (200) or
      // { data: null, processing: true } (202) when still processing.
      const res = await client.get<any>(`/meetings/${meetingId}/recording`);
      if (!res.data?.url) return null;
      return res.data as { url: string; sessionId: string; duration: number | null };
    },
    enabled: !!meetingId,
    // Retry every 5s while recording is still processing (returns null)
    refetchInterval: (query) => query.state.data === null ? 5000 : false,
  });
}

export function useTranscribeMeeting() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ meetingId, language }: { meetingId: string; language?: string }) => {
      const client = await getClient();
      // app-api returns { data: { id, status } }
      return client.post<{ data: { id: string; status: string } }>(`/meetings/${meetingId}/recording/transcribe`, { language });
    },
  });
}
