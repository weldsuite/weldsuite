/**
 * TrashCleanupWorkflow — Cloudflare Workflow
 *
 * Sleeps until 30 days after a file was trashed, then permanently deletes
 * the file from both R2 storage and the database.
 *
 * Guard: if the file was restored (or re-trashed with a different timestamp),
 * the workflow exits without action.
 *
 * Ported from apps/api-worker/src/workflows/trash-cleanup.ts (W4 legacy-worker
 * phase-out). Hosted in app-api under the NEW workflow names
 * `trash-cleanup-v2[-dev/-test/-preview]` — the old names stay owned by
 * api-worker while its in-flight instances (up to 30-day sleeps) drain.
 * Bound as TRASH_CLEANUP; the dispatch site in routes/files is unchanged.
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import type { Env } from '../types';
import { getTenantDbForWorkspace, schema } from '@weldsuite/worker-kit/db';
import { deleteStoredObjects } from '@weldsuite/worker-kit/storage';
import { listDocumentSnapshotKeys } from '@weldsuite/core-domain/files';

export interface TrashCleanupParams {
  workspaceId: string;
  fileId: string;
  fileKey: string;
  deletedAt: string; // ISO string — the exact timestamp when the file was trashed
  purgeAt: string; // ISO string — deletedAt + 30 days
}

export class TrashCleanupWorkflow extends WorkflowEntrypoint<Env, TrashCleanupParams> {
  async run(event: WorkflowEvent<TrashCleanupParams>, step: WorkflowStep) {
    const { workspaceId, fileId, fileKey, deletedAt, purgeAt } = event.payload;

    // Sleep until 30 days after the file was trashed
    await step.sleepUntil('wait-until-purge', new Date(purgeAt));

    // Delete with retries — guard prevents acting on restored or re-trashed files
    await step.do('delete-file', {
      retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
    }, async () => {
      const db = await getTenantDbForWorkspace(this.env, workspaceId);
      const { files } = schema;

      const [file] = await db
        .select({ id: files.id, deletedAt: files.deletedAt })
        .from(files)
        .where(eq(files.id, fileId))
        .limit(1);

      if (!file) {
        console.log(`[TrashCleanup] File ${fileId} not found (already deleted), skipping`);
        return;
      }

      // Guard: only delete if deletedAt matches the one from when this workflow was created.
      // If the file was restored (deletedAt = null) or re-trashed (different timestamp),
      // a newer workflow handles it.
      if (!file.deletedAt || file.deletedAt.toISOString() !== deletedAt) {
        console.log(`[TrashCleanup] File ${fileId} was restored or re-trashed, skipping`);
        return;
      }

      // Delete from R2 (whichever bucket holds it; both are optional in Env): the
      // file, and the snapshots of the spreadsheet or document backed by it. They
      // are listed while their rows still exist, and deleted before the rows so a
      // retry of this step finds them again.
      const keys = [...(fileKey ? [fileKey] : []), ...(await listDocumentSnapshotKeys(db, [fileId]))];
      await deleteStoredObjects(this.env, keys).catch((err) => {
        console.error(`[TrashCleanup] Failed to delete R2 objects for ${fileId}:`, err);
      });

      // Delete from database (a spreadsheet's or WeldDocs document's row references its file)
      await db.delete(schema.sheets).where(eq(schema.sheets.fileId, fileId));
      await db.delete(schema.documentVersions).where(eq(schema.documentVersions.fileId, fileId));
      await db.delete(schema.docs).where(eq(schema.docs.fileId, fileId));
      await db.delete(files).where(eq(files.id, fileId));

      console.log(`[TrashCleanup] Permanently deleted file ${fileId} (R2: ${fileKey})`);
    });
  }
}
