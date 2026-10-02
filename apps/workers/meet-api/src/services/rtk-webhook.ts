/**
 * Cloudflare RealtimeKit Webhook — service handlers.
 *
 * Ported from apps/api-worker/src/routes/webhooks/cloudflare-realtime.ts
 * (legacy worker phase-out, W3). Handles meeting.ended and
 * meeting.participantLeft events. Meeting/call end goes through the
 * app-api-owned lifecycle services (endMeetingSession / endChatCall), which
 * already publish their own realtime events.
 *
 * Also the post-meeting events of RealtimeKit's own recorder:
 * recording.statusUpdate (track parts, start the copy into the private bucket),
 * meeting.transcript and meeting.summary (start the ingest workflows).
 *
 * KV mappings (written when RTK meetings are created):
 *   Key: rtk-meeting:{cfMeetingId}   24 h, deleted at session end
 *   Value: { orgId, type: 'session'|'call', sessionId?, meetingId?, callId?, channelId? }
 *   Key: rtk-session:{cfMeetingId}   14 days, survives session end (sessions only)
 *   Value: { orgId, sessionId, meetingId }
 *
 * Delta vs api-worker: the participantLeft mutations additionally publish
 * entity events (meeting_session:updated / chat_call:left).
 */

import { eq } from 'drizzle-orm';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import type { MeetingSessionParticipant } from '@weldsuite/db/schema/meeting-sessions';
import type { ChatCallParticipant } from '@weldsuite/db/schema/chat-calls';
import { getTenantDbForWorkspace, schema } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';
import { logSafe } from '@weldsuite/worker-kit/log-safe';
import {
  loadSession,
  patchSession,
  publishSessionUpdated,
  recordingPatchFromParts,
  upsertRecordingPart,
  type RecordingPart,
} from '@weldsuite/meet-domain/recordings';
import { endMeetingSession } from './weldmeet/meeting-lifecycle';
import { endChatCall } from '@weldsuite/chat-domain/call-lifecycle';

// ============================================================================
// Types
// ============================================================================

/**
 * `recording.statusUpdate` payload (developers.cloudflare.com/realtime/realtimekit/webhooks).
 * UNVERIFIED against a live delivery: the docs sample shows `recording.meetingId`
 * differing from `meeting.id`, `fileSize` as a string and ISO timestamps, so every
 * field is optional and read defensively. The receiver logs the raw key set once
 * per event type per isolate to confirm the shape on the first test delivery.
 */
export interface RtkRecordingPayload {
  id?: string;
  recordingId?: string;
  /** INVOKED | RECORDING | UPLOADING | UPLOADED | ERRORED | PAUSED */
  status?: string;
  downloadUrl?: string;
  audioDownloadUrl?: string;
  downloadUrlExpiry?: string;
  startedTime?: string;
  stoppedTime?: string;
  /** A string in the documented sample. */
  fileSize?: string | number;
  outputFileName?: string;
  meetingId?: string;
  /** Seconds. */
  recordingDuration?: number | string;
}

export interface RtkWebhookEvent {
  event: string;
  /** Documented payloads nest the RTK meeting under `meeting`. */
  meeting?: {
    id?: string;
    sessionId?: string;
    title?: string;
    status?: string;
    startedAt?: string;
    endedAt?: string;
  };
  /** `recording.statusUpdate` only. */
  recording?: RtkRecordingPayload;
  /** `meeting.transcript` only (CSV, expires in about 7 days). */
  transcriptDownloadUrl?: string;
  transcriptDownloadUrlExpiry?: string;
  /** `meeting.summary` only (markdown, expires in about 7 days). */
  summaryDownloadUrl?: string;
  summaryDownloadUrlExpiry?: string;
  /** Legacy flat shape. */
  meetingId?: string;
  sessionId?: string;
  participant?: {
    id?: string;
    peerId?: string;
    customParticipantId?: string;
    name?: string;
    joinedAt?: string;
    leftAt?: string;
  };
  [key: string]: unknown;
}

export interface RtkMeetingMapping {
  orgId: string;
  type: 'session' | 'call';
  sessionId?: string;
  meetingId?: string;
  callId?: string;
  channelId?: string;
}

/**
 * Long-lived mapping `rtk-session:{rtkMeetingId}`, written wherever the 24 h
 * `rtk-meeting:` mapping is written for a WeldMeet session and NEVER deleted at
 * session end: `recording.statusUpdate`, `meeting.transcript` and
 * `meeting.summary` all arrive AFTER the meeting ends, when `rtk-meeting:` is
 * already gone. TTL 14 days (RealtimeKit keeps recordings and transcripts about
 * 7). Chat calls never get this key, so their recording events fall through to
 * "no mapping, skip".
 */
