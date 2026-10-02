/**
 * WeldMeet recordings, transcripts and summaries: request/response contract of
 * the session-scoped routes in `apps/workers/meet-api`
 * (`/api/meeting-sessions/:id/recording/*`, `/api/meetings/ai-pricing`).
 *
 * Recordings live in a private R2 bucket and are only reachable through a
 * short-lived tokenized URL minted by `POST .../recording/access`; nothing here
 * ever carries a permanent file URL.
 */

import { z } from 'zod';

// ============================================================================
// Shared
// ============================================================================

/** What the recording of a session is doing. `null` on the session = never recorded. */
export const RECORDING_STATUSES = [
  'recording',
  'processing',
  'ready',
  'failed',
  /** Legacy row whose Cloudflare copy expired before it could be saved. */
  'unavailable',
  'deleted',
] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

export const AI_JOB_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;
export type AiJobStatus = (typeof AI_JOB_STATUSES)[number];

/**
 * Columns a client can never write through `PATCH /api/meeting-sessions/:id`:
 * the recorder, transcript and summary state is owned by the server. The route
 * strips these before the update.
 */
export const SERVER_OWNED_MEETING_SESSION_FIELDS = [
  'id',
  'meetingId',
  'cfAppId',
  'rtkSessionId',
  'recordingEnabled',
  'recordingUrl',
  'recordingKey',
  'recordingStatus',
  'recordingRtkId',
  'recordingVideoKey',
  'recordingAudioKey',
  'recordingSizeBytes',
  'recordingDurationSeconds',
  'recordingReadyAt',
  'recordingError',
  'recordingParts',
  'aiTranscribeRequested',
  'aiSummarizeRequested',
  'aiLanguage',
  'transcriptionCreditsCharged',
  'summaryStatus',
  'summaryText',
  'summaryFormat',
  'summarySource',
  'summaryGeneratedAt',
  'summaryError',
  'summaryCreditsCharged',
  'createdAt',
  'updatedAt',
] as const;

// ============================================================================
// Requests
// ============================================================================

/**
 * What to produce for this meeting. Summary needs the transcript, so
 * `summarize: true` requires `transcribe: true`. `language`: platform locale
 * or RealtimeKit code (`en`, `nl`, `en-US`, ...); omit or `null` to auto-detect.
 * A locale RealtimeKit does not support is treated as auto-detect.
 */
export const recordingAiOptionsSchema = z.object({
  transcribe: z.boolean(),
  summarize: z.boolean(),
  language: z.string().min(2).max(10).nullish(),
});
export type RecordingAiOptionsInput = z.infer<typeof recordingAiOptionsSchema>;

/** `POST /:id/recording/start`: optional AI options so a manual start is one round trip. */
export const startRecordingSchema = z
  .object({
    transcribe: z.boolean().optional(),
    summarize: z.boolean().optional(),
    language: z.string().min(2).max(10).nullish(),
  })
  .default({});
export type StartRecordingInput = z.infer<typeof startRecordingSchema>;

/** `POST /:id/recording/transcribe` (Whisper over the stored audio). */
export const transcribeRecordingSchema = z
  .object({ language: z.string().min(2).max(10).nullish() })
  .default({});
export type TranscribeRecordingInput = z.infer<typeof transcribeRecordingSchema>;

// ============================================================================
// Responses
// ============================================================================

export interface RecordingPartSummary {
  rtkRecordingId: string;
  status: 'recording' | 'processing' | 'ready' | 'failed';
  hasVideo: boolean;
  hasAudio: boolean;
  sizeBytes: number | null;
  durationSeconds: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
}

/** `GET /meeting-sessions/:id/recording`. No file URLs: call `access` for those. */
export interface SessionRecordingInfo {
  sessionId: string;
  meetingId: string;
  /** null = this session was never recorded. */
  status: RecordingStatus | null;
  /** True while a part is being recorded right now. */
  recording: boolean;
  error: string | null;
  hasVideo: boolean;
  hasAudio: boolean;
  sizeBytes: number | null;
  durationSeconds: number | null;
  readyAt: string | null;
  parts: RecordingPartSummary[];
  /** The AI options chosen for this meeting. */
  ai: { transcribe: boolean; summarize: boolean; language: string | null };
  transcription: { exists: boolean; id?: string; status?: AiJobStatus; source?: 'cloudflare-rtk' | 'cloudflare-whisper' | string };
  summary: { status: AiJobStatus | null; source: 'rtk' | 'workers_ai' | null; generatedAt: string | null; error: string | null };
  transcriptionCreditsCharged: number | null;
  summaryCreditsCharged: number | null;
}

/** `POST /meeting-sessions/:id/recording/access`: playable URLs, valid for `expiresAt`. */
export interface RecordingAccessResult {
  /** Video (or the audio file for an audio-only recording). */
  url: string;
  /** Audio-only file, when one was exported. */
  audioUrl: string | null;
  /** ISO timestamp. Mint a new one after it passes; do not store the URL. */
  expiresAt: string;
}

/** `GET /meetings/ai-pricing`: credits per MEETING MINUTE plus the wallet, for the UI estimate. */
export interface MeetingAiPricingResult {
  transcriptionCreditsPerMinute: number;
  summaryCreditsPerMinute: number;
  /** Current prepaid balance (can be negative after a late settlement). */
  balance: number;
}

export interface RecordingAiOptionsResult {
  ok: true;
  ai: { transcribe: boolean; summarize: boolean; language: string | null };
}

export interface StartRecordingResult {
  ok: true;
  ai: { transcribe: boolean; summarize: boolean; language: string | null };
}

export interface StopRecordingResponse {
  ok: true;
}

export interface DeleteRecordingResult {
  ok: true;
  /** R2 objects removed (video, audio, transcript file). */
  deletedObjects: number;
}

export interface TranscribeRecordingResult {
  id: string;
  /** `existing` when a transcript (any source) already exists and nothing was started. */
  status: AiJobStatus | 'existing';
  message?: string;
}

export interface SummarizeRecordingResult {
  status: 'processing' | 'existing';
  message?: string;
}

export interface SessionTranscriptionSegment {
  id: string;
  speakerId: number;
  speakerLabel: string | null;
  speakerName: string | null;
  text: string;
  startTime: number;
  endTime: number;
  timestamp: string | null;
  sequenceNumber: number;
  /** Aliases the platform transcript viewer reads. */
  start: number;
  end: number;
  speaker: string | null;
}

/** `GET /meeting-sessions/:id/transcription`. */
export interface SessionTranscription {
  id: string;
  activityId: string;
  status: AiJobStatus;
  fullText: string | null;
  provider: string | null;
  model: string | null;
  language: string | null;
  speakerCount: number | null;
  wordCount: number | null;
  errorMessage: string | null;
  segments: SessionTranscriptionSegment[];
  /** The session's AI summary (markdown), when there is one. */
  summary: string | null;
  summaryStatus: AiJobStatus | null;
}

/** `GET /meeting-sessions/:id/transcription/status`. */
export type SessionTranscriptionStatus =
  | { exists: false; summaryStatus: AiJobStatus | null }
  | {
      exists: true;
      id: string;
      status: AiJobStatus;
      errorMessage: string | null;
      wordCount: number | null;
      speakerCount: number | null;
      summaryStatus: AiJobStatus | null;
    };
