/**
 * Call-intelligence hooks — app-api `/api/call-intelligence`, `/api/activities`,
 * `/api/meeting-bot-sessions`, `/api/telephony`.
 *
 * W5 repoint. Most of this file had already rotted: api-worker deleted
 * `/crm/activities` (42ff1442a) and never had `/crm/calls/meeting-bot/{join,leave,:id,...}`
 * or `/settings/telephony-rates`, so those hooks were 404ing. Only
 * `useFetchVoiceToken` is exported and reachable (via `global-call-panel.tsx`).
 *
 * The recording upload/download surface has no app-api home — see the
 * TODO(phase-out) block near the bottom.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

function buildQueryString(params: Record<string, any>): string {
  const queryParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      queryParams.set(key, String(value));
    }
  }
  const query = queryParams.toString();
  return query ? `?${query}` : '';
}

const callIntelligenceKeys = {
  all: ['crm', 'call-intelligence'] as const,
  calls: (filters?: Record<string, any>) => [...callIntelligenceKeys.all, 'calls', filters] as const,
  voiceToken: () => [...callIntelligenceKeys.all, 'voice-token'] as const,
  telephonyRates: () => ['settings', 'telephony-rates'] as const,
  meetingBot: () => [...callIntelligenceKeys.all, 'meeting-bot'] as const,
  meetingSession: (id: string) => [...callIntelligenceKeys.meetingBot(), 'session', id] as const,
  meetingTranscription: (id: string) => [...callIntelligenceKeys.meetingBot(), 'transcription', id] as const,
};

function useCalls(params?: { page?: number; limit?: number; search?: string }) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: callIntelligenceKeys.calls(params),
    queryFn: async () => {
      const client = await getClient();
      // `/crm/activities` was retired → `/activities`. Offset paging became
      // cursor paging, so `page` is dropped and `limit` caps at 100.
      const { page: _page, limit, ...rest } = (params ?? {}) as Record<string, any>;
      const query = buildQueryString({
        ...rest,
        type: 'call',
        limit: Math.min(Number(limit ?? 25), 100),
      });
      const [activitiesRes, botSessionsRes] = await Promise.all([
        client.get<{ data: any[] }>(`/activities${query}`),
        client.get<{ data: any[] }>('/meeting-bot-sessions?limit=100'),
      ]);
      return {
        activities: activitiesRes?.data || [],
        botSessions: botSessionsRes?.data || [],
      };
    },
  });
}

function useVoiceToken() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: callIntelligenceKeys.voiceToken(),
    queryFn: async () => {
      const client = await getClient();
      return client.post<any>('/call-intelligence/token', {});
    },
    enabled: false, // Only fetch on demand
  });
}

export function useFetchVoiceToken() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      return client.post<any>('/call-intelligence/token', {});
    },
  });
}

/**
 * Per-minute credit rates. The legacy `/settings/telephony-rates` path never
 * existed; app-api serves this as `/telephony/service-rates`, nesting the map
 * under `data.rates`.
 */
function useTelephonyRates() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: callIntelligenceKeys.telephonyRates(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{
        data: { rates: { voipCallMinute: number; callTranscriptionMinute: number } };
      }>('/telephony/service-rates');
    },
  });
}

/**
 * Dispatch a bot to an external meeting. app-api models this as creating the
 * session row (`POST /meeting-bot-sessions`, status `pending`) — the legacy
 * verb-style `/crm/calls/meeting-bot/join` never shipped.
 */
function useJoinMeetingBot() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      meetingUrl: string;
      platform?: string;
      enableDiarization?: boolean;
      enableAutoTranscribe?: boolean;
      transcriptionLanguage?: string;
      contactId?: string;
      opportunityId?: string;
      title?: string;
    }) => {
      const client = await getClient();
      const { enableAutoTranscribe, transcriptionLanguage, ...rest } = data;
      return client.post<any>('/meeting-bot-sessions', {
        ...rest,
        enableTranscription: enableAutoTranscribe,
        language: transcriptionLanguage,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: callIntelligenceKeys.meetingBot() });
    },
  });
}

/** Leaving is a status transition on the session row. */
function useLeaveMeetingBot() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const client = await getClient();
      return client.patch<any>(`/meeting-bot-sessions/${sessionId}`, {
        status: 'left',
        leftAt: new Date().toISOString(),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: callIntelligenceKeys.meetingBot() });
    },
  });
}

