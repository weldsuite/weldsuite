/**
 * WeldMeet React Query Hooks
 *
 * TanStack Query hooks for meetings and sessions.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApi, useAppApiClient } from '@/lib/api/use-app-api';
import type { RemoveMeetingSessionParticipantInput } from '@weldsuite/app-api-client/schemas/meeting-sessions';
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

/** The meeting's organizer as meet-api resolves it (always on list items). */
export interface MeetingOrganizer {
  userId: string;
  name: string | null;
  avatar: string | null;
}

/** One participant of a session. Rejoin stints are merged into one entry per user. */
export interface MeetingLastSessionParticipant {
  userId: string;
  userName: string | null;
  userAvatar: string | null;
  joinedAt: string | null;
  leftAt: string | null;
  /** First time the user joined, across rejoins. */
  firstJoinedAt?: string;
  /** Seconds spent in earlier stints (the current stint is joinedAt..leftAt). */
  priorSeconds?: number;
  /** Number of join/leave stints merged into this entry. */
  stints?: number;
}

/** Latest session of a meeting; present on list items with `include=lastSession`. */
export interface MeetingLastSession {
  id: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  /** Seconds. */
  duration: number | null;
  recordingStatus: string | null;
  participants: MeetingLastSessionParticipant[];
}

/** List filters of `GET /meetings`, on top of the shared client params. */
export type MeetingListParams = ListMeetingsParams & {
  /** `upcoming`: not yet ended (past-scheduled ones left out); `history`: ended or ran. */
  view?: 'upcoming' | 'history';
  /** `lastSession` adds each meeting's latest session to the list items. */
  include?: 'lastSession';
};

export interface Meeting extends Partial<HostControls> {
  id: string;
  title: string;
  description?: string;
  calendarEventId?: string;
  organizerId: string;
  /** Always present on list items; may be missing on a single-meeting read. */
  organizer?: MeetingOrganizer | null;
  /** Only with `include=lastSession`. */
  lastSession?: MeetingLastSession | null;
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
  /** First join across rejoin stints (the session endpoint merges stints per user). */
  firstJoinedAt?: string;
  /** Seconds spent in earlier stints. */
  priorSeconds?: number;
  /** Number of join/leave stints merged into this entry. */
  stints?: number;
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
  meetings: (params?: MeetingListParams) => [...weldmeetKeys.all, 'meetings', params] as const,
  meeting: (id: string) => [...weldmeetKeys.all, 'meeting', id] as const,
  upcoming: (params?: { days?: number; limit?: number }) => [...weldmeetKeys.all, 'upcoming', params] as const,
  session: (meetingId: string) => [...weldmeetKeys.all, 'session', meetingId] as const,
  sessionDetail: (meetingId: string, sessionId: string) => [...weldmeetKeys.all, 'session', meetingId, sessionId] as const,
  latestSession: (meetingId: string) => [...weldmeetKeys.all, 'latest-session', meetingId] as const,
};

// ============================================================================
// Meeting Queries
// ============================================================================

export function useMeetings(params?: MeetingListParams) {
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
      if (params?.view) qs.set('view', params.view);
      if (params?.include) qs.set('include', params.include);
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
/** Options of the latest-session query, shared by the hook and by imperative
 *  `queryClient.fetchQuery` calls (e.g. the in-call participant resolver). */
export function latestSessionQueryOptions(
  getClient: ReturnType<typeof useAppApiClient>['getClient'],
  meetingId: string,
) {
  return {
    queryKey: weldmeetKeys.latestSession(meetingId),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: MeetingSession | null }>(`/meeting-sessions/latest?meetingId=${encodeURIComponent(meetingId)}`);
      return (res.data ?? null) as MeetingSession | null;
    },
  };
}

