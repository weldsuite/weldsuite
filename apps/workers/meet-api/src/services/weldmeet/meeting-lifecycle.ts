/**
 * Meeting Lifecycle — End Session
 *
 * Shared logic for ending a WeldMeet session. Used by session route handlers
 * (leave/end/active stale-check) and the Cloudflare RealtimeKit webhook receiver.
 *
 * Ported from apps/api-worker/src/services/meeting-lifecycle.ts (WeldMeet path only).
 * The WeldChat endChatCall path lives in @weldsuite/chat-domain/call-lifecycle.
 */

import { eq } from 'drizzle-orm';
import { endMeeting as endRtkMeeting } from '@weldsuite/cloudflare-realtime';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import type { Env } from '../../types';

// ============================================================================
// Realtime publisher helpers (inlined to avoid a separate file just for these)
// ============================================================================

function getPublisher(env: Env): RealtimePublisher {
  return new RealtimePublisher(env.REALTIME!);
}

export async function publishSessionStarted(
  env: Env,
  workspaceId: string,
  data: { meetingId: string; sessionId: string; startedBy: string },
): Promise<void> {
  const rt = getPublisher(env);
  await rt.entityCreated(workspaceId, 'meeting_session', data, data.startedBy);
}

export async function publishSessionEnded(
  env: Env,
  workspaceId: string,
  data: { meetingId: string; sessionId: string; duration?: number },
): Promise<void> {
  const rt = getPublisher(env);
  await rt.entityUpdated(workspaceId, 'meeting_session', { ...data, status: 'ended' }, 'system');
}

export async function publishMeetingUpdated(
  env: Env,
  workspaceId: string,
  data: { meetingId: string; title?: string; status?: string },
): Promise<void> {
  const rt = getPublisher(env);
  await rt.entityUpdated(workspaceId, 'meeting', data, 'system');
}

// ============================================================================
// End session
// ============================================================================

function isMeetingPast(
  meeting: { scheduledEnd: Date | null; scheduledStart: Date | null } | undefined,
  now: Date,
): boolean {
  if (meeting?.scheduledEnd) return new Date(meeting.scheduledEnd).getTime() < now.getTime();
  if (meeting?.scheduledStart) {
    return new Date(meeting.scheduledStart).getTime() < now.getTime() - 60 * 60_000;
  }
  return true;
}

export async function endMeetingSession(
  db: Database,
  env: Env,
  orgId: string,
  sessionId: string,
  session: { startedAt: Date | null; cfAppId: string | null },
  meetingId: string,
): Promise<void> {
  const { meetingSessions, meetings } = schema;

  const now = new Date();
  const duration = session.startedAt
    ? Math.round((now.getTime() - new Date(session.startedAt).getTime()) / 1000)
    : 0;

  // A meeting that ends while still recording: RealtimeKit stops the recorder and
  // follows with recording.statusUpdate UPLOADING / UPLOADED, which drives the rest
  // (copy into the private bucket, status 'ready'). Until then the recording is
  // "processing". Nothing about the recording is linked here any more.
  const [recInfo] = await db
    .select({ recordingStatus: meetingSessions.recordingStatus })
    .from(meetingSessions)
    .where(eq(meetingSessions.id, sessionId))
    .limit(1);

  await db
    .update(meetingSessions)
    .set({
      status: 'ended',
      endedAt: now,
      duration,
      ...(recInfo?.recordingStatus === 'recording'
        ? { recordingStatus: 'processing', recordingEnabled: false }
        : {}),
      updatedAt: now,
    })
    .where(eq(meetingSessions.id, sessionId));

  // End RTK meeting (best effort)
  if (session.cfAppId) {
    try {
      await endRtkMeeting(env, session.cfAppId);
    } catch { /* best effort */ }
  }

  // Update meeting — clear active session, set back to scheduled or completed
  const [meeting] = await db
    .select({
      scheduledEnd: meetings.scheduledEnd,
      scheduledStart: meetings.scheduledStart,
    })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);

  const isPast = isMeetingPast(meeting, now);

  await db
    .update(meetings)
    .set({
      activeSessionId: null,
      status: isPast ? 'completed' : 'scheduled',
      updatedAt: now,
    })
    .where(eq(meetings.id, meetingId));

  // Clean up the 24 h KV mapping (best effort — missing binding logs/noop, never
  // throws). The 14-day `rtk-session:` mapping is deliberately LEFT: recording,
  // transcript and summary webhooks arrive after the meeting ends.
  if (session.cfAppId) {
    try {
      await env.WORKSPACE_CACHE.delete(`rtk-meeting:${session.cfAppId}`);
    } catch { /* best effort */ }
  }

  // Realtime publishes (best effort)
  try {
    if (orgId) {
      await publishSessionEnded(env, orgId, { meetingId, sessionId, duration });
      await publishMeetingUpdated(env, orgId, {
        meetingId,
        status: isPast ? 'completed' : 'scheduled',
      });
    }
  } catch (e) {
    console.error('[MeetingLifecycle] Realtime publish failed:', e);
  }
}