function useMeetingBotSession(sessionId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: callIntelligenceKeys.meetingSession(sessionId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<any>(`/meeting-bot-sessions/${sessionId}`);
    },
    enabled: !!sessionId && enabled,
    refetchInterval: 5000, // Poll every 5 seconds when active
  });
}

function useMeetingTranscription(sessionId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: callIntelligenceKeys.meetingTranscription(sessionId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<any>(`/meeting-bot-sessions/${sessionId}/transcription`);
    },
    enabled: !!sessionId && enabled,
  });
}

/** CRM linking is a partial update on the session row. */
function useUpdateSessionLinking() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, data }: { sessionId: string; data: { contactId?: string | null; opportunityId?: string | null; title?: string } }) => {
      const client = await getClient();
      return client.patch<any>(`/meeting-bot-sessions/${sessionId}`, data);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: callIntelligenceKeys.meetingSession(variables.sessionId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Call-recording upload/download is intentionally absent.
//
// `/crm/calls/{upload-url,confirm-upload,:id/recording-url,:id/delete}` still
// exist on api-worker but were never ported: app-api's `/storage` broker is
// generic and does not persist a recording row, and there is no recording-URL
// route. The four hooks that wrapped them were private and unreferenced, so they
// generated no traffic and nothing rendered them — they were removed with the
// legacy client rather than kept alive for a worker that is being deleted.
//
// Restoring call recording means porting that surface to app-api first
// (persisting a recording row on confirm-upload, plus a presigned recording-URL
// route), then re-adding hooks against it. Transcription (below) is unaffected —
// it already runs on app-api.
// ---------------------------------------------------------------------------

// =============================================================================
// Call Recording (R2-backed) Hooks
// =============================================================================

const callRecordingKeys = {
  all: ['crm', 'call-recordings'] as const,
  transcription: (activityId: string) => [...callRecordingKeys.all, activityId, 'transcription'] as const,
  transcriptionStatus: (activityId: string) => [...callRecordingKeys.all, activityId, 'transcription-status'] as const,
  meetingBotTranscriptionStatus: (sessionId: string) => [...callIntelligenceKeys.meetingBot(), sessionId, 'transcription-status'] as const,
};

function useCallTranscription(activityId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: callRecordingKeys.transcription(activityId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<any>(`/call-intelligence/calls/${activityId}/transcription`);
    },
    enabled: !!activityId && enabled,
  });
}

function useCallTranscriptionStatus(activityId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: callRecordingKeys.transcriptionStatus(activityId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<any>(`/call-intelligence/calls/${activityId}/transcription/status`);
    },
    enabled: !!activityId && enabled,
  });
}

/**
 * Queues transcription by creating the record; app-api has no `/transcribe`
 * verb. Note the id must resolve in `voipCalls` — app-api validates it, where
 * the legacy route accepted any `crmActivities` id.
 */
function useTranscribeCall() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ activityId, language }: { activityId: string; language?: string }) => {
      const client = await getClient();
      return client.post<any>(`/call-intelligence/calls/${activityId}/transcription`, { language });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: callRecordingKeys.transcription(variables.activityId) });
      qc.invalidateQueries({ queryKey: callRecordingKeys.transcriptionStatus(variables.activityId) });
    },
  });
}

function useTranscribeMeetingBotSession() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, language }: { sessionId: string; language?: string }) => {
      const client = await getClient();
      return client.post<any>(`/meeting-bot-sessions/${sessionId}/transcription`, { language });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: callIntelligenceKeys.meetingTranscription(variables.sessionId) });
      qc.invalidateQueries({ queryKey: callRecordingKeys.meetingBotTranscriptionStatus(variables.sessionId) });
    },
  });
}

function useMeetingBotTranscriptionStatus(sessionId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: callRecordingKeys.meetingBotTranscriptionStatus(sessionId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<any>(`/meeting-bot-sessions/${sessionId}/transcription/status`);
    },
    enabled: !!sessionId && enabled,
  });
}

function useDeleteMeetingBotSession() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const client = await getClient();
      return client.delete<Record<string, never>>(`/meeting-bot-sessions/${sessionId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: callIntelligenceKeys.meetingBot() });
    },
  });
}

function useFetchBotSessionTranscription() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const client = await getClient();
      return client.get<any>(`/meeting-bot-sessions/${sessionId}/transcription`);
    },
  });
}
