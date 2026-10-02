/**
 * WeldMeet recording hooks: recorder state, tokenized playback / download,
 * AI options (transcript + summary), "transcribe afterwards", summarize and
 * delete. All of it is session-scoped (`/meeting-sessions/:id/recording/*`)
 * except the per-meeting alias that resolves a meeting to its recorded session.
 *
 * Privacy: recordings, transcripts and playback URLs are sensitive and the
 * global query cache is persisted to localStorage, so every query here opts out
 * with `meta: { persist: false }`. The playback URL is a short-lived token: it
 * is fetched on demand and never stored.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi, useAppApiClient } from '@/lib/api/use-app-api';
import type {
  DeleteRecordingResult,
  MeetingAiPricingResult,
  RecordingAccessResult,
  RecordingAiOptionsInput,
  RecordingAiOptionsResult,
  SessionRecordingInfo,
  SummarizeRecordingResult,
  TranscribeRecordingInput,
  TranscribeRecordingResult,
} from '@weldsuite/app-api-client/schemas/weldmeet-recordings';
import { hasApiStatus } from '@/lib/weldmeet/recording';
import { weldmeetKeys } from './use-weldmeet-queries';

const NO_PERSIST = { persist: false } as const;

export const weldmeetRecordingKeys = {
  aiPricing: () => [...weldmeetKeys.all, 'ai-pricing'] as const,
  /** Meeting -> latest recorded session (+ a fresh playback token). */
  meetingRecording: (meetingId: string) => [...weldmeetKeys.all, 'meeting-recording', meetingId] as const,
  /** Session recorder / transcript / summary state (no file URLs). */
  session: (sessionId: string) => [...weldmeetKeys.all, 'recording', sessionId] as const,
};

// ============================================================================
// Reads
// ============================================================================

/** Credits per meeting minute (transcript, summary) plus the workspace balance. */
export function useMeetingAiPricing(enabled = true) {
  const { weldmeetRecordings } = useAppApi();
  return useQuery({
    queryKey: weldmeetRecordingKeys.aiPricing(),
    queryFn: async (): Promise<MeetingAiPricingResult> => (await weldmeetRecordings.aiPricing()).data,
    enabled,
    // The balance moves whenever a transcript or summary is charged.
    staleTime: 0,
    meta: NO_PERSIST,
  });
}

/**
 * `GET /meetings/:id/recording`: the per-meeting alias. Resolves the meeting's
 * latest recorded session and, once the recording is ready, returns fresh
 * tokenized `url` / `audioUrl` (valid until `expiresAt`). `null` when the
 * meeting was never recorded or the caller may not see the recording.
 */
export type MeetingRecordingState = SessionRecordingInfo & {
  duration: number | null;
  url: string | null;
  audioUrl: string | null;
  expiresAt: string | null;
};

export function useMeetingRecording(meetingId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldmeetRecordingKeys.meetingRecording(meetingId),
    queryFn: async (): Promise<MeetingRecordingState | null> => {
      const client = await getClient();
      try {
        const res = await client.get<{ data: MeetingRecordingState | null }>(`/meetings/${meetingId}/recording`);
        return res.data ?? null;
      } catch (err) {
        // 404: never recorded. 403: not the organizer / no scope:all.
        if (hasApiStatus(err, 404) || hasApiStatus(err, 403)) return null;
        throw err;
      }
    },
    enabled: !!meetingId,
    // Tokens last an hour; keep the one we hold fresh enough to start playback.
    staleTime: 20 * 60_000,
    meta: NO_PERSIST,
  });
}

/** True while something is still happening to the recording, transcript or summary. */
export function isRecordingInFlight(info: SessionRecordingInfo | undefined | null): boolean {
  if (!info) return false;
  if (info.status === 'recording' || info.status === 'processing') return true;
  if (info.transcription.status === 'pending' || info.transcription.status === 'processing') return true;
  return info.summary.status === 'pending' || info.summary.status === 'processing';
}

/**
 * Session-scoped recorder, transcript and summary state. Polls while something
 * is in flight; pass `poll: false` where realtime events (`meeting_session:updated`)
 * are enough, like inside the live meeting.
 */
export function useSessionRecording(
  sessionId: string | null | undefined,
  { poll = true }: { poll?: boolean } = {},
) {
  const { weldmeetRecordings } = useAppApi();
  return useQuery({
    queryKey: weldmeetRecordingKeys.session(sessionId ?? ''),
    queryFn: async (): Promise<SessionRecordingInfo> => (await weldmeetRecordings.get(sessionId as string)).data,
    enabled: !!sessionId,
    refetchInterval: (query) => (poll && isRecordingInFlight(query.state.data) ? 5_000 : false),
    meta: NO_PERSIST,
  });
}

// ============================================================================
// Mutations
// ============================================================================

/**
 * Mint playable / downloadable URLs on demand (the history list and the
 * download action). Never cached: a mutation, not a query.
 */
export function useRecordingAccess() {
  const { weldmeetRecordings } = useAppApi();
  return useMutation<RecordingAccessResult, Error, string>({
    mutationFn: async (sessionId) => (await weldmeetRecordings.access(sessionId)).data,
  });
}

/** Choose transcript / summary for a live meeting. Rejects with a 402 when the wallet cannot cover it. */
export function useSetRecordingAiOptions() {
  const { weldmeetRecordings } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation<RecordingAiOptionsResult, Error, { sessionId: string; input: RecordingAiOptionsInput }>({
    mutationFn: async ({ sessionId, input }) => (await weldmeetRecordings.setAiOptions(sessionId, input)).data,
    onSuccess: (_result, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: weldmeetRecordingKeys.session(sessionId) });
    },
  });
}

/** Delete every part, the transcript and the summary. Irreversible. */
export function useDeleteRecording() {
  const { weldmeetRecordings } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation<DeleteRecordingResult, Error, string>({
    mutationFn: async (sessionId) => (await weldmeetRecordings.delete(sessionId)).data,
    onSuccess: () => {
      // Lists, the meeting alias and the session state all change.
      queryClient.invalidateQueries({ queryKey: weldmeetKeys.all });
    },
  });
}

/** "Transcribe afterwards" over the stored audio. Spends credits; 402 when the wallet is short. */
export function useTranscribeRecording() {
  const { weldmeetRecordings } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation<TranscribeRecordingResult, Error, { sessionId: string; input?: TranscribeRecordingInput }>({
    mutationFn: async ({ sessionId, input }) => (await weldmeetRecordings.transcribe(sessionId, input)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldmeetKeys.all });
    },
  });
}

/** Summarize an existing transcript. Spends credits; 402 when the wallet is short. */
export function useSummarizeRecording() {
  const { weldmeetRecordings } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation<SummarizeRecordingResult, Error, string>({
    mutationFn: async (sessionId) => (await weldmeetRecordings.summarize(sessionId)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldmeetKeys.all });
    },
  });
}
