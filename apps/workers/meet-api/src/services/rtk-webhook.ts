/**
 * Cloudflare RealtimeKit Webhook — service handlers.
 *
 * Ported from apps/api-worker/src/routes/webhooks/cloudflare-realtime.ts
 * (legacy worker phase-out, W3). Handles meeting.ended and
 * meeting.participantLeft events. Meeting/call end goes through the
 * app-api-owned lifecycle services (endMeetingSession / endChatCall), which
 * already publish their own realtime events.
 *
 * KV mapping (written when RTK meetings are created):
 *   Key: rtk-meeting:{cfMeetingId}
 *   Value: { orgId, type: 'session'|'call', sessionId?, meetingId?, callId?, channelId? }
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
import { endMeetingSession } from './weldmeet/meeting-lifecycle';
import { endChatCall } from '@weldsuite/chat-domain/call-lifecycle';

// ============================================================================
// Types
// ============================================================================

export interface RtkWebhookEvent {
  event: string;
  /** Documented payloads nest the RTK meeting under `meeting`. */
  meeting?: {
    id?: string;
    sessionId?: string;
  };
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
