/**
 * Cloudflare RealtimeKit Webhook — service handlers.
 *
 * Ported from apps/api-worker/src/routes/webhooks/cloudflare-realtime.ts
 * (legacy worker phase-out, W3). Handles meeting.ended,
 * meeting.participantJoined and meeting.participantLeft events. Meeting/call
 * end goes through the lifecycle services (endMeetingSessionIfEmpty /
 * endChatCallIfEmpty), which already publish their own realtime events.
 *
 * Presence is tracked per CONNECTION (RealtimeKit peer), not per user: the
 * payload identifies the peer that joined or left, and one participant can
 * have several (a second tab, or the connection the SDK re-established after a
 * network drop). A participant has left only when their last peer is gone.
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

import { and, eq, ne, sql } from 'drizzle-orm';
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
import { endMeetingSession, endMeetingSessionIfEmpty } from './weldmeet/meeting-lifecycle';
import { endChatCall, endChatCallIfEmpty } from '@weldsuite/chat-domain/call-lifecycle';

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
  /** The connection that left. A participant gets a new one on every (re)connect. */
  peerId?: string;
  /** When that connection joined the room. */
  peerJoinedAt?: string;
}

interface JoinedParticipantIds {
  customId: string | undefined;
  peerId: string | undefined;
}

/** What the presence helpers read from a stored participant (sessions and calls). */
interface TrackedParticipant {
  cfSessionId?: string;
  userId?: string;
  joinedAt?: string;
  leftAt?: string;
  lastJoinAt?: string;
  peerIds?: string[];
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

    // Ending kicks whoever is in the room, so confirm it is empty first: a late
    // or replayed meeting.ended for an earlier RealtimeKit session of this room
    // must not throw out the people who have joined it since.
    const outcome = await endMeetingSessionIfEmpty(
      db,
      env,
      mapping.orgId,
      mapping.sessionId,
      session,
      mapping.meetingId,
    );
    if (outcome === 'occupied') {
      console.log(
        `[RTK Webhook] meeting.ended for ${logSafe(rtkMeetingId)} ignored: the room has live participants`,
      );
      return;
    }
    if (outcome === 'unknown') {
      // RealtimeKit could not be asked, but it is RealtimeKit that reported the end.
      await endMeetingSession(db, env, mapping.orgId, mapping.sessionId, session, mapping.meetingId);
    }
    console.log(`[RTK Webhook] Ended session ${logSafe(mapping.sessionId)} for RTK meeting ${logSafe(rtkMeetingId)}`);
  } else if (mapping.type === 'call' && mapping.callId) {
    await handleCallMeetingEnded(env, db, mapping.orgId, mapping.callId, rtkMeetingId);
  }
}

/** meeting.ended for a WeldChat call. */
async function handleCallMeetingEnded(
  env: Env,
  db: TenantDb,
  orgId: string,
  callId: string,
  rtkMeetingId: string,
): Promise<void> {
  const { chatCalls } = schema;
  const [call] = await db
    .select()
    .from(chatCalls)
    .where(eq(chatCalls.id, callId))
    .limit(1);

  if (!call || call.status === 'ended') {
    console.log(`[RTK Webhook] Call ${callId} already ended or not found`);
    return;
  }

  // Same guard as for a session: a late or replayed meeting.ended must not
  // throw out the people who are in the call's room now.
  const outcome = await endChatCallIfEmpty(db, env, orgId, callId, call, call.initiatorId);
  if (outcome === 'occupied') {
    console.log(
      `[RTK Webhook] meeting.ended for ${logSafe(rtkMeetingId)} ignored: the call has live participants`,
    );
    return;
  }
  if (outcome === 'unknown') {
    // RealtimeKit could not be asked, but it is RealtimeKit that reported the end.
    await endChatCall(db, env, orgId, callId, call, call.initiatorId);
  }
  console.log(`[RTK Webhook] Ended call ${logSafe(callId)} for RTK meeting ${logSafe(rtkMeetingId)}`);
}

/** Match a stored participant against the RTK ids (cfSessionId first, then app-controlled id). */
function matchesParticipant(
  p: { cfSessionId?: string; userId?: string },
  { cfSessionId, customId }: Pick<LeftParticipantIds, 'cfSessionId' | 'customId'>,
): boolean {
  return Boolean((cfSessionId && p.cfSessionId === cfSessionId) || (customId && p.userId === customId));
}

/**
 * Index of the still-present participant this leave applies to, or -1.
 * A leave stamped before that participant (re)joined belongs to an earlier
 * stint — a late retry or a replayed delivery — and must not evict them.
 * Neither must the leave of a connection that started before their latest
 * join: that is the old connection (a dropped network, a reloaded tab) of
 * someone who is back in the room on a new one. RealtimeKit often notices a
 * dead connection only after the rejoin, so its leave time proves nothing.
 */
