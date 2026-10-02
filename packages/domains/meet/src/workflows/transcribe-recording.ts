/**
 * TranscribeRecordingWorkflow — RETIRED STUB (delete after one release).
 *
 * This used to transcribe meeting recordings with AssemblyAI. WeldMeet now
 * transcribes through RealtimeKit's own post-meeting transcript or Whisper over
 * the stored recording (MeetingAiWorkflow), and AssemblyAI is gone.
 *
 * Why a class still exists: Cloudflare keeps the registered workflow
 * `transcribe-recording-v3[-dev|-test]` pointing at this export. Deleting the
 * export while the registration is alive risks a failed deploy, and an
 * in-flight instance would crash opaquely. So the class stays for one release
 * and does the one harmless thing: mark the transcription it was given as
 * failed with an actionable message. It has no AssemblyAI code, no secrets and
 * no wrangler binding any more.
 *
 * Removal checklist (next release): drop this file, its export in
 * meet-api/src/index.ts and the `./workflows/transcribe-recording` entry in
 * this package's exports, then delete the workflow registration with
 * `wrangler workflows delete transcribe-recording-v3[-test|-dev]`.
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import type { DbEnv } from '@weldsuite/worker-kit/env';
import { getTenantDbForWorkspace, schema } from '@weldsuite/worker-kit/db';

export interface TranscribeRecordingParams {
  transcriptionId: string;
  workspaceId: string;
  [key: string]: unknown;
}

export class TranscribeRecordingWorkflow extends WorkflowEntrypoint<DbEnv, TranscribeRecordingParams> {
  async run(event: WorkflowEvent<TranscribeRecordingParams>, step: WorkflowStep) {
    const { transcriptionId, workspaceId } = event.payload;
    await step.do('mark-retired', { retries: { limit: 2, delay: '5 seconds' } }, async () => {
      const db = await getTenantDbForWorkspace(this.env, workspaceId);
      await db
        .update(schema.crmTranscriptions)
        .set({
          status: 'failed',
          errorMessage: 'This transcription service was retired. Open the meeting and run Transcribe again.',
          updatedAt: new Date(),
        })
        .where(eq(schema.crmTranscriptions.id, transcriptionId));
    });
  }
}
