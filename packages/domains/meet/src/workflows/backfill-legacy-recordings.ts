/**
 * BackfillLegacyRecordingsWorkflow — Cloudflare Workflow (operator-started)
 *
 * Before RealtimeKit's own recorder, a session's recording was only a marker
 * (`recording_key`, the RTK meeting id) or an expiring Cloudflare URL
 * (`recording_url`), and `recording_status` stayed null. RealtimeKit keeps a
 * recording about 7 days, so every day without a backfill loses a day of legacy
 * recordings.
 *
 * One instance per workspace. For every session with a legacy marker and a null
 * `recording_status`:
 *   - the RTK recording is still there (ended within the last 7 days and
 *     RealtimeKit lists an UPLOADED recording with a download URL): register it
 *     as a `processing` part and hand it to CopyMeetingRecordingWorkflow
 *     (deterministic id `rec-{rtkRecordingId}`, so nothing is copied twice);
 *   - otherwise it is gone: `recording_status = 'unavailable'` (the UI shows
 *     "expired").
 *
 * Idempotent and safe to re-run: a session leaves the candidate set as soon as it
 * has a status, and the copy workflow ids are deterministic. At most
 * {@link BACKFILL_SESSIONS_PER_RUN} sessions per instance (workflow step limit);
 * re-run to continue.
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { and, asc, isNotNull, isNull, or } from 'drizzle-orm';
import { getRecordings, type RtkRecording } from '@weldsuite/cloudflare-realtime';
import { getTenantDbForWorkspace, schema, type Database } from '@weldsuite/worker-kit/db';
import type { MeetDomainEnv } from '../env';
import {
  loadSession,
  patchSession,
  publishSessionUpdated,
  recordingPatchFromParts,
  upsertRecordingPart,
  type RecordingPart,
} from '../recordings';

export interface BackfillLegacyRecordingsParams {
  /** Clerk org id (the tenant key). */
  orgId: string;
}

/** RealtimeKit keeps recordings about this long. */
export const RTK_RECORDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const BACKFILL_SESSIONS_PER_RUN = 400;

const { meetingSessions } = schema;

/** Sessions that still carry only a legacy recording marker. */
export function legacyRecordingCandidates(db: Database, limit: number) {
  return db
    .select({
      id: meetingSessions.id,
      cfAppId: meetingSessions.cfAppId,
      endedAt: meetingSessions.endedAt,
      startedAt: meetingSessions.startedAt,
    })
    .from(meetingSessions)
    .where(
      and(
        isNull(meetingSessions.recordingStatus),
        or(isNotNull(meetingSessions.recordingUrl), isNotNull(meetingSessions.recordingKey)),
      ),
    )
    .orderBy(asc(meetingSessions.createdAt))
    .limit(limit);
}

/** Recordings RealtimeKit can still serve: UPLOADED, with a URL that has not expired. */
export function servableRecordings(recordings: RtkRecording[], now: Date): RtkRecording[] {
  return recordings.filter((r) => {
    if (r.status !== 'UPLOADED' || !r.download_url) return false;
    if (r.download_url_expiry && Date.parse(r.download_url_expiry) <= now.getTime()) return false;
    return true;
  });
}

function isDuplicateInstance(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already[\s_.]*exist|duplicate|id[\s_.]*conflict/i.test(message);
}

export type BackfillOutcome = 'queued' | 'unavailable' | 'skipped';

export class BackfillLegacyRecordingsWorkflow extends WorkflowEntrypoint<
  MeetDomainEnv,
  BackfillLegacyRecordingsParams
> {
  async run(event: WorkflowEvent<BackfillLegacyRecordingsParams>, step: WorkflowStep) {
    const { orgId } = event.payload;

    const sessionIds = await step.do('list-candidates', { retries: { limit: 3, delay: '5 seconds' } }, async () => {
      const db = await getTenantDbForWorkspace(this.env, orgId);
      const rows = await legacyRecordingCandidates(db, BACKFILL_SESSIONS_PER_RUN);
      return rows.map((r) => r.id);
    });

    const outcomes: Record<BackfillOutcome, number> = { queued: 0, unavailable: 0, skipped: 0 };
    for (const sessionId of sessionIds) {
      const outcome = await step.do(
        `backfill-${sessionId}`,
        { retries: { limit: 3, delay: '20 seconds', backoff: 'exponential' } },
        () => this.backfillSession(orgId, sessionId),
      );
      outcomes[outcome]++;
    }
    console.info(`[BackfillLegacyRecordings] ${orgId}: ${JSON.stringify(outcomes)} of ${sessionIds.length}`);
    return { orgId, ...outcomes, hasMore: sessionIds.length >= BACKFILL_SESSIONS_PER_RUN };
  }

  /** One session: queue the copy of what RealtimeKit still has, else mark it unavailable. */
  private async backfillSession(orgId: string, sessionId: string): Promise<BackfillOutcome> {
    const db = await getTenantDbForWorkspace(this.env, orgId);
    const session = await loadSession(db, sessionId);
    // Already handled by a concurrent run / the webhook.
    if (!session || session.recordingStatus !== null) return 'skipped';

    const now = new Date();
    const endedAt = session.endedAt ?? session.startedAt ?? session.createdAt;
    const expiredByAge = now.getTime() - new Date(endedAt).getTime() > RTK_RECORDING_RETENTION_MS;

    let usable: RtkRecording[] = [];
    if (session.cfAppId && !expiredByAge) {
      try {
        usable = servableRecordings(await getRecordings(this.env, session.cfAppId), now);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // RealtimeKit no longer knows the meeting: the recording is gone. Anything else retries.
        if (!/\b404\b/.test(message)) throw err;
      }
    }

    if (usable.length === 0) {
      await patchSession(db, sessionId, { recordingStatus: 'unavailable', recordingEnabled: false });
      await publishSessionUpdated(this.env, db, orgId, session, { recordingStatus: 'unavailable' });
      return 'unavailable';
    }

    let parts: RecordingPart[] = session.recordingParts ?? [];
    for (const rec of usable) {
      parts = upsertRecordingPart(parts, {
        rtkRecordingId: rec.id,
        videoKey: null,
        audioKey: null,
        sizeBytes: rec.file_size ?? null,
        durationSeconds: rec.recording_duration ?? null,
        startedAt: rec.started_time ?? null,
        stoppedAt: rec.stopped_time ?? null,
        status: 'processing',
      });
    }
    const rtkSessionId = usable.find((r) => r.session_id)?.session_id;
    await patchSession(db, sessionId, {
      ...recordingPatchFromParts(parts),
      ...(rtkSessionId && !session.rtkSessionId ? { rtkSessionId } : {}),
    });

    const copy = this.env.MEETING_RECORDING_COPY;
    if (!copy) throw new Error('MEETING_RECORDING_COPY binding is not configured');
    for (const rec of usable) {
      try {
        await copy.create({
          id: `rec-${rec.id}`,
          params: {
            orgId,
            sessionId,
            rtkRecordingId: rec.id,
            startedAt: rec.started_time ?? null,
            stoppedAt: rec.stopped_time ?? null,
            durationSeconds: rec.recording_duration ?? null,
          },
        });
      } catch (err) {
        if (!isDuplicateInstance(err)) throw err;
      }
    }
    await publishSessionUpdated(this.env, db, orgId, session, { recordingStatus: 'processing' });
    return 'queued';
  }
}
