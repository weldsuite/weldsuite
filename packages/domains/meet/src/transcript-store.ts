/**
 * Persist a meeting transcript into the shared CRM transcript tables.
 *
 * WeldMeet reuses `crm_transcriptions` / `crm_transcript_segments` with
 * `activity_id = meeting session id` (no schema change; the column is
 * polymorphic: call, bot session, CRM activity). There is no unique index on
 * `activity_id`, so "one transcription per session" is enforced here by looking
 * the row up first; callers that run in parallel get deterministic workflow ids.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const { crmTranscriptions, crmTranscriptSegments } = schema;

export type TranscriptionRow = typeof crmTranscriptions.$inferSelect;

export const TRANSCRIPT_PROVIDER = {
  rtk: 'cloudflare-rtk',
  whisper: 'cloudflare-whisper',
} as const;

export const WHISPER_MODEL_NAME = 'whisper-large-v3-turbo';

export interface TranscriptSegmentInput {
  speakerId: number;
  speakerLabel: string;
  speakerName: string | null;
  text: string;
  /** Seconds from the start of the session / recording. */
  start: number;
  end: number;
}

export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/** The (single) transcription row of a session, if any. */
export async function findSessionTranscription(
  db: Database,
  sessionId: string,
): Promise<TranscriptionRow | null> {
  const [row] = await db
    .select()
    .from(crmTranscriptions)
    .where(eq(crmTranscriptions.activityId, sessionId))
    .limit(1);
  return row ?? null;
}

export interface SaveTranscriptParams {
  sessionId: string;
  /** Reuse this row (the route created it as `pending`); else the session's row or a new one. */
  transcriptionId?: string;
  provider: string;
  model: string;
  /** Detected or requested language, if known. */
  language?: string | null;
  segments: TranscriptSegmentInput[];
  metadata?: Record<string, unknown>;
}

/**
 * Write a finished transcript: upsert the transcription row as `completed`,
 * replace its segments. Idempotent for the same session, so a retried
 * workflow step leaves one row and one set of segments.
 */
export async function saveCompletedTranscript(
  db: Database,
  params: SaveTranscriptParams,
): Promise<{ id: string; wordCount: number; speakerCount: number; fullText: string }> {
  const now = new Date();
  const existing = params.transcriptionId
    ? ((
        await db
          .select()
          .from(crmTranscriptions)
          .where(eq(crmTranscriptions.id, params.transcriptionId))
          .limit(1)
      )[0] ?? null)
    : await findSessionTranscription(db, params.sessionId);

  const id = existing?.id ?? params.transcriptionId ?? generateId('trans');
  const fullText = params.segments.map((s) => s.text).join(' ');
  const wordCount = fullText.split(/\s+/).filter((w) => w.length > 0).length;
  const speakerCount = new Set(params.segments.map((s) => s.speakerId)).size;

  const values = {
    status: 'completed',
    fullText,
    provider: params.provider,
    model: params.model,
    language: (params.language ?? existing?.language ?? 'en').slice(0, 10),
    wordCount,
    speakerCount,
    errorMessage: null,
    processingStartedAt: existing?.processingStartedAt ?? now,
    processingCompletedAt: now,
    metadata: params.metadata ?? null,
    updatedAt: now,
  };

  if (existing) {
    await db.update(crmTranscriptions).set(values).where(eq(crmTranscriptions.id, id));
  } else {
    await db.insert(crmTranscriptions).values({
      id,
      activityId: params.sessionId,
      createdAt: now,
      ...values,
    });
  }

  await db.delete(crmTranscriptSegments).where(eq(crmTranscriptSegments.transcriptionId, id));

  const rows = params.segments.map((seg, index) => ({
    id: generateId('seg'),
    transcriptionId: id,
    speakerId: seg.speakerId,
    speakerLabel: seg.speakerLabel.slice(0, 50),
    speakerName: seg.speakerName ? seg.speakerName.slice(0, 255) : null,
    text: seg.text,
    startTime: seg.start,
    endTime: seg.end,
    timestamp: formatTimestamp(seg.start),
    sequenceNumber: index,
    words: null,
  }));
  for (let i = 0; i < rows.length; i += 100) {
    await db.insert(crmTranscriptSegments).values(rows.slice(i, i + 100));
  }

  return { id, wordCount, speakerCount, fullText };
}

/**
 * Mark the session's transcription failed, creating the row if the failure
 * happened before anything was stored (the RealtimeKit path has no pending row).
 */
export async function markTranscriptionFailed(
  db: Database,
  sessionId: string,
  message: string,
  transcriptionId?: string,
): Promise<void> {
  const now = new Date();
  const existing = transcriptionId
    ? ((
        await db
          .select({ id: crmTranscriptions.id })
          .from(crmTranscriptions)
          .where(eq(crmTranscriptions.id, transcriptionId))
          .limit(1)
      )[0] ?? null)
    : await findSessionTranscription(db, sessionId);
  if (existing) {
    await db
      .update(crmTranscriptions)
      .set({ status: 'failed', errorMessage: message.slice(0, 1000), updatedAt: now })
      .where(eq(crmTranscriptions.id, existing.id));
    return;
  }
  await db.insert(crmTranscriptions).values({
    id: transcriptionId ?? generateId('trans'),
    activityId: sessionId,
    status: 'failed',
    errorMessage: message.slice(0, 1000),
    createdAt: now,
    updatedAt: now,
  });
}

/** Delete a session's transcription and segments. Returns how many transcription rows went. */
export async function deleteSessionTranscripts(db: Database, sessionId: string): Promise<number> {
  const rows = await db
    .select({ id: crmTranscriptions.id })
    .from(crmTranscriptions)
    .where(eq(crmTranscriptions.activityId, sessionId));
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id);
  await db.delete(crmTranscriptSegments).where(inArray(crmTranscriptSegments.transcriptionId, ids));
  await db.delete(crmTranscriptions).where(inArray(crmTranscriptions.id, ids));
  return ids.length;
}

/** Plain-text rendering of a completed transcript for summarization. */
export async function loadTranscriptText(
  db: Database,
  transcriptionId: string,
): Promise<{ text: string; lastEndSeconds: number }> {
  const segments = await db
    .select({
      speakerLabel: crmTranscriptSegments.speakerLabel,
      text: crmTranscriptSegments.text,
      startTime: crmTranscriptSegments.startTime,
      endTime: crmTranscriptSegments.endTime,
    })
    .from(crmTranscriptSegments)
    .where(and(eq(crmTranscriptSegments.transcriptionId, transcriptionId)))
    .orderBy(asc(crmTranscriptSegments.sequenceNumber));
  const text = segments
    .map((s) => `[${formatTimestamp(s.startTime)}] ${s.speakerLabel ?? 'Speaker'}: ${s.text}`)
    .join('\n');
  const lastEndSeconds = segments.reduce((max, s) => Math.max(max, s.endTime), 0);
  return { text, lastEndSeconds };
}