export function useLatestSession(meetingId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    ...latestSessionQueryOptions(getClient, meetingId),
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
      void queryClient.invalidateQueries({ queryKey: weldmeetKeys.all });
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
      void queryClient.invalidateQueries({ queryKey: weldmeetKeys.meeting(variables.id) });
      void queryClient.invalidateQueries({ queryKey: weldmeetKeys.all });
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
      void queryClient.invalidateQueries({ queryKey: weldmeetKeys.all });
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
      void queryClient.invalidateQueries({ queryKey: weldmeetKeys.all });
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
      void queryClient.invalidateQueries({ queryKey: weldmeetKeys.meeting(id) });
      void queryClient.invalidateQueries({ queryKey: weldmeetKeys.all });
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

/** Policy fields the Host Controls panel shows that live on the meeting itself. */
export type MeetingLevelPolicyInput = Pick<UpdateMeetingRequest, 'waitingRoom' | 'accessType'>;
export type MeetingPolicyPatch = HostControlsInput & MeetingLevelPolicyInput;

/**
 * Persist a Host Controls panel change. The panel mixes two kinds of fields:
 * the narrow host-control policy (`PATCH /meetings/:id/host-controls`, which
 * strips anything it does not know) and meeting-level fields such as
 * `waitingRoom` (`PATCH /meetings/:id`). Sending everything to the first
 * endpoint silently dropped `waitingRoom` and the toggle snapped back, so the
 * patch is split here and each part goes to the endpoint that persists it.
 * `controls` is null when the patch held no host-control fields.
 */
export function useUpdateMeetingPolicy() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ meetingId, patch }: { meetingId: string; patch: MeetingPolicyPatch }) => {
      const { waitingRoom, accessType, ...hostPatch } = patch;
      const meetingPatch: MeetingLevelPolicyInput = {};
      if (waitingRoom !== undefined) meetingPatch.waitingRoom = waitingRoom;
      if (accessType !== undefined) meetingPatch.accessType = accessType;

      const client = await getClient();
      const [controlsRes] = await Promise.all([
        Object.keys(hostPatch).length > 0
          ? client.patch<{ data: HostControls }>(`/meetings/${meetingId}/host-controls`, hostPatch)
          : Promise.resolve(null),
        Object.keys(meetingPatch).length > 0
          ? client.patch<{ data: unknown }>(`/meetings/${meetingId}`, meetingPatch)
          : Promise.resolve(null),
      ]);
      return { meetingId, controls: controlsRes?.data ?? null, meetingPatch };
    },
    onSuccess: ({ meetingId, controls, meetingPatch }) => {
      queryClient.setQueryData(weldmeetKeys.meeting(meetingId), (prev: Meeting | null | undefined) => {
        if (!prev) return prev;
        return { ...prev, ...(controls ?? {}), ...meetingPatch } as Meeting;
      });
      if (Object.keys(meetingPatch).length > 0) {
        // Lists show waiting-room / access state too.
        void queryClient.invalidateQueries({ queryKey: weldmeetKeys.all });
      }
    },
  });
}

/**
 * Host "Remove from call". The API records the removal on the session (a
 * removed guest cannot rejoin it) and kicks the participant server-side; the
 * result's `kicked` tells the caller whether RealtimeKit confirmed the kick.
 */
export function useRemoveMeetingParticipant() {
  const { meetingSessions } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      sessionId,
      participant,
    }: {
      sessionId: string;
      meetingId: string;
      participant: RemoveMeetingSessionParticipantInput;
    }) => {
      const res = await meetingSessions.removeParticipant(sessionId, participant);
      return res.data;
    },
    onSuccess: (_result, { meetingId }) => {
      void queryClient.invalidateQueries({ queryKey: weldmeetKeys.session(meetingId) });
      void queryClient.invalidateQueries({ queryKey: weldmeetKeys.latestSession(meetingId) });
    },
  });
}

export function useJoinByCode() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (joinCode: string) => {
      const client = await getClient();
      const res = await client.get<{ data: Meeting }>(`/meetings/join/${encodeURIComponent(joinCode)}`);
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