export interface RtkSessionMapping {
  orgId: string;
  sessionId: string;
  meetingId: string;
}

export const RTK_SESSION_MAPPING_TTL_SECONDS = 14 * 24 * 60 * 60;

export function rtkSessionMappingKey(rtkMeetingId: string): string {
  return `rtk-session:${rtkMeetingId}`;
}

/** Write the post-meeting mapping (call alongside the `rtk-meeting:` write). */
export async function putRtkSessionMapping(
  env: Pick<Env, 'WORKSPACE_CACHE'>,
  rtkMeetingId: string,
  mapping: RtkSessionMapping,
): Promise<void> {
  await env.WORKSPACE_CACHE.put(rtkSessionMappingKey(rtkMeetingId), JSON.stringify(mapping), {
    expirationTtl: RTK_SESSION_MAPPING_TTL_SECONDS,
  });
}

/**
 * Candidate RTK meeting ids of an event, most specific first. The docs sample
 * shows `recording.meetingId` differing from `meeting.id`, so both are tried.
 */
export function rtkMeetingIdCandidates(event: RtkWebhookEvent): string[] {
  const ids = [event.meeting?.id, event.recording?.meetingId, event.meetingId];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

/** Events that arrive after the meeting ended and resolve via `rtk-session:`. */
export const POST_MEETING_EVENTS = new Set([
  'recording.statusUpdate',
  'meeting.transcript',
  'meeting.summary',
]);

/**
 * Resolve the mapping for a post-meeting event: `rtk-session:` first, then the
 * 24 h `rtk-meeting:` one (still alive for a recording that finishes while the
 * meeting is live). Returns null for unknown meetings and chat calls.
 */
export async function resolvePostMeetingMapping(
  env: Pick<Env, 'WORKSPACE_CACHE'>,
  event: RtkWebhookEvent,
): Promise<RtkMeetingMapping | null> {
  for (const id of rtkMeetingIdCandidates(event)) {
    const durable = (await env.WORKSPACE_CACHE.get(rtkSessionMappingKey(id), 'json')) as RtkSessionMapping | null;
    if (durable?.sessionId) return { ...durable, type: 'session' };
  }
  for (const id of rtkMeetingIdCandidates(event)) {
    const live = (await env.WORKSPACE_CACHE.get(`rtk-meeting:${id}`, 'json')) as RtkMeetingMapping | null;
    if (live?.type === 'session' && live.sessionId) return live;
  }
  return null;
}

type TenantDb = Awaited<ReturnType<typeof getTenantDbForWorkspace>>;

interface LeftParticipantIds {
  cfSessionId: string | undefined;
  customId: string | undefined;
  /** When RTK says the participant left (signed, part of the payload). */
  leftAt: string | undefined;
}

// ============================================================================
// Event Handlers
// ============================================================================

export async function handleMeetingEnded(
  env: Env,
  mapping: RtkMeetingMapping,
  rtkMeetingId: string,
): Promise<void> {
  const db = await getTenantDbForWorkspace(env, mapping.orgId);

  if (mapping.type === 'session' && mapping.sessionId && mapping.meetingId) {
    const { meetingSessions } = schema;
    const [session] = await db
      .select()
      .from(meetingSessions)
      .where(eq(meetingSessions.id, mapping.sessionId))
      .limit(1);

    if (!session || session.status === 'ended') {
      console.log(`[RTK Webhook] Session ${mapping.sessionId} already ended or not found`);
      return;
    }

    await endMeetingSession(db, env, mapping.orgId, mapping.sessionId, session, mapping.meetingId);
    console.log(`[RTK Webhook] Ended session ${logSafe(mapping.sessionId)} for RTK meeting ${logSafe(rtkMeetingId)}`);
  } else if (mapping.type === 'call' && mapping.callId) {
    const { chatCalls } = schema;
    const [call] = await db
      .select()
      .from(chatCalls)
      .where(eq(chatCalls.id, mapping.callId))
      .limit(1);

    if (!call || call.status === 'ended') {
      console.log(`[RTK Webhook] Call ${mapping.callId} already ended or not found`);
      return;
    }

    await endChatCall(db, env, mapping.orgId, mapping.callId, call, call.initiatorId);
    console.log(`[RTK Webhook] Ended call ${logSafe(mapping.callId)} for RTK meeting ${logSafe(rtkMeetingId)}`);
  }
}

/** Match a stored participant against the RTK ids (cfSessionId first, then app-controlled id). */
function matchesParticipant(
  p: { cfSessionId?: string; userId?: string },
  { cfSessionId, customId }: LeftParticipantIds,
): boolean {
  return Boolean((cfSessionId && p.cfSessionId === cfSessionId) || (customId && p.userId === customId));
}

/**
 * Index of the still-present participant this leave applies to, or -1.
 * A leave stamped before that participant (re)joined belongs to an earlier
 * stint — a late retry or a replayed delivery — and must not evict them.
 */
export function findLeavingParticipant(
  participants: Array<{ cfSessionId?: string; userId?: string; joinedAt?: string; leftAt?: string }>,
  ids: LeftParticipantIds,
): number {
  const idx = participants.findIndex((p) => !p.leftAt && matchesParticipant(p, ids));
  if (idx < 0) return -1;
  const leftAt = ids.leftAt ? Date.parse(ids.leftAt) : Number.NaN;
  const joinedAt = participants[idx].joinedAt ? Date.parse(participants[idx].joinedAt) : Number.NaN;
  if (!Number.isNaN(leftAt) && !Number.isNaN(joinedAt) && leftAt < joinedAt) return -1;
  return idx;
}

async function handleSessionParticipantLeft(
  env: Env,
  db: TenantDb,
  orgId: string,
  sessionId: string,
  ids: LeftParticipantIds,
): Promise<void> {
  const { meetingSessions } = schema;
  const [session] = await db
    .select()
    .from(meetingSessions)
    .where(eq(meetingSessions.id, sessionId))
    .limit(1);

  if (!session || session.status === 'ended') return;

  const participants: MeetingSessionParticipant[] = [...(session.participants ?? [])];
  const idx = findLeavingParticipant(participants, ids);
  if (idx < 0) return;

  participants[idx] = { ...participants[idx], leftAt: new Date().toISOString() };
  await db.update(meetingSessions).set({
    participants,
    updatedAt: new Date(),
  }).where(eq(meetingSessions.id, sessionId));
  console.log(
    `[RTK Webhook] Marked participant ${logSafe(ids.cfSessionId ?? ids.customId)} as left in session ${logSafe(sessionId)}`,
  );

  try {
    await publishEntityEventRaw({
      env,
      db,
      workspaceId: orgId,
      userId: 'system',
      entityType: 'meeting_session',
      action: 'updated',
      entityId: sessionId,
      data: { ...session, participants },
      source: 'system',
    });
  } catch (err) {
    console.error('[RTK Webhook] Entity event publish failed:', err);
  }
}

async function handleCallParticipantLeft(
  env: Env,
  db: TenantDb,
  orgId: string,
  callId: string,
  ids: LeftParticipantIds,
): Promise<void> {
  const { chatCalls } = schema;
  const [call] = await db
    .select()
    .from(chatCalls)
    .where(eq(chatCalls.id, callId))
    .limit(1);

  if (!call || call.status === 'ended') return;

  const participants: ChatCallParticipant[] = [...(call.participants ?? [])];
  const idx = findLeavingParticipant(participants, ids);
  if (idx < 0) return;

  participants[idx] = { ...participants[idx], leftAt: new Date().toISOString() };
  await db.update(chatCalls).set({
    participants,
    updatedAt: new Date(),
  }).where(eq(chatCalls.id, callId));
  console.log(
    `[RTK Webhook] Marked participant ${logSafe(ids.cfSessionId ?? ids.customId)} as left in call ${logSafe(callId)}`,
  );

  try {
    await publishEntityEventRaw({
      env,
      db,
      workspaceId: orgId,
      userId: 'system',
      entityType: 'chat_call',
      action: 'left',
      entityId: callId,
      data: { ...call, participants },
      source: 'system',
    });
  } catch (err) {
    console.error('[RTK Webhook] Entity event publish failed:', err);
  }
}

// ============================================================================
// Post-meeting events: recording.statusUpdate, meeting.transcript, meeting.summary
// ============================================================================

const loggedPayloadShapes = new Set<string>();

/**
 * Log the raw key set of the first delivery of each post-meeting event type per
 * isolate, so the unverified payload shapes (see {@link RtkRecordingPayload})
 * can be confirmed from the first test-environment deliveries. Keys only, never values.
 */
export function logPayloadShapeOnce(event: RtkWebhookEvent): void {
  if (!POST_MEETING_EVENTS.has(event.event) || loggedPayloadShapes.has(event.event)) return;
  loggedPayloadShapes.add(event.event);
  console.info(`[RTK Webhook] first ${logSafe(event.event)} payload keys`, {
    top: Object.keys(event),
    meeting: Object.keys(event.meeting ?? {}),
    recording: Object.keys(event.recording ?? {}),
  });
}

/** Test seam: forget which payload shapes were logged. */
export function resetLoggedPayloadShapes(): void {
  loggedPayloadShapes.clear();
}

function toNumber(value: string | number | undefined | null): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** RealtimeKit recording status -> our part status; null = ignore the event. */
export function partStatusFor(rtkStatus: string): RecordingPart['status'] | null {
  switch (rtkStatus) {
    case 'INVOKED':
    case 'RECORDING':
      return 'recording';
    case 'UPLOADING':
    case 'UPLOADED':
      return 'processing';
    case 'ERRORED':
      return 'failed';
    default:
      return null; // PAUSED and anything new
  }
}

/** Create a Workflow instance; a repeat of the same id (webhook redelivery) is not an error. */
async function startWorkflow<P>(
  binding: Workflow<P> | undefined,
  label: string,
  id: string,
  params: P,
): Promise<void> {
  if (!binding) {
    console.warn(`[RTK Webhook] ${label} binding not configured, skipping dispatch of ${logSafe(id)}`);
    return;
  }
  try {
    await binding.create({ id, params });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Cloudflare words this "instance.already_exists" / "instance with that id already exists".
    if (/already[\s_.]*exist|duplicate|id[\s_.]*conflict/i.test(message)) {
      console.info(`[RTK Webhook] ${label} ${logSafe(id)} already running, skipping`);
      return;
    }
    throw err;
  }
}

/**
 * recording.statusUpdate: keep the session's `recording_parts` in step with
 * RealtimeKit and, on UPLOADED, start the copy into the private bucket.
 * Idempotent: a part that is already `ready` ignores every later event.
 */
export async function handleRecordingStatus(
  env: Env,
  mapping: RtkMeetingMapping,
  event: RtkWebhookEvent,
): Promise<void> {
  if (mapping.type !== 'session' || !mapping.sessionId) return;
  const rec = event.recording;
  const rtkRecordingId = rec?.id ?? rec?.recordingId;
  const rtkStatus = rec?.status?.toUpperCase();
  if (!rtkRecordingId || !rtkStatus) {
    console.warn('[RTK Webhook] recording.statusUpdate without recording id/status');
    return;
  }
  const next = partStatusFor(rtkStatus);
  if (!next) return;

  const db = await getTenantDbForWorkspace(env, mapping.orgId);
  const session = await loadSession(db, mapping.sessionId);
  if (!session) {
    console.info(`[RTK Webhook] recording event for missing session ${logSafe(mapping.sessionId)}`);
    return;
  }

  const existing = (session.recordingParts ?? []).find((p) => p.rtkRecordingId === rtkRecordingId);
  // Already copied: a redelivery or a late out-of-order event.
  if (existing?.status === 'ready') return;
  // The recording was deleted by the user; a stale upload event for it must not resurrect it.
  if (!existing && session.recordingStatus === 'deleted' && next !== 'recording') return;
  // Never move backwards (RECORDING arriving after UPLOADING).
  if (existing?.status === 'processing' && next === 'recording') return;

  const part: RecordingPart = {
    rtkRecordingId,
    videoKey: existing?.videoKey ?? null,
    audioKey: existing?.audioKey ?? null,
    sizeBytes: toNumber(rec?.fileSize) ?? existing?.sizeBytes ?? null,
    durationSeconds: toNumber(rec?.recordingDuration) ?? existing?.durationSeconds ?? null,
    startedAt: rec?.startedTime ?? existing?.startedAt ?? null,
    stoppedAt: rec?.stoppedTime ?? existing?.stoppedAt ?? null,
    status: next,
  };
  const parts = upsertRecordingPart(session.recordingParts, part);
  const rtkSessionId = event.meeting?.sessionId ?? event.sessionId;

  await patchSession(db, session.id, {
    ...recordingPatchFromParts(parts),
    recordingError: next === 'failed' ? `RealtimeKit reported the recording as ${rtkStatus}` : null,
    ...(rtkSessionId && !session.rtkSessionId ? { rtkSessionId } : {}),
  });

  if (rtkStatus === 'UPLOADED') {
    try {
      await startWorkflow(env.MEETING_RECORDING_COPY, 'MEETING_RECORDING_COPY', `rec-${rtkRecordingId}`, {
        orgId: mapping.orgId,
        sessionId: session.id,
        rtkRecordingId,
        startedAt: part.startedAt,
        stoppedAt: part.stoppedAt,
        durationSeconds: part.durationSeconds,
      });
    } catch (err) {
      // Without the copy the part would sit in "processing" forever.
      const message = `Could not start the recording copy: ${err instanceof Error ? err.message : String(err)}`;
      const failed = upsertRecordingPart(parts, { ...part, status: 'failed' });
      await patchSession(db, session.id, { ...recordingPatchFromParts(failed), recordingError: message });
      console.error(`[RTK Webhook] ${message}`);
    }
  }

  const status = (await loadSession(db, session.id))?.recordingStatus ?? null;
  await publishSessionUpdated(env, db, mapping.orgId, session, { recordingStatus: status });
}

/** meeting.transcript: hand the expiring URL to the ingest workflow (never download here). */
export async function handleMeetingTranscript(
  env: Env,
  mapping: RtkMeetingMapping,
  event: RtkWebhookEvent,
): Promise<void> {
  if (mapping.type !== 'session' || !mapping.sessionId) return;
  const db = await getTenantDbForWorkspace(env, mapping.orgId);
  const session = await loadSession(db, mapping.sessionId);
  if (!session) return;

  const rtkSessionId = event.meeting?.sessionId ?? event.sessionId ?? session.rtkSessionId ?? null;
  if (rtkSessionId && session.rtkSessionId !== rtkSessionId) {
    await patchSession(db, session.id, { rtkSessionId });
  }

  await startWorkflow(env.MEETING_AI, 'MEETING_AI', `rtk-transcript-${session.id}`, {
    kind: 'ingest-rtk-transcript',
    orgId: mapping.orgId,
    sessionId: session.id,
    rtkSessionId,
    downloadUrl: event.transcriptDownloadUrl ?? null,
  });
}

/** meeting.summary: same shape as the transcript, markdown text. */
export async function handleMeetingSummary(
  env: Env,
  mapping: RtkMeetingMapping,
  event: RtkWebhookEvent,
): Promise<void> {
  if (mapping.type !== 'session' || !mapping.sessionId) return;
  const db = await getTenantDbForWorkspace(env, mapping.orgId);
  const session = await loadSession(db, mapping.sessionId);
  if (!session) return;

  const rtkSessionId = event.meeting?.sessionId ?? event.sessionId ?? session.rtkSessionId ?? null;
  if (rtkSessionId && session.rtkSessionId !== rtkSessionId) {
    await patchSession(db, session.id, { rtkSessionId });
  }

  await startWorkflow(env.MEETING_AI, 'MEETING_AI', `rtk-summary-${session.id}`, {
    kind: 'ingest-rtk-summary',
    orgId: mapping.orgId,
    sessionId: session.id,
    rtkSessionId,
    downloadUrl: event.summaryDownloadUrl ?? null,
  });
}

export async function handleParticipantLeft(
  env: Env,
  mapping: RtkMeetingMapping,
  event: RtkWebhookEvent,
): Promise<void> {
  const db = await getTenantDbForWorkspace(env, mapping.orgId);
  // `event.participant.id` is the RTK-assigned session id (stable for that
  // participant, recorded as `cfSessionId` when we called addParticipant).
  // `customParticipantId` is now app-controlled (e.g. the meeting-portal's
  // colorSeed) so we no longer rely on it for the session-participants
  // lookup — match on cfSessionId first, then fall back to customParticipantId.
  const ids: LeftParticipantIds = {
    cfSessionId: event.participant?.id,
    customId: event.participant?.customParticipantId,
    leftAt: event.participant?.leftAt,
  };

  if (!ids.cfSessionId && !ids.customId) {
    console.log('[RTK Webhook] participantLeft — no participant ID in payload');
    return;
  }

  if (mapping.type === 'session' && mapping.sessionId) {
    await handleSessionParticipantLeft(env, db, mapping.orgId, mapping.sessionId, ids);
  } else if (mapping.type === 'call' && mapping.callId) {
    await handleCallParticipantLeft(env, db, mapping.orgId, mapping.callId, ids);
  }
}
