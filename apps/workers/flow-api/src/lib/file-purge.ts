/**
 * When soft-deleted WeldFlow files are due for purging.
 *
 * Deleting a project file or a task attachment only sets `deletedAt`; the daily
 * purge (cron/purge-deleted-files.ts) removes the row and its R2 object once the
 * retention window has passed. That purge must not open tenant databases on a
 * timer to look (ADR DATA-008, AGENTS.md), so the timing lives in the always-on
 * schedule-index D1 (`workspace_due_index`, kind `file_purge`): the delete routes
 * mark their workspace due at the end of the retention window, and the sweep
 * opens only workspaces that are due.
 */

import type { Context } from 'hono';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import type { Env, Variables } from '../types';

/** How long a soft-deleted file stays restorable before it is purged for good. */
export const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** When a file deleted at `deletedAt` has been soft-deleted for the whole retention window. */
export function purgeDueAt(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + RETENTION_DAYS * DAY_MS);
}

/**
 * Tell the purge sweep this workspace has a soft-deleted file coming due. Call
 * after the soft delete. Best-effort and fire-and-forget: it can only pull the
 * workspace's due time earlier, and a D1 hiccup never fails the user's delete.
 */
export function markFilePurgeDue(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  deletedAt: Date = new Date(),
): void {
  if (!c.env.SCHEDULE_INDEX) return;
  c.executionCtx.waitUntil(
    markWorkspaceDue(c.env.SCHEDULE_INDEX, 'file_purge', c.get('workspaceId'), purgeDueAt(deletedAt)),
  );
}
