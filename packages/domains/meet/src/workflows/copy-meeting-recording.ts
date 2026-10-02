/**
 * CopyMeetingRecordingWorkflow — Cloudflare Workflow
 *
 * RealtimeKit keeps a recording on its own bucket for about 7 days behind an
 * expiring URL. When `recording.statusUpdate` reports UPLOADED, this copies the
 * video (and the audio-only export) into WeldSuite's private
 * `MEETING_RECORDINGS` bucket and flips the session's recording to `ready`.
 *
 * Why a Workflow: the files are hundreds of MB and `waitUntil` is capped at
 * 30 s, so the copy must not run in the webhook request. Each file is its own
 * retried step; every attempt resolves a FRESH download URL first, because the
 * one from the webhook may have expired by the time a retry runs.
 *
 * Instance id: `rec-{rtkRecordingId}` (the webhook swallows "already exists",
 * so a redelivered UPLOADED never starts a second copy).
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getRecording } from '@weldsuite/cloudflare-realtime';
import { getTenantDbForWorkspace } from '@weldsuite/worker-kit/db';
import { recordingsBucket, type MeetDomainEnv } from '../env';
import { copyResponseToR2 } from '../r2-copy';
import {
  contentTypeForExtension,
  extensionOf,
  loadSession,
  patchSession,
  publishSessionUpdated,
  recordingObjectKey,
  recordingPatchFromParts,
  upsertRecordingPart,
  type RecordingPart,
} from '../recordings';

export interface CopyMeetingRecordingParams {
  /** Clerk org id (the tenant key). */
  orgId: string;
  sessionId: string;
  rtkRecordingId: string;
  startedAt?: string | null;
  stoppedAt?: string | null;
  durationSeconds?: number | null;
}

interface CopiedFile {
  key: string;
  size: number;
}

interface CopiedVideo extends CopiedFile {
  durationSeconds: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
}

const COPY_RETRIES = { limit: 5, delay: '30 seconds', backoff: 'exponential' } as const;
const FINALIZE_RETRIES = { limit: 3, delay: '5 seconds', backoff: 'exponential' } as const;

export class CopyMeetingRecordingWorkflow extends WorkflowEntrypoint<
  MeetDomainEnv,
  CopyMeetingRecordingParams
> {
  async run(event: WorkflowEvent<CopyMeetingRecordingParams>, step: WorkflowStep) {
    const p = event.payload;
    try {
      const video = await step.do(
        'copy-video',
        { retries: COPY_RETRIES, timeout: '30 minutes' },
        async (): Promise<CopiedVideo> => {
          const rec = await getRecording(this.env, p.rtkRecordingId);
          if (!rec.download_url) throw new Error('RealtimeKit recording has no download URL yet');
          const ext = extensionOf(rec.output_file_name ?? rec.download_url, 'mp4');
          const key = recordingObjectKey(p.orgId, p.sessionId, p.rtkRecordingId, ext);
          const res = await fetch(rec.download_url);
          const size = await copyResponseToR2(
            recordingsBucket(this.env),
            key,
            res,
            contentTypeForExtension(ext),
          );
          return {
            key,
            size,
            durationSeconds: rec.recording_duration ?? p.durationSeconds ?? null,
            startedAt: rec.started_time ?? p.startedAt ?? null,
            stoppedAt: rec.stopped_time ?? p.stoppedAt ?? null,
          };
        },
      );

      const audio = await step.do(
        'copy-audio',
        { retries: COPY_RETRIES, timeout: '30 minutes' },
        async (): Promise<CopiedFile | null> => {
          const rec = await getRecording(this.env, p.rtkRecordingId);
          // No audio export (a meeting created before it was enabled): fine.
          if (!rec.audio_download_url) return null;
          const ext = extensionOf(rec.audio_download_url, 'mp3');
          const key = recordingObjectKey(p.orgId, p.sessionId, p.rtkRecordingId, ext);
          const res = await fetch(rec.audio_download_url);
          const size = await copyResponseToR2(
            recordingsBucket(this.env),
            key,
            res,
            contentTypeForExtension(ext),
          );
          return { key, size };
        },
      );

      await step.do('finalize', { retries: FINALIZE_RETRIES }, async () => {
        const db = await getTenantDbForWorkspace(this.env, p.orgId);
        const session = await loadSession(db, p.sessionId);
        if (!session) return;
        const part: RecordingPart = {
          rtkRecordingId: p.rtkRecordingId,
          videoKey: video.key,
          audioKey: audio?.key ?? null,
          sizeBytes: video.size,
          durationSeconds: video.durationSeconds,
          startedAt: video.startedAt,
          stoppedAt: video.stoppedAt,
          status: 'ready',
        };
        const parts = upsertRecordingPart(session.recordingParts, part);
        await patchSession(db, p.sessionId, { ...recordingPatchFromParts(parts), recordingError: null });
        await publishSessionUpdated(this.env, db, p.orgId, session, {
          recordingStatus: 'ready',
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[CopyMeetingRecording] ${p.rtkRecordingId} failed: ${message}`);
      await this.markFailed(p, message);
      throw error;
    }
  }

  /** Record the failure on the session so the UI shows "failed" instead of "processing" forever. */
  private async markFailed(p: CopyMeetingRecordingParams, message: string): Promise<void> {
    try {
      const db = await getTenantDbForWorkspace(this.env, p.orgId);
      const session = await loadSession(db, p.sessionId);
      if (!session) return;
      const parts = upsertRecordingPart(session.recordingParts, {
        rtkRecordingId: p.rtkRecordingId,
        videoKey: null,
        audioKey: null,
        sizeBytes: null,
        durationSeconds: p.durationSeconds ?? null,
        startedAt: p.startedAt ?? null,
        stoppedAt: p.stoppedAt ?? null,
        status: 'failed',
      });
      await patchSession(db, p.sessionId, {
        ...recordingPatchFromParts(parts),
        recordingError: message.slice(0, 1000),
      });
      await publishSessionUpdated(this.env, db, p.orgId, session, { recordingStatus: 'failed' });
    } catch (updateError) {
      console.error(
        `[CopyMeetingRecording] could not record failure: ${
          updateError instanceof Error ? updateError.message : String(updateError)
        }`,
      );
    }
  }
}
