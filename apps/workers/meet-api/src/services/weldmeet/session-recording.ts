/**
 * Session-scoped recording, transcript and summary operations.
 *
 * The source of truth for everything recorder-related; both the session routes
 * (`/api/meeting-sessions/:id/recording/*`) and the per-meeting aliases
 * (`/api/meetings/:id/recording/*`, which resolve the latest recorded session)
 * call these. Every function returns a Response so the routes stay thin.
 *
 * Rules enforced here:
 *  - Access: the meeting's organizer, or `meetings:scope:all`. (The route's own
 *    permission, recordings:read / sessions:update / recordings:delete, is
 *    checked before we get here.)
 *  - Paid work (transcript, summary) is gated on the wallet BEFORE it starts
 *    (402 INSUFFICIENT_CREDITS) and charged AFTER it finishes, in the workflow.
 *  - Every mutation publishes `meeting_session:updated`.
 *  - Recording files are only ever reachable through short-lived tokens
 *    (recording-access.ts); nothing here returns a permanent URL.
 */

import type { Context } from 'hono';
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { originForPathFrom } from '@weldsuite/api-modules';
import { hasContextPermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  mapLocaleToRtkLanguage,
  updateMeeting as updateRtkMeeting,
  type RtkTranscriptionLanguage,
} from '@weldsuite/cloudflare-realtime';
import {
  InsufficientMeetingCreditsError,
  MeetingBillingUnavailableError,
  assertMeetingAiCredits,
  getMeetingAiPricing,
  resolveMeetingMetering,
} from '@weldsuite/meet-domain/billing';
import {
  loadSession,
  patchSession,
  readyParts,
  sessionObjectPrefix,
  contentTypeForExtension,
  extensionOf,
  type MeetingSessionRow,
} from '@weldsuite/meet-domain/recordings';
import {
  deleteSessionTranscripts,
  findSessionTranscription,
} from '@weldsuite/meet-domain/transcript-store';
import { whisperLanguage } from '@weldsuite/meet-domain/workflows/meeting-ai';
import type {
  AiJobStatus,
  DeleteRecordingResult,
  RecordingAccessResult,
  RecordingAiOptionsInput,
  RecordingPartSummary,
  RecordingStatus,
  SessionRecordingInfo,
  SessionTranscription,
  SessionTranscriptionStatus,
  StartRecordingInput,
  TranscribeRecordingInput,
} from '@weldsuite/app-api-client/schemas/weldmeet-recordings';
import { error, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import {
  PUBLIC_RECORDINGS_PATH,
  RECORDING_TOKEN_TTL_SECONDS,
  mintRecordingToken,
  safeFilename,
} from './recording-access';
import { reconcileRecordingFromRtk } from './recording-reconcile';

export type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
type MeetingRow = typeof schema.meetings.$inferSelect;

const { meetingSessions, meetings, crmTranscriptions, crmTranscriptSegments } = schema;

export const RECORDING_DENIED = 'You do not have access to this meeting recording';

// ============================================================================
// Access
// ============================================================================

export interface AuthorizedSession {
  session: MeetingSessionRow;
  meeting: MeetingRow | null;
}

/**
 * Load a session and check the caller may act on its recording. Returns the
 * session, or the 404 / 403 Response to send.
 */
export async function authorizeSession(
  c: AppContext,
  sessionId: string,
): Promise<AuthorizedSession | Response> {
  const db = c.get('tenantDb');
  const session = await loadSession(db, sessionId);
  if (!session) return error.notFound(c, 'Session', sessionId);

  const [meeting] = await db.select().from(meetings).where(eq(meetings.id, session.meetingId)).limit(1);
  const userId = c.get('userId');
  const allowed =
    (meeting && meeting.organizerId === userId) || (await hasContextPermission(c, 'meetings:scope:all'));
  if (!allowed) return error.forbidden(c, RECORDING_DENIED);
  return { session, meeting: meeting ?? null };
}

/** Narrow the `AuthorizedSession | Response` union. */
export function isResponse(value: AuthorizedSession | Response): value is Response {
  return value instanceof Response;
}

/**
 * Wallet gate for paid work. Returns the 402 / 503 Response, or null when the
 * balance covers at least one minute of the selected items.
 */
async function gateCredits(
  c: AppContext,
  selected: { transcription?: boolean; summary?: boolean },
): Promise<Response | null> {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  try {
    const pricing = await getMeetingAiPricing(c.env);
    const metering = await resolveMeetingMetering(c.env, orgId, c.get('userId'));
    await assertMeetingAiCredits(metering, pricing, selected);
    return null;
  } catch (err) {
    if (err instanceof InsufficientMeetingCreditsError) {
      return error.insufficientCredits(c, {
        currentBalance: err.currentBalance,
        required: err.required,
        shortfall: err.shortfall,
      });
    }
    if (err instanceof MeetingBillingUnavailableError) {
      return error.unavailable(c, 'Credit metering is unavailable for this workspace');
    }
    throw err;
  }
}

function emitSessionUpdated(c: AppContext, session: MeetingSessionRow, data: Record<string, unknown>): void {
  publishEntityEvent({
    c,
    entityType: 'meeting_session',
    entityId: session.id,
    action: 'updated',
    data: { id: session.id, meetingId: session.meetingId, status: session.status, ...data },
  });
}

// ============================================================================
// Read: recording info
// ============================================================================

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function buildRecordingInfo(db: Database, session: MeetingSessionRow): Promise<SessionRecordingInfo> {
  const transcription = await findSessionTranscription(db, session.id);
  const parts: RecordingPartSummary[] = (session.recordingParts ?? []).map((p) => ({
    rtkRecordingId: p.rtkRecordingId,
    status: p.status,
    hasVideo: Boolean(p.videoKey),
    hasAudio: Boolean(p.audioKey),
    sizeBytes: p.sizeBytes,
    durationSeconds: p.durationSeconds,
    startedAt: p.startedAt,
    stoppedAt: p.stoppedAt,
  }));
  return {
    sessionId: session.id,
    meetingId: session.meetingId,
    status: (session.recordingStatus as RecordingStatus | null) ?? null,
    recording: session.recordingStatus === 'recording',
    error: session.recordingError ?? null,
    hasVideo: Boolean(session.recordingVideoKey),
    hasAudio: Boolean(session.recordingAudioKey),
    sizeBytes: session.recordingSizeBytes ?? null,
    durationSeconds: session.recordingDurationSeconds ?? null,
    readyAt: iso(session.recordingReadyAt),
    parts,
    ai: {
      transcribe: Boolean(session.aiTranscribeRequested),
      summarize: Boolean(session.aiSummarizeRequested),
      language: session.aiLanguage ?? null,
    },
    transcription: transcription
      ? {
          exists: true,
          id: transcription.id,
          status: transcription.status as AiJobStatus,
          source: transcription.provider ?? undefined,
        }
      : { exists: false },
    summary: {
      status: (session.summaryStatus as AiJobStatus | null) ?? null,
      source: (session.summarySource as 'rtk' | 'workers_ai' | null) ?? null,
      generatedAt: iso(session.summaryGeneratedAt),
      error: session.summaryError ?? null,
    },
    transcriptionCreditsCharged: session.transcriptionCreditsCharged ?? null,
    summaryCreditsCharged: session.summaryCreditsCharged ?? null,
  };
}

export async function getRecordingInfo(c: AppContext, sessionId: string): Promise<Response> {
  const auth = await authorizeSession(c, sessionId);
  if (isResponse(auth)) return auth;
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  const session = orgId ? await reconcileRecordingFromRtk(c.env, db, orgId, auth.session) : auth.session;
  return success(c, await buildRecordingInfo(db, session));
}

// ============================================================================
// Access tokens
// ============================================================================

/**
 * Mint the tokenized playback / download URLs. Plays the LATEST ready part;
 * earlier parts stay stored (and transcribable) but are not offered for playback.
 */
export async function mintRecordingAccess(
  c: AppContext,
  auth: AuthorizedSession,
): Promise<RecordingAccessResult | Response> {
  const { session, meeting } = auth;
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const status = session.recordingStatus;
  const latest = readyParts(session.recordingParts).at(-1);
  const videoKey = latest?.videoKey ?? session.recordingVideoKey;
  const audioKey = latest?.audioKey ?? session.recordingAudioKey;
  const primaryKey = videoKey ?? audioKey;

  if (!primaryKey) {
    if (status === 'recording' || status === 'processing') {
      return error.conflict(c, 'The recording is still being processed. Try again in a few minutes.');
    }
    if (status === 'failed') return error.conflict(c, session.recordingError ?? 'The recording failed.');
    return error.notFound(c, 'Recording');
  }
  if (!c.env.MEETING_RECORDINGS) return error.unavailable(c, 'Recording storage is not configured');

  const userId = c.get('userId');
  const mint = (key: string, kind: 'video' | 'audio') => {
    const ext = extensionOf(key, kind === 'video' ? 'mp4' : 'mp3');
    return mintRecordingToken(c.env.WORKSPACE_CACHE, {
      orgId,
      sessionId: session.id,
      key,
      kind,
      contentType: contentTypeForExtension(ext),
      filename: safeFilename(meeting?.title, ext),
      userId,
    });
  };

  const [primaryToken, audioToken] = await Promise.all([
    mint(primaryKey, videoKey ? 'video' : 'audio'),
    videoKey && audioKey ? mint(audioKey, 'audio') : Promise.resolve(null),
  ]);

  const origin = originForPathFrom(new URL(c.req.url).origin, PUBLIC_RECORDINGS_PATH);
  return {
    url: `${origin}${PUBLIC_RECORDINGS_PATH}/${primaryToken}`,
    audioUrl: audioToken ? `${origin}${PUBLIC_RECORDINGS_PATH}/${audioToken}` : null,
    expiresAt: new Date(Date.now() + RECORDING_TOKEN_TTL_SECONDS * 1000).toISOString(),
  };
}

export async function getRecordingAccess(c: AppContext, sessionId: string): Promise<Response> {
  const auth = await authorizeSession(c, sessionId);
  if (isResponse(auth)) return auth;
  const result = await mintRecordingAccess(c, auth);
  return result instanceof Response ? result : success(c, result);
}

// ============================================================================
// AI options (live meeting)
// ============================================================================

export interface AppliedAiOptions {
  transcribe: boolean;
  summarize: boolean;
  language: string | null;
}

/**
 * Turn transcript / summary on or off on the LIVE RealtimeKit meeting and
 * remember the choice. RealtimeKit reads these when the meeting ends, so an ended
 * session is rejected. Enabling anything is gated on the wallet.
 */
async function applyAiOptions(
  c: AppContext,
  auth: AuthorizedSession,
  input: { transcribe?: boolean; summarize?: boolean; language?: string | null },
): Promise<AppliedAiOptions | Response> {
  const { session } = auth;
  const transcribe = input.transcribe ?? Boolean(session.aiTranscribeRequested);
  const summarize = input.summarize ?? Boolean(session.aiSummarizeRequested);

  if (summarize && !transcribe) return error.badRequest(c, 'A summary needs a transcript. Turn on transcribe too.');
  if (session.status === 'ended') {
    return error.badRequest(c, 'This meeting has ended. Use "transcribe afterwards" on the recording instead.');
  }
  if (!session.cfAppId) return error.internal(c, 'Session has no RTK meeting ID');

  if (transcribe || summarize) {
    const blocked = await gateCredits(c, { transcription: transcribe, summary: summarize });
    if (blocked) return blocked;
  }

  // Unsupported locales (es, ...) become auto-detect; never cast through to RTK.
  const language: RtkTranscriptionLanguage | null =
    mapLocaleToRtkLanguage(input.language === undefined ? session.aiLanguage : input.language) ?? null;

  try {
    await updateRtkMeeting(c.env, session.cfAppId, {
      transcribeOnEnd: transcribe,
      summarizeOnEnd: summarize,
      ...(language ? { transcriptionLanguage: language } : {}),
      ...(summarize ? { summaryTextFormat: 'markdown' as const } : {}),
    });
  } catch (err) {
    console.error('[meet-api/session-recording] RTK update failed:', err instanceof Error ? err.message : err);
    return error.badGateway(c, 'Could not update the meeting settings');
  }

  await patchSession(c.get('tenantDb'), session.id, {
    aiTranscribeRequested: transcribe,
    aiSummarizeRequested: summarize,
    aiLanguage: language,
  });
  emitSessionUpdated(c, session, {
    aiTranscribeRequested: transcribe,
    aiSummarizeRequested: summarize,
    aiLanguage: language,
  });
  return { transcribe, summarize, language };
}

export async function setRecordingAiOptions(
  c: AppContext,
  sessionId: string,
  input: RecordingAiOptionsInput,
): Promise<Response> {
  const auth = await authorizeSession(c, sessionId);
  if (isResponse(auth)) return auth;
  const applied = await applyAiOptions(c, auth, input);
  return applied instanceof Response ? applied : success(c, { ok: true as const, ai: applied });
}

// ============================================================================
// Start / stop
// ============================================================================

/**
 * Mark the session as recording. The recorder itself is started by the client
 * (RealtimeKit SDK) or by `record_on_start`; this keeps our row in step and
 * optionally applies the AI options in the same round trip.
 */
export async function startRecording(
  c: AppContext,
  sessionId: string,
  input: StartRecordingInput,
): Promise<Response> {
  const db = c.get('tenantDb');
  const userId = c.get('userId');

  const session = await loadSession(db, sessionId);
  if (!session) return error.notFound(c, 'Session', sessionId);
  const [meeting] = await db
    .select({ organizerId: meetings.organizerId, allowParticipantRecord: meetings.allowParticipantRecord })
    .from(meetings)
    .where(eq(meetings.id, session.meetingId))
    .limit(1);

  if (meeting && meeting.organizerId !== userId && !meeting.allowParticipantRecord) {
    return error.forbidden(c, 'Only the meeting organizer can start a recording.');
  }

  let ai: AppliedAiOptions = {
    transcribe: Boolean(session.aiTranscribeRequested),
    summarize: Boolean(session.aiSummarizeRequested),
    language: session.aiLanguage ?? null,
  };

  const wantsAi = input.transcribe !== undefined || input.summarize !== undefined || input.language != null;
  if (wantsAi) {
    // Spending the host's credits stays with the host (or a scope:all admin).
    const auth = await authorizeSession(c, sessionId);
    if (isResponse(auth)) return auth;
    const applied = await applyAiOptions(c, auth, input);
    if (applied instanceof Response) return applied;
    ai = applied;
  }

  await patchSession(db, sessionId, {
    recordingEnabled: true,
    ...(session.recordingStatus === 'processing' || session.recordingStatus === 'ready'
      ? {}
      : { recordingStatus: 'recording' }),
  });
  emitSessionUpdated(c, session, { recordingStatus: 'recording' });
  return success(c, { ok: true as const, ai });
}

/**
 * Stop: the status now comes from RealtimeKit's recording.statusUpdate webhook
 * (UPLOADING, then our copy to `ready`). Nothing is polled here.
 */
export async function stopRecording(c: AppContext, sessionId: string): Promise<Response> {
  const db = c.get('tenantDb');
  const session = await loadSession(db, sessionId);
  if (!session) return error.notFound(c, 'Session', sessionId);

  await patchSession(db, sessionId, {
    recordingEnabled: false,
    ...(session.recordingStatus === 'recording' ? { recordingStatus: 'processing' } : {}),
  });
  emitSessionUpdated(c, session, { recordingStatus: 'processing' });
  return success(c, { ok: true as const });
}

// ============================================================================
// Delete
// ============================================================================

/** Delete every object under `prefix`. Returns how many went. Missing objects are fine. */
export async function deleteObjectsUnderPrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let cursor: string | undefined;
  let total = 0;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
      total += keys.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return total;
}