export function findLeavingParticipant(
  participants: ReadonlyArray<TrackedParticipant>,
  ids: LeftParticipantIds,
): number {
  const idx = participants.findIndex((p) => !p.leftAt && matchesParticipant(p, ids));
  const entry = participants[idx];
  if (!entry) return -1;
  const leftAt = ids.leftAt ? Date.parse(ids.leftAt) : Number.NaN;
  const joinedAt = entry.joinedAt ? Date.parse(entry.joinedAt) : Number.NaN;
  if (!Number.isNaN(leftAt) && !Number.isNaN(joinedAt) && leftAt < joinedAt) return -1;
  const peerJoinedAt = ids.peerJoinedAt ? Date.parse(ids.peerJoinedAt) : Number.NaN;
  const lastJoinAt = entry.lastJoinAt ? Date.parse(entry.lastJoinAt) : Number.NaN;
  if (!Number.isNaN(peerJoinedAt) && !Number.isNaN(lastJoinAt) && peerJoinedAt < lastJoinAt) return -1;
  return idx;
}

function withPeerIds<P extends TrackedParticipant>(participant: P, peerIds: string[]): P {
  const next = { ...participant };
  if (peerIds.length > 0) next.peerIds = peerIds;
  else delete next.peerIds;
  return next;
}

/**
 * Apply a `meeting.participantLeft` to a participant list. The connection is
 * forgotten wherever it is tracked; the participant is marked as left only
 * when it was their last known one (and the leave is theirs, see
 * {@link findLeavingParticipant}).
 */
export function applyParticipantLeft<P extends TrackedParticipant>(
  participants: ReadonlyArray<P>,
  ids: LeftParticipantIds,
  leftAtIso: string,
): { participants: P[]; changed: boolean; markedLeft: boolean } {
  const next = [...participants];
  let changed = false;

  const { peerId } = ids;
  if (peerId) {
    next.forEach((p, i) => {
      if (!p.peerIds?.includes(peerId) || !matchesParticipant(p, ids)) return;
      next[i] = withPeerIds(p, p.peerIds.filter((id) => id !== peerId));
      changed = true;
    });
  }

  const idx = findLeavingParticipant(next, ids);
  const entry = next[idx];
  // Another connection of the same participant is still in the room.
  if (!entry || (entry.peerIds?.length ?? 0) > 0) return { participants: next, changed, markedLeft: false };

  next[idx] = { ...entry, leftAt: leftAtIso };
  return { participants: next, changed: true, markedLeft: true };
}

/**
 * Apply a `meeting.participantJoined` to a participant list: remember the
 * connection and, when the participant was recorded as left, bring them back.
 * That is what a reconnect looks like from here: the SDK re-enters the room on
 * a new connection without our join route ever being called.
 */
export function applyParticipantJoined<P extends TrackedParticipant>(
  participants: ReadonlyArray<P>,
  ids: JoinedParticipantIds,
): { participants: P[]; changed: boolean; restored: boolean } {
  const next = [...participants];
  const idx = next.findIndex((p) => !!ids.customId && p.userId === ids.customId);
  const entry = next[idx];
  if (!entry) return { participants: next, changed: false, restored: false };

  const known = entry.peerIds ?? [];
  const tracked = !ids.peerId || known.includes(ids.peerId);
  const restored = !!entry.leftAt;
  if (tracked && !restored) return { participants: next, changed: false, restored: false };

  const updated = withPeerIds(entry, tracked || !ids.peerId ? known : [...known, ids.peerId]);
  delete updated.leftAt;
  next[idx] = updated;
  return { participants: next, changed: true, restored };
}

/** How often a participant-list write is retried when another writer got in between. */
const PARTICIPANT_WRITE_ATTEMPTS = 3;

type SessionRow = typeof schema.meetingSessions.$inferSelect;

/**
 * Read, change and write back a live session's participant list without
 * losing a concurrent change: the write only lands when the list is still the
 * one that was read, and is retried on a fresh read otherwise. A reconnect
 * delivers a leave (old connection) and a join (new one) at almost the same
 * moment; a plain read-then-write would let one overwrite the other.
 * Returns null when there was nothing to change or the session has ended.
 */
async function updateSessionParticipants<
  R extends { participants: MeetingSessionParticipant[]; changed: boolean },
