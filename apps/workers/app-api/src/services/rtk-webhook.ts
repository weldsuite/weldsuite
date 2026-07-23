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
import { getTenantDbForWorkspace, schema } from '../db';
import type { Env } from '../types';
import { endMeetingSession } from './weldmeet/meeting-lifecycle';
import { endChatCall } from './chat/call-lifecycle';

// ============================================================================
// Types
// ============================================================================

export interface RtkWebhookEvent {
  event: string;
  meetingId: string;
  sessionId?: string;
  participant?: {
    id?: string;
    customParticipantId?: string;
    name?: string;
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
    console.log(`[RTK Webhook] Ended session ${mapping.sessionId} for RTK meeting ${rtkMeetingId}`);
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
    console.log(`[RTK Webhook] Ended call ${mapping.callId} for RTK meeting ${rtkMeetingId}`);
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
  const cfSessionId = event.participant?.id;
  const customId = event.participant?.customParticipantId;

  if (!cfSessionId && !customId) {
    console.log('[RTK Webhook] participantLeft — no participant ID in payload');
    return;
  }

  if (mapping.type === 'session' && mapping.sessionId) {
    const { meetingSessions } = schema;
    const [session] = await db
      .select()
      .from(meetingSessions)
      .where(eq(meetingSessions.id, mapping.sessionId))
      .limit(1);

    if (!session || session.status === 'ended') return;

    const participants: MeetingSessionParticipant[] = [...(session.participants ?? [])];
    const idx = participants.findIndex((p) =>
      (cfSessionId && p.cfSessionId === cfSessionId) ||
      (customId && p.userId === customId),
    );
    if (idx >= 0 && !participants[idx].leftAt) {
      participants[idx] = { ...participants[idx], leftAt: new Date().toISOString() };
      await db.update(meetingSessions).set({
        participants,
        updatedAt: new Date(),
      }).where(eq(meetingSessions.id, mapping.sessionId));
      console.log(`[RTK Webhook] Marked participant ${cfSessionId ?? customId} as left in session ${mapping.sessionId}`);

      try {
        await publishEntityEventRaw({
          env,
          db,
          workspaceId: mapping.orgId,
          userId: 'system',
          entityType: 'meeting_session',
          action: 'updated',
          entityId: mapping.sessionId,
          data: { ...session, participants },
          source: 'system',
        });
      } catch (err) {
        console.error('[RTK Webhook] Entity event publish failed:', err);
      }
    }
  } else if (mapping.type === 'call' && mapping.callId) {
    const { chatCalls } = schema;
    const [call] = await db
      .select()
      .from(chatCalls)
      .where(eq(chatCalls.id, mapping.callId))
      .limit(1);

    if (!call || call.status === 'ended') return;

    const participants: ChatCallParticipant[] = [...(call.participants ?? [])];
    const idx = participants.findIndex((p) =>
      (cfSessionId && p.cfSessionId === cfSessionId) ||
      (customId && p.userId === customId),
    );
    if (idx >= 0 && !participants[idx].leftAt) {
      participants[idx] = { ...participants[idx], leftAt: new Date().toISOString() };
      await db.update(chatCalls).set({
        participants,
        updatedAt: new Date(),
      }).where(eq(chatCalls.id, mapping.callId));
      console.log(`[RTK Webhook] Marked participant ${cfSessionId ?? customId} as left in call ${mapping.callId}`);

      try {
        await publishEntityEventRaw({
          env,
          db,
          workspaceId: mapping.orgId,
          userId: 'system',
          entityType: 'chat_call',
          action: 'left',
          entityId: mapping.callId,
          data: { ...call, participants },
          source: 'system',
        });
      } catch (err) {
        console.error('[RTK Webhook] Entity event publish failed:', err);
      }
    }
  }
}
