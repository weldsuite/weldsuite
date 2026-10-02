/**
 * Shared helpers for WeldMeet recordings stored in the private
 * `MEETING_RECORDINGS` R2 bucket.
 *
 * R2 layout (per session, nothing outside it):
 *   {orgId}/{sessionId}/{rtkRecordingId}.mp4     video
 *   {orgId}/{sessionId}/{rtkRecordingId}.mp3     audio only
 *   {orgId}/{sessionId}/transcript.json|csv      raw RealtimeKit transcript
 * so "delete this session's recording" is one prefix listing.
 *
 * Session row: the `recording_parts` JSON holds every RealtimeKit recording of
 * the session (stop + start again yields several). The flat `recording_*`
 * columns mirror the latest ready part, and `recording_status` is derived from
 * the parts so the UI has one value to read.
 */

import { eq } from 'drizzle-orm';
import { publishEntityEventRaw, type EntityEventPublisherEnv } from '@weldsuite/entity-events';
import type { RecordingPart } from '@weldsuite/db/schema/meeting-sessions';
import { schema, type Database } from '@weldsuite/worker-kit/db';

export type { RecordingPart };

export type RecordingStatus =
  | 'recording'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'unavailable'
  | 'deleted';

const { meetingSessions } = schema;

export type MeetingSessionRow = typeof meetingSessions.$inferSelect;

// ----------------------------------------------------------------------------
// Keys
// ----------------------------------------------------------------------------

/** Every object of a session lives under this prefix. */
export function sessionObjectPrefix(orgId: string, sessionId: string): string {
  return `${orgId}/${sessionId}/`;
}

export function recordingObjectKey(
  orgId: string,
  sessionId: string,
  rtkRecordingId: string,
  ext: string,
): string {
  return `${sessionObjectPrefix(orgId, sessionId)}${rtkRecordingId}.${ext}`;
}

export function rawTranscriptKey(orgId: string, sessionId: string, format: 'json' | 'csv'): string {
  return `${sessionObjectPrefix(orgId, sessionId)}transcript.${format}`;
}

/** File extension of an RTK output file name or URL path, lower-cased, else `fallback`. */
export function extensionOf(nameOrUrl: string | undefined | null, fallback: string): string {
  if (!nameOrUrl) return fallback;
  const path = nameOrUrl.split('?')[0] ?? '';
  const match = /\.([A-Za-z0-9]{2,5})$/.exec(path);
  return match ? match[1]!.toLowerCase() : fallback;
}

export function contentTypeForExtension(ext: string): string {
  switch (ext) {
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mp3':
      return 'audio/mpeg';
    case 'aac':
    case 'm4a':
      return 'audio/mp4';
    case 'json':
      return 'application/json';
    case 'csv':
      return 'text/csv';
    default:
      return 'application/octet-stream';
  }
}

// ----------------------------------------------------------------------------
// Parts
// ----------------------------------------------------------------------------

/** Insert or replace the part with the same RTK recording id; order is by start time. */
export function upsertRecordingPart(
  parts: RecordingPart[] | null | undefined,
  part: RecordingPart,
): RecordingPart[] {
  const next = [...(parts ?? [])];
  const idx = next.findIndex((p) => p.rtkRecordingId === part.rtkRecordingId);
  if (idx >= 0) next[idx] = { ...next[idx]!, ...part };
  else next.push(part);
  return next.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
}

/** Parts that finished copying and still have a stored audio file, in playing order. */
export function readyParts(parts: RecordingPart[] | null | undefined): RecordingPart[] {
  return (parts ?? []).filter((p) => p.status === 'ready');
}

/** Session-level status from the parts: recording > processing > ready > failed. */
export function deriveRecordingStatus(
  parts: RecordingPart[] | null | undefined,
): RecordingStatus | null {
  const list = parts ?? [];
  if (list.length === 0) return null;
  if (list.some((p) => p.status === 'recording')) return 'recording';
  if (list.some((p) => p.status === 'processing')) return 'processing';
  if (list.some((p) => p.status === 'ready')) return 'ready';
  return 'failed';
}

/** Flat column values that mirror the latest ready part (null when there is none). */
export function mirrorLatestReadyPart(parts: RecordingPart[] | null | undefined) {
  const ready = readyParts(parts);
  const latest = ready[ready.length - 1];
  return {
    recordingRtkId: latest?.rtkRecordingId ?? null,
    recordingVideoKey: latest?.videoKey ?? null,
    recordingAudioKey: latest?.audioKey ?? null,
    recordingSizeBytes: latest?.sizeBytes ?? null,
    recordingDurationSeconds: latest?.durationSeconds ?? null,
  };
}

/**
 * Column patch for a new set of parts: the parts themselves, the mirrored flat
 * columns and the derived status.
 */
export function recordingPatchFromParts(parts: RecordingPart[], now: Date = new Date()) {
  const status = deriveRecordingStatus(parts);
  return {
    recordingParts: parts,
    recordingStatus: status,
    recordingEnabled: status === 'recording',
    ...mirrorLatestReadyPart(parts),
    ...(status === 'ready' ? { recordingReadyAt: now } : {}),
  };
}

// ----------------------------------------------------------------------------
// Session row access (used by webhook handlers and workflows)
// ----------------------------------------------------------------------------

export async function loadSession(db: Database, sessionId: string): Promise<MeetingSessionRow | null> {
  const [row] = await db.select().from(meetingSessions).where(eq(meetingSessions.id, sessionId)).limit(1);
  return row ?? null;
}

export async function patchSession(
  db: Database,
  sessionId: string,
  patch: Partial<typeof meetingSessions.$inferInsert>,
): Promise<void> {
  await db
    .update(meetingSessions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(meetingSessions.id, sessionId));
}

/**
 * Fire `meeting_session:updated` from a webhook / workflow (no request
 * context). Failures are logged, never thrown: the write already happened.
 */
export async function publishSessionUpdated(
  env: EntityEventPublisherEnv,
  db: Database,
  orgId: string,
  session: Pick<MeetingSessionRow, 'id' | 'meetingId' | 'status'>,
  extra: Record<string, unknown> = {},
  userId = 'system',
): Promise<void> {
  try {
    await publishEntityEventRaw({
      env,
      db,
      workspaceId: orgId,
      userId,
      entityType: 'meeting_session',
      action: 'updated',
      entityId: session.id,
      data: { id: session.id, meetingId: session.meetingId, status: session.status, ...extra },
      source: 'system',
    });
  } catch (err) {
    console.error('[meet-recordings] entity event publish failed:', err);
  }
}