>(
  db: TenantDb,
  sessionId: string,
  change: (participants: MeetingSessionParticipant[]) => R,
): Promise<{ session: SessionRow; result: R } | null> {
  const { meetingSessions } = schema;
  for (let attempt = 0; attempt < PARTICIPANT_WRITE_ATTEMPTS; attempt += 1) {
    const [session] = await db
      .select()
      .from(meetingSessions)
      .where(eq(meetingSessions.id, sessionId))
      .limit(1);
    if (!session || session.status === 'ended') return null;

    const current: MeetingSessionParticipant[] = session.participants ?? [];
    const result = change(current);
    if (!result.changed) return null;

    const written = await db
      .update(meetingSessions)
      .set({ participants: result.participants, updatedAt: new Date() })
      .where(
        and(
          eq(meetingSessions.id, sessionId),
          ne(meetingSessions.status, 'ended'),
          sql`${meetingSessions.participants} = ${JSON.stringify(current)}::jsonb`,
        ),
      )
      .returning({ id: meetingSessions.id });
    if (written.length > 0) return { session, result };
  }
  console.warn(`[RTK Webhook] Participant update for session ${logSafe(sessionId)} kept losing the race, skipped`);
  return null;
}

async function publishSessionParticipantsChanged(
  env: Env,
  db: TenantDb,
  orgId: string,
  session: SessionRow,
  participants: MeetingSessionParticipant[],
): Promise<void> {
  try {
    await publishEntityEventRaw({
      env,
      db,
      workspaceId: orgId,
      userId: 'system',
      entityType: 'meeting_session',
      action: 'updated',
      entityId: session.id,
      data: { ...session, participants },
      source: 'system',
    });
  } catch (err) {
    console.error('[RTK Webhook] Entity event publish failed:', err);
  }
}

async function handleSessionParticipantLeft(
  env: Env,
  db: TenantDb,
  orgId: string,
  sessionId: string,
  ids: LeftParticipantIds,
): Promise<void> {
  const written = await updateSessionParticipants(db, sessionId, (participants) =>
    applyParticipantLeft(participants, ids, new Date().toISOString()),
  );
  if (!written?.result.markedLeft) return;

  console.log(
    `[RTK Webhook] Marked participant ${logSafe(ids.cfSessionId ?? ids.customId)} as left in session ${logSafe(sessionId)}`,
  );
  await publishSessionParticipantsChanged(env, db, orgId, written.session, written.result.participants);
}

async function handleSessionParticipantJoined(
  env: Env,
  db: TenantDb,
  orgId: string,
  sessionId: string,
  ids: JoinedParticipantIds,
): Promise<void> {
  const written = await updateSessionParticipants(db, sessionId, (participants) =>
    applyParticipantJoined(participants, ids),
  );
  if (!written?.result.restored) return;

  console.log(
    `[RTK Webhook] Participant ${logSafe(ids.customId)} is back in session ${logSafe(sessionId)}`,
  );
  await publishSessionParticipantsChanged(env, db, orgId, written.session, written.result.participants);
}

/**
 * {@link findLeavingParticipant} for a WeldChat call. Every join of a call
 * writes a fresh entry, so its `joinedAt` is the participant's latest join: a
 * connection that started before it is the one they had before rejoining (a
 * reloaded tab, or the session evicted when they joined again) and its leave
 * must not mark them as left.
 *
 * Calls keep no per-connection state beyond this. A participant the SDK
 * reconnected on its own can still be recorded as left while present; that
 * only makes the list wrong, because nothing ends a call from the list alone
 * (see endChatCallIfEmpty).
 */
export function findLeavingCallParticipant(
  participants: ReadonlyArray<ChatCallParticipant>,
  ids: LeftParticipantIds,
): number {
  return findLeavingParticipant(
    participants.map((p) => ({ ...p, lastJoinAt: p.joinedAt })),
    ids,
  );
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
  const idx = findLeavingCallParticipant(participants, ids);
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
    peerId: event.participant?.peerId,
    peerJoinedAt: event.participant?.joinedAt,
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

/**
 * meeting.participantJoined: track the connection on the session's participant
 * list. WeldChat calls keep no per-connection state, so this is sessions only.
 */
export async function handleParticipantJoined(
  env: Env,
  mapping: RtkMeetingMapping,
  event: RtkWebhookEvent,
): Promise<void> {
  if (mapping.type !== 'session' || !mapping.sessionId) return;
  const ids: JoinedParticipantIds = {
    customId: event.participant?.customParticipantId,
    peerId: event.participant?.peerId,
  };
  if (!ids.customId) return;

  const db = await getTenantDbForWorkspace(env, mapping.orgId);
  await handleSessionParticipantJoined(env, db, mapping.orgId, mapping.sessionId, ids);
}