/** The column values of a session whose recording, transcript and summary are gone. */
export const CLEARED_RECORDING_COLUMNS = {
  recordingEnabled: false,
  recordingUrl: null,
  recordingKey: null,
  recordingStatus: 'deleted',
  recordingRtkId: null,
  recordingVideoKey: null,
  recordingAudioKey: null,
  recordingSizeBytes: null,
  recordingDurationSeconds: null,
  recordingReadyAt: null,
  recordingError: null,
  recordingParts: null,
  aiTranscribeRequested: false,
  aiSummarizeRequested: false,
  aiLanguage: null,
  transcriptionCreditsCharged: null,
  summaryStatus: null,
  summaryText: null,
  summaryFormat: null,
  summarySource: null,
  summaryGeneratedAt: null,
  summaryError: null,
  summaryCreditsCharged: null,
} as const;

/**
 * Delete the recording: every stored part, the raw transcript, the transcript
 * rows and the summary. Order is R2 first, then the database, so a failure
 * between the two leaves a retryable state instead of orphaned files nobody can
 * reach. Idempotent. Refuses while the recorder is running.
 */
export async function deleteRecording(c: AppContext, sessionId: string): Promise<Response> {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const auth = await authorizeSession(c, sessionId);
  if (isResponse(auth)) return auth;
  const { session } = auth;
  const db = c.get('tenantDb');

  if (session.recordingStatus === 'recording') {
    return error.conflict(c, 'Stop the recording before deleting it.');
  }
  if (!c.env.MEETING_RECORDINGS) return error.unavailable(c, 'Recording storage is not configured');

  const deletedObjects = await deleteObjectsUnderPrefix(
    c.env.MEETING_RECORDINGS,
    sessionObjectPrefix(orgId, session.id),
  );

  await deleteSessionTranscripts(db, session.id);
  // Legacy rows keyed their (AssemblyAI) transcript by meeting id.
  if (session.recordingUrl || session.recordingKey) {
    await deleteSessionTranscripts(db, session.meetingId);
  }
  await patchSession(db, session.id, CLEARED_RECORDING_COLUMNS);

  emitSessionUpdated(c, session, { recordingDeleted: true, recordingStatus: 'deleted' });
  const result: DeleteRecordingResult = { ok: true, deletedObjects };
  return success(c, result);
}

