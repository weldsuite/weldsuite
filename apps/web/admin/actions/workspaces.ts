'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { guardWrite } from '@/lib/auth';
import { getMasterDb, masterSchema } from '@/lib/db';
import {
  getWorkspaceById,
  getWorkspaceNotifyEmails,
  type WorkspaceRow,
} from '@/lib/workspaces-data';
import {
  sendDeletionCancelledEmail,
  sendDeletionScheduledEmail,
} from '@/lib/workspace-deletion-email';

const { workspaces } = masterSchema;

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Reject deletion dates that are in the past or unreasonably soon. */
const MIN_LEAD_MINUTES = 5;

/**
 * Schedule a workspace for deletion. Suspends it immediately (isActive=false)
 * so users are locked out, but retains all data + memberships so the schedule
 * can be cancelled and the workspace fully restored before `deleteAtIso`. The
 * workspace-worker deletion sweep performs the permanent teardown on/after that
 * date. Any admin (non-viewer) may do this.
 */
export async function scheduleWorkspaceDeletion(
  workspaceId: string,
  deleteAtIso: string,
  reason?: string,
): Promise<ActionResult<WorkspaceRow>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };

  const deleteAt = new Date(deleteAtIso);
  if (Number.isNaN(deleteAt.getTime())) {
    return { ok: false, error: 'Invalid deletion date.' };
  }
  if (deleteAt.getTime() < Date.now() + MIN_LEAD_MINUTES * 60_000) {
    return { ok: false, error: `Deletion date must be at least ${MIN_LEAD_MINUTES} minutes in the future.` };
  }

  const existing = await getWorkspaceById(workspaceId);
  if (!existing) return { ok: false, error: 'Workspace not found.' };
  if (existing.deletionState === 'deleted') {
    return { ok: false, error: 'This workspace has already been deleted.' };
  }

  const db = getMasterDb();
  const now = new Date();
  const trimmedReason = reason?.trim() || null;

  await db
    .update(workspaces)
    .set({
      isActive: false,
      scheduledDeletionAt: deleteAt,
      deletionRequestedAt: now,
      deletionRequestedBy: guard.identity.email,
      deletionReason: trimmedReason,
      updatedAt: now,
    })
    .where(eq(workspaces.id, workspaceId));

  // Warn the workspace owners (best-effort — never blocks the action).
  const emails = await getWorkspaceNotifyEmails(workspaceId);
  await sendDeletionScheduledEmail(emails, {
    workspaceName: existing.name,
    deletionAtIso: deleteAt.toISOString(),
    reason: trimmedReason,
  });

  revalidatePath('/workspaces');
  const updated = await getWorkspaceById(workspaceId);
  return { ok: true, data: updated ?? existing };
}

/**
 * Cancel a pending workspace deletion and restore access. Only valid while the
 * workspace has not yet been torn down (no `deletedAt`).
 */
export async function cancelWorkspaceDeletion(
  workspaceId: string,
): Promise<ActionResult<WorkspaceRow>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };

  const existing = await getWorkspaceById(workspaceId);
  if (!existing) return { ok: false, error: 'Workspace not found.' };
  if (existing.deletionState === 'deleted') {
    return { ok: false, error: 'This workspace has already been deleted and cannot be restored here.' };
  }
  if (existing.deletionState !== 'scheduled') {
    return { ok: false, error: 'This workspace is not scheduled for deletion.' };
  }

  const db = getMasterDb();
  await db
    .update(workspaces)
    .set({
      isActive: true,
      scheduledDeletionAt: null,
      trialExpiredAt: null,
      deletionRequestedAt: null,
      deletionRequestedBy: null,
      deletionReason: null,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId));

  const emails = await getWorkspaceNotifyEmails(workspaceId);
  await sendDeletionCancelledEmail(emails, { workspaceName: existing.name });

  revalidatePath('/workspaces');
  const updated = await getWorkspaceById(workspaceId);
  return { ok: true, data: updated ?? existing };
}
