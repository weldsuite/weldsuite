'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { guardWrite } from '@/lib/auth';
import { recordConsoleAudit } from '@/lib/audit';
import { getMasterDb, masterSchema } from '@/lib/db';
import {
  STAFF_PAUSE_REASON,
  canPause,
  canResume,
  isPoolStatus,
  unpausedStatus,
  type PoolStatus,
} from '@/lib/warmup-network';
import type { ActionResult } from './workspaces';

const pool = masterSchema.reachWarmupMailboxes;

/**
 * Staff pause and resume of one mailbox's warmup in the WeldReach network.
 * Every action: `guardWrite()` (no read-only viewers), a guarded update of the
 * master `reach_warmup_mailboxes` row, an audit row against the mailbox's
 * workspace, and a revalidate of the screen.
 *
 * Only `status`, `paused_reason` and `updated_at` are written; the sealed
 * logins are never read or touched. The warmup worker stops planning and
 * engaging for a paused mailbox on its next run.
 */

export interface WarmupMailboxActionData {
  id: string;
  status: PoolStatus;
}

const NOT_FOUND = 'This mailbox is not in the warmup network.';
const CONFLICT = 'Someone else just changed this mailbox. Reload the page and try again.';

function isText(value: unknown): value is string {
  return typeof value === 'string';
}

async function loadMailbox(mailboxId: string) {
  const [row] = await getMasterDb()
    .select({
      id: pool.id,
      workspaceId: pool.workspaceId,
      email: pool.email,
      status: pool.status,
      startedAt: pool.startedAt,
      rampDay: pool.rampDay,
    })
    .from(pool)
    .where(eq(pool.id, mailboxId))
    .limit(1);
  return row ?? null;
}

type Change = { action: 'pause' | 'resume'; mailboxId: string; reason: string };

async function changeWarmup({ action, mailboxId, reason }: Change): Promise<ActionResult<WarmupMailboxActionData>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  if (!isText(mailboxId) || !isText(reason) || mailboxId.length === 0 || mailboxId.length > 30) {
    return { ok: false, error: 'Invalid request.' };
  }
  if (reason.trim().length < 3) return { ok: false, error: 'Give a reason of at least 3 characters.' };

  const row = await loadMailbox(mailboxId);
  if (!row || !isPoolStatus(row.status) || row.status === 'removed') return { ok: false, error: NOT_FOUND };

  const from = row.status;
  if (action === 'pause' && !canPause(from)) return { ok: false, error: `A mailbox that is ${from} cannot be paused.` };
  if (action === 'resume' && !canResume(from)) return { ok: false, error: `Only a paused mailbox can be resumed (this one is ${from}).` };

  const to: PoolStatus = action === 'pause' ? 'paused' : unpausedStatus(row);
  const set =
    action === 'pause'
      ? { status: to, pausedReason: STAFF_PAUSE_REASON, updatedAt: new Date() }
      : { status: to, pausedReason: null, updatedAt: new Date() };

  // Guarded on the status we planned from, so two staff (or the worker) cannot both win.
  const updated = await getMasterDb()
    .update(pool)
    .set(set)
    .where(and(eq(pool.id, row.id), eq(pool.status, from)))
    .returning({ id: pool.id });
  if (updated.length === 0) return { ok: false, error: CONFLICT };

  await recordConsoleAudit({
    identity: guard.identity,
    workspaceId: row.workspaceId,
    action: `reach_warmup.${action}`,
    outcome: 'success',
    reason: reason.trim(),
    details: { mailboxId: row.id, email: row.email, from, to },
  });

  revalidatePath('/warmup');
  return { ok: true, data: { id: row.id, status: to } };
}

/** Stop a mailbox's warmup: it neither sends nor receives warmup mail until resumed. The reason is kept in the activity log. */
export async function pauseWarmupMailbox(mailboxId: string, reason: string) {
  return changeWarmup({ action: 'pause', mailboxId, reason });
}

/** Let a paused mailbox's warmup carry on where it had got to. */
export async function resumeWarmupMailbox(mailboxId: string, reason: string) {
  return changeWarmup({ action: 'resume', mailboxId, reason });
}
