/**
 * App-API WeldMeet recordings domain client.
 *
 * Session-scoped recording, transcript and summary calls served by meet-api
 * (`/api/meeting-sessions/:id/...`, `/api/meetings/ai-pricing`). Meeting-level
 * lookups (`/api/meetings/:id/recording...`) still exist as aliases that resolve
 * the latest recorded session; prefer these session-scoped calls.
 *
 * Playback goes through `access()`: it returns short-lived tokenized URLs for
 * the private recording bucket, so never persist them.
 */

import type { ClientApi, DataResponse } from '../types';
import type {
  DeleteRecordingResult,
  MeetingAiPricingResult,
  RecordingAccessResult,
  RecordingAiOptionsInput,
  RecordingAiOptionsResult,
  SessionRecordingInfo,
  SessionTranscription,
  SessionTranscriptionStatus,
  StartRecordingInput,
  StartRecordingResult,
  StopRecordingResponse,
  SummarizeRecordingResult,
  TranscribeRecordingInput,
  TranscribeRecordingResult,
} from '../schemas/weldmeet-recordings';

export function createWeldmeetRecordingsApi(api: ClientApi) {
  return {
    /** Credits per meeting minute (transcript, summary) and the workspace balance. */
    aiPricing(): Promise<DataResponse<MeetingAiPricingResult>> {
      return api.get<DataResponse<MeetingAiPricingResult>>('/meetings/ai-pricing');
    },

    /** Recording state, durations, AI options and transcript/summary status. No file URLs. */
    get(sessionId: string): Promise<DataResponse<SessionRecordingInfo>> {
      return api.get<DataResponse<SessionRecordingInfo>>(`/meeting-sessions/${sessionId}/recording`);
    },

    /** Mint playable / downloadable URLs (valid about an hour). */
    access(sessionId: string): Promise<DataResponse<RecordingAccessResult>> {
      return api.post<DataResponse<RecordingAccessResult>>(
        `/meeting-sessions/${sessionId}/recording/access`,
        {},
      );
    },

    /** Start recording (host). Optional AI options make it one round trip. */
    start(sessionId: string, input: StartRecordingInput = {}): Promise<DataResponse<StartRecordingResult>> {
      return api.post<DataResponse<StartRecordingResult>>(
        `/meeting-sessions/${sessionId}/recording/start`,
        input,
      );
    },

    stop(sessionId: string): Promise<DataResponse<StopRecordingResponse>> {
      return api.post<DataResponse<StopRecordingResponse>>(
        `/meeting-sessions/${sessionId}/recording/stop`,
        {},
      );
    },

    /**
     * Choose transcript / summary for a LIVE meeting (before it ends). Checks the
     * wallet and rejects with 402 `INSUFFICIENT_CREDITS` when it cannot cover one
     * minute of the selected items.
     */
    setAiOptions(
      sessionId: string,
      input: RecordingAiOptionsInput,
    ): Promise<DataResponse<RecordingAiOptionsResult>> {
      return api.post<DataResponse<RecordingAiOptionsResult>>(
        `/meeting-sessions/${sessionId}/recording/ai-options`,
        input,
      );
    },

    /** Delete every part, the transcript and the summary. Irreversible. */
    delete(sessionId: string): Promise<DataResponse<DeleteRecordingResult>> {
      return api.delete<DataResponse<DeleteRecordingResult>>(`/meeting-sessions/${sessionId}/recording`);
    },

    /** "Transcribe afterwards": Whisper over the stored audio of every part. */
    transcribe(
      sessionId: string,
      input: TranscribeRecordingInput = {},
    ): Promise<DataResponse<TranscribeRecordingResult>> {
      return api.post<DataResponse<TranscribeRecordingResult>>(
        `/meeting-sessions/${sessionId}/recording/transcribe`,
        input,
      );
    },

    /** Summarize an existing transcript. */
    summarize(sessionId: string): Promise<DataResponse<SummarizeRecordingResult>> {
      return api.post<DataResponse<SummarizeRecordingResult>>(
        `/meeting-sessions/${sessionId}/recording/summarize`,
        {},
      );
    },

    transcription(sessionId: string): Promise<DataResponse<SessionTranscription>> {
      return api.get<DataResponse<SessionTranscription>>(`/meeting-sessions/${sessionId}/transcription`);
    },

    transcriptionStatus(sessionId: string): Promise<DataResponse<SessionTranscriptionStatus>> {
      return api.get<DataResponse<SessionTranscriptionStatus>>(
        `/meeting-sessions/${sessionId}/transcription/status`,
      );
    },
  };
}