// ============================================================================
// Transcribe afterwards (Whisper) / summarize
// ============================================================================

/** Remove a transcription and its segments (used to retry a failed attempt). */
async function removeTranscription(db: Database, transcriptionId: string): Promise<void> {
  await db.delete(crmTranscriptSegments).where(eq(crmTranscriptSegments.transcriptionId, transcriptionId));
  await db.delete(crmTranscriptions).where(eq(crmTranscriptions.id, transcriptionId));
}

export async function transcribeRecording(
  c: AppContext,
  sessionId: string,
  input: TranscribeRecordingInput,
): Promise<Response> {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const auth = await authorizeSession(c, sessionId);
  if (isResponse(auth)) return auth;
  const { session } = auth;
  const db = c.get('tenantDb');

  const hasAudio = readyParts(session.recordingParts).some((p) => p.audioKey) || Boolean(session.recordingAudioKey);
  if (session.recordingStatus !== 'ready' || !hasAudio) {
    return error.badRequest(
      c,
      session.recordingStatus === 'ready'
        ? 'This recording has no audio file to transcribe.'
        : 'The recording is not ready yet.',
    );
  }

  const existing = await findSessionTranscription(db, session.id);
  if (existing && existing.status !== 'failed') {
    return success(c, {
      id: existing.id,
      status: 'existing' as const,
      message: 'A transcript already exists or is in progress',
    });
  }

  const blocked = await gateCredits(c, { transcription: true });
  if (blocked) return blocked;
  if (!c.env.MEETING_AI) return error.unavailable(c, 'Transcription is not configured');

  if (existing?.status === 'failed') await removeTranscription(db, existing.id);

  // Whisper accepts any ISO-639-1 code, so (unlike RealtimeKit) es etc. pass through.
  const requested = input.language ?? undefined;
  const transcriptionId = generateId('trans');
  const now = new Date();
  await db.insert(crmTranscriptions).values({
    id: transcriptionId,
    activityId: session.id,
    status: 'pending',
    language: (whisperLanguage(requested) ?? 'en').slice(0, 10),
    createdAt: now,
    updatedAt: now,
  });

  try {
    await c.env.MEETING_AI.create({
      id: `whisper-${transcriptionId}`,
      params: {
        kind: 'whisper-transcribe',
        orgId,
        sessionId: session.id,
        transcriptionId,
        userId: c.get('userId'),
        language: requested ?? undefined,
      },
    });
  } catch (err) {
    await removeTranscription(db, transcriptionId);
    console.error('[meet-api/session-recording] whisper dispatch failed:', err);
    return error.internal(c, 'Failed to start transcription');
  }

  emitSessionUpdated(c, session, { transcriptionStatus: 'pending' });
  return success(c, { id: transcriptionId, status: 'pending' as const }, 201);
}

