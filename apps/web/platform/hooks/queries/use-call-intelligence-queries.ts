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

import { useMutation } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
const callIntelligenceKeys = {
  all: ['crm', 'call-intelligence'] as const,
  calls: (filters?: Record<string, unknown>) => [...callIntelligenceKeys.all, 'calls', filters] as const,
  voiceToken: () => [...callIntelligenceKeys.all, 'voice-token'] as const,
  telephonyRates: () => ['settings', 'telephony-rates'] as const,
  meetingBot: () => [...callIntelligenceKeys.all, 'meeting-bot'] as const,
  meetingSession: (id: string) => [...callIntelligenceKeys.meetingBot(), 'session', id] as const,
  meetingTranscription: (id: string) => [...callIntelligenceKeys.meetingBot(), 'transcription', id] as const,
};export function useFetchVoiceToken() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      return client.post<{ token?: string; data?: { token?: string } }>('/call-intelligence/token', {});
    },
  });
}// ---------------------------------------------------------------------------
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