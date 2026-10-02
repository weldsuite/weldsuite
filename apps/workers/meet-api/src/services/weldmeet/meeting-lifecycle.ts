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
import {
  endMeeting as endRtkMeeting,
  kickAllParticipants as kickAllRtkParticipants,
} from '@weldsuite/cloudflare-realtime';
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

/**
 * A scheduled meeting is past once its end (or, without one, start + 1h) has
 * elapsed. Unscheduled meetings ("Create a meeting for later", instant
 * meetings) are reusable rooms: they are never past, so ending a session
 * returns them to 'scheduled' and the same link can start a new session.
 */
export function isMeetingPast(
  meeting: { scheduledEnd: Date | null; scheduledStart: Date | null } | undefined,
  now: Date,
): boolean {
  if (meeting?.scheduledEnd) return new Date(meeting.scheduledEnd).getTime() < now.getTime();
  if (meeting?.scheduledStart) {
    return new Date(meeting.scheduledStart).getTime() < now.getTime() - 60 * 60_000;
  }
  return false;
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

  // Re-read the row: callers pass a snapshot that may be stale, and several
  // clients (host end, every kicked guest's /leave, the RTK webhook) race to
  // end the same session. The first one wins; the rest are no-ops so they
  // cannot overwrite endedAt / duration.
  const [current] = await db
    .select({
      status: meetingSessions.status,
      participants: meetingSessions.participants,
      recordingStatus: meetingSessions.recordingStatus,
    })
    .from(meetingSessions)
    .where(eq(meetingSessions.id, sessionId))
    .limit(1);
  if (current?.status === 'ended') return;

  const now = new Date();
  const duration = session.startedAt
    ? Math.round((now.getTime() - new Date(session.startedAt).getTime()) / 1000)
    : 0;

  // A meeting that ends while still recording: RealtimeKit stops the recorder and
  // follows with recording.statusUpdate UPLOADING / UPLOADED, which drives the rest
  // (copy into the private bucket, status 'ready'). Until then the recording is
  // "processing". Nothing about the recording is linked here any more.

  // Everyone still in the room leaves with the session.
  const participants = (current?.participants ?? []).map((p) =>
    p.leftAt ? p : { ...p, leftAt: now.toISOString() },
  );

  await db
    .update(meetingSessions)
    .set({
      status: 'ended',
      endedAt: now,
      duration,
      participants,
      ...(current?.recordingStatus === 'recording'
        ? { recordingStatus: 'processing', recordingEnabled: false }
        : {}),
      updatedAt: now,
    })
    .where(eq(meetingSessions.id, sessionId));

  // Update meeting: clear active session, set back to scheduled or completed
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

  // Tear down the RTK room (best effort, DB is already the source of truth).
  // Deactivating the meeting alone does not disconnect live participants, so
  // kick them first; the two calls are independent so one failing never
  // skips the other. A kick on an empty or already-inactive room may be
  // rejected, which is expected and only logged.
  if (session.cfAppId) {
    const cfAppId = session.cfAppId;
    try {
      await kickAllRtkParticipants(env, cfAppId);
    } catch (err) {
      console.error('[MeetingLifecycle] RTK kick-all failed', { sessionId, cfAppId, err });
    }
    try {
      await endRtkMeeting(env, cfAppId);
    } catch (err) {
      console.error('[MeetingLifecycle] RTK end meeting failed', { sessionId, cfAppId, err });
    }
  }

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