export async function summarizeRecording(c: AppContext, sessionId: string): Promise<Response> {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const auth = await authorizeSession(c, sessionId);
  if (isResponse(auth)) return auth;
  const { session } = auth;
  const db = c.get('tenantDb');

  const transcription = await findSessionTranscription(db, session.id);
  if (!transcription || transcription.status !== 'completed') {
    return error.badRequest(c, 'There is no completed transcript to summarize yet.');
  }
  if (session.summaryStatus === 'completed' || session.summaryStatus === 'processing' || session.summaryStatus === 'pending') {
    return success(c, { status: 'existing' as const, message: 'A summary already exists or is in progress' });
  }

  const blocked = await gateCredits(c, { summary: true });
  if (blocked) return blocked;
  if (!c.env.MEETING_AI) return error.unavailable(c, 'Summaries are not configured');

  const runId = Date.now().toString(36);
  await patchSession(db, session.id, { summaryStatus: 'pending', summaryError: null });
  try {
    await c.env.MEETING_AI.create({
      id: `summarize-${session.id}-${runId}`,
      params: { kind: 'summarize', orgId, sessionId: session.id, userId: c.get('userId'), runId },
    });
  } catch (err) {
    await patchSession(db, session.id, { summaryStatus: session.summaryStatus ?? null });
    console.error('[meet-api/session-recording] summarize dispatch failed:', err);
    return error.internal(c, 'Failed to start the summary');
  }

  emitSessionUpdated(c, session, { summaryStatus: 'pending' });
  return success(c, { status: 'processing' as const });
}

