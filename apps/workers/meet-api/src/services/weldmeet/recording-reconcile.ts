/**
 * Pull fallback for RealtimeKit recording status.
 *
 * A recording normally moves through `recording.statusUpdate` webhooks
 * (services/rtk-webhook.ts). When those never arrive (the webhook isn't
 * subscribed to the event, a delivery is rejected, RealtimeKit has an outage)
 * the session sat in "processing" forever. While a recording is unfinished,
 * reading it asks RealtimeKit for the meeting's recordings (throttled) and feeds
 * each one through the same handler a webhook would, so the part list, the copy
 * into our bucket and the derived status all follow the normal path.
 *
 * RealtimeKit having no recording at all long after the session ended means the
 * recorder never produced a file: the session is marked failed instead of
 * "processing" with no end.
 */

import { getRecordings, type RtkRecording } from '@weldsuite/cloudflare-realtime';
import {
  loadSession,
  patchSession,
  type MeetingSessionRow,
} from '@weldsuite/meet-domain/recordings';
import type { Database } from '@weldsuite/worker-kit/db';
import { logSafe } from '@weldsuite/worker-kit/log-safe';
import type { Env } from '../../types';
import { handleRecordingStatus, type RtkWebhookEvent } from '../rtk-webhook';

/** At most one RealtimeKit lookup per session per this many seconds (the UI polls). */
export const RECONCILE_THROTTLE_SECONDS = 60;

/** RealtimeKit with no recording this long after the session ended: give up. */
export const MISSING_RECORDING_GRACE_MS = 30 * 60 * 1000;

export const MISSING_RECORDING_ERROR = 'RealtimeKit has no recording for this meeting.';

function reconcileThrottleKey(sessionId: string): string {
  return `rtk-recording-reconcile:${sessionId}`;
}

/** Unfinished on our side: still recording after the session ended, or processing. */
export function needsRecordingReconcile(
  session: Pick<MeetingSessionRow, 'recordingStatus' | 'status' | 'cfAppId'>,
): boolean {
  if (!session.cfAppId) return false;
  if (session.recordingStatus === 'processing') return true;
  return session.recordingStatus === 'recording' && session.status === 'ended';
}

/** A RealtimeKit recording as the `recording.statusUpdate` payload the handler reads. */
export function recordingStatusEvent(rtkMeetingId: string, recording: RtkRecording): RtkWebhookEvent {
  return {
    event: 'recording.statusUpdate',
    meeting: { id: rtkMeetingId, sessionId: recording.session_id },
    recording: {
      id: recording.id,
      status: recording.status,
      fileSize: recording.file_size,
      recordingDuration: recording.recording_duration,
      startedTime: recording.started_time,
      stoppedTime: recording.stopped_time,
      outputFileName: recording.output_file_name,
    },
  };
}

/**
 * Bring an unfinished recording in step with RealtimeKit. Returns the session as
 * it is afterwards (the same row when nothing was checked). Never throws: a
 * failed lookup leaves the session as it was, the next read tries again.
 */
export async function reconcileRecordingFromRtk(
  env: Env,
  db: Database,
  orgId: string,
  session: MeetingSessionRow,
  now: number = Date.now(),
): Promise<MeetingSessionRow> {
  if (!needsRecordingReconcile(session)) return session;

  try {
    const key = reconcileThrottleKey(session.id);
    if (await env.WORKSPACE_CACHE.get(key)) return session;
    await env.WORKSPACE_CACHE.put(key, '1', { expirationTtl: RECONCILE_THROTTLE_SECONDS });

    const rtkMeetingId = session.cfAppId!;
    const recordings = await getRecordings(env, rtkMeetingId);
    const mapping = { orgId, type: 'session' as const, sessionId: session.id, meetingId: session.meetingId };
    const known = new Map((session.recordingParts ?? []).map((p) => [p.rtkRecordingId, p.status]));

    for (const recording of recordings) {
      // Finished on our side (copied, or the copy gave up): replaying UPLOADED
      // would only flip a failed part back to "processing" for good.
      const status = known.get(recording.id);
      if (status === 'ready' || status === 'failed') continue;
      await handleRecordingStatus(env, mapping, recordingStatusEvent(rtkMeetingId, recording));
    }

    if (recordings.length === 0 && (session.recordingParts ?? []).length === 0 && session.endedAt) {
      const endedAt = new Date(session.endedAt).getTime();
      if (now - endedAt > MISSING_RECORDING_GRACE_MS) {
        await patchSession(db, session.id, {
          recordingStatus: 'failed',
          recordingEnabled: false,
          recordingError: MISSING_RECORDING_ERROR,
        });
      }
    }

    return (await loadSession(db, session.id)) ?? session;
  } catch (err) {
    console.warn(
      `[meet-api/recording-reconcile] ${logSafe(session.id)}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return session;
  }
}