// ============================================================================
// Transcript reads (session-keyed)
// ============================================================================

export async function buildTranscriptionPayload(
  db: Database,
  transcription: typeof crmTranscriptions.$inferSelect,
  session: MeetingSessionRow | null,
): Promise<SessionTranscription> {
  const segments = await db
    .select()
    .from(crmTranscriptSegments)
    .where(eq(crmTranscriptSegments.transcriptionId, transcription.id))
    .orderBy(asc(crmTranscriptSegments.sequenceNumber));
  return {
    id: transcription.id,
    activityId: transcription.activityId,
    status: transcription.status as AiJobStatus,
    fullText: transcription.fullText,
    provider: transcription.provider,
    model: transcription.model,
    language: transcription.language,
    speakerCount: transcription.speakerCount,
    wordCount: transcription.wordCount,
    errorMessage: transcription.errorMessage,
    segments: segments.map((seg) => ({
      id: seg.id,
      speakerId: seg.speakerId,
      speakerLabel: seg.speakerLabel,
      speakerName: seg.speakerName,
      text: seg.text,
      startTime: seg.startTime,
      endTime: seg.endTime,
      timestamp: seg.timestamp,
      sequenceNumber: seg.sequenceNumber,
      start: seg.startTime,
      end: seg.endTime,
      speaker: seg.speakerLabel,
    })),
    summary: session?.summaryStatus === 'completed' ? (session.summaryText ?? null) : null,
    summaryStatus: (session?.summaryStatus as AiJobStatus | null) ?? null,
  };
}

export function buildTranscriptionStatus(
  transcription: Pick<
    typeof crmTranscriptions.$inferSelect,
    'id' | 'status' | 'errorMessage' | 'wordCount' | 'speakerCount'
  > | null,
  session: MeetingSessionRow | null,
): SessionTranscriptionStatus {
  const summaryStatus = (session?.summaryStatus as AiJobStatus | null) ?? null;
  if (!transcription) return { exists: false, summaryStatus };
  return {
    exists: true,
    id: transcription.id,
    status: transcription.status as AiJobStatus,
    errorMessage: transcription.errorMessage,
    wordCount: transcription.wordCount,
    speakerCount: transcription.speakerCount,
    summaryStatus,
  };
}

export async function getSessionTranscription(c: AppContext, sessionId: string): Promise<Response> {
  const auth = await authorizeSession(c, sessionId);
  if (isResponse(auth)) return auth;
  const db = c.get('tenantDb');
  const transcription = await findSessionTranscription(db, auth.session.id);
  if (!transcription) return error.notFound(c, 'Transcription');
  return success(c, await buildTranscriptionPayload(db, transcription, auth.session));
}

export async function getSessionTranscriptionStatus(c: AppContext, sessionId: string): Promise<Response> {
  const auth = await authorizeSession(c, sessionId);
  if (isResponse(auth)) return auth;
  const transcription = await findSessionTranscription(c.get('tenantDb'), auth.session.id);
  return success(c, buildTranscriptionStatus(transcription, auth.session));
}

// ============================================================================
// Meeting -> latest recorded session
// ============================================================================

/**
 * The latest session of a meeting that has recorder state (any status), for the
 * per-meeting alias routes.
 */
export async function findLatestRecordedSession(
  db: Database,
  meetingId: string,
): Promise<MeetingSessionRow | null> {
  const [row] = await db
    .select()
    .from(meetingSessions)
    .where(and(eq(meetingSessions.meetingId, meetingId), isNotNull(meetingSessions.recordingStatus)))
    .orderBy(desc(meetingSessions.createdAt))
    .limit(1);
  return row ?? null;
}
