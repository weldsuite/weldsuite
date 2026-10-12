/**
 * The send sweep: every minute, hand the workspaces that have outreach due to
 * the `reach-send` queue.
 *
 * AGENTS.md: never wake tenant databases on a timer. This sweep reads only the
 * D1 due index (`workspace_due_index`, kind `reach_send`) and writes only to
 * the queue; the tenant DB is opened by the queue consumer, and only for
 * workspaces that are due. The sweep stores a provisional next due time
 * (a safety net if the consumer never runs); the consumer replaces it with the
 * real one when it has looked at the workspace (`settleSendDue`).
 *
 * Write paths (launch, resume, enrolling into a running campaign) call
 * `markWorkspaceDue(env.SCHEDULE_INDEX, 'reach_send', orgId, at)` to pull a
 * workspace's due time forward.
 */

import {
  markWorkspaceDue,
  runDueIndexSweep,
  settleWorkspaceDue,
  type DueIndexRow,
  type DueIndexSweepResult,
} from '@weldsuite/worker-kit/due-index';
import type { Env } from '../types';

export const SEND_DUE_KIND = 'reach_send' as const;
/** KV flag for the one-time seed. Nothing to seed: no workspace has outreach before the index exists. */
export const SEND_INDEX_SEED_KEY = 'reach:send-index:seed:v1';
/** Due time stored when a workspace is enqueued, until its consumer reports the real one. */
export const PROVISIONAL_NEXT_DUE_MS = 10 * 60_000;
/** Back-off for a workspace the sweep could not enqueue. */
const ENQUEUE_RETRY_MS = 2 * 60_000;
const SWEEP_LIMIT = 200;

export async function runSendSweep(env: Env, now: Date = new Date()): Promise<DueIndexSweepResult> {
  const queue = env.REACH_SEND_QUEUE;
  if (!queue) {
    console.warn('[ReachSendSweep] REACH_SEND_QUEUE binding missing; skipping sweep');
    return { due: 0, processed: 0, failed: 0, seeded: 0 };
  }

  const result = await runDueIndexSweep({
    d1: env.SCHEDULE_INDEX,
    kv: env.WORKSPACE_CACHE,
    kind: SEND_DUE_KIND,
    label: '[ReachSendSweep]',
    seed: { key: SEND_INDEX_SEED_KEY, listWorkspaces: async () => [] },
    retryAfterMs: ENQUEUE_RETRY_MS,
    limit: SWEEP_LIMIT,
    now: now.getTime(),
    process: async (clerkOrgId) => {
      await queue.send({ clerkOrgId, enqueuedAt: now.getTime() });
      return new Date(now.getTime() + PROVISIONAL_NEXT_DUE_MS);
    },
  });

  if (result.due > 0 || result.failed > 0) {
    console.log(`[ReachSendSweep] due=${result.due} enqueued=${result.processed} failed=${result.failed}`);
  }
  return result;
}

/** The due row as it is right now (read BEFORE the tenant is looked at, so a write during the tick is not lost). */
export async function readSendDueRow(d1: D1Database | undefined, clerkOrgId: string): Promise<DueIndexRow | null> {
  if (!d1) return null;
  try {
    const row = await d1
      .prepare('SELECT next_due_at, version FROM workspace_due_index WHERE kind = ? AND workspace_id = ?')
      .bind(SEND_DUE_KIND, clerkOrgId)
      .first<{ next_due_at: number; version: number }>();
    return row ? { workspaceId: clerkOrgId, nextDueAt: row.next_due_at, version: row.version } : null;
  } catch (err) {
    console.warn(`[ReachSendSweep] could not read the due row of ${clerkOrgId}:`, err);
    return null;
  }
}

/**
 * Store when the workspace next has outreach due (`null`: nothing left, drop
 * the row). Only replaces the row if no write path touched it since `row` was
 * read; otherwise the row is left (it is due earlier) and, as a safeguard, the
 * time is marked with the pull-forward-only `markWorkspaceDue`.
 */
export async function settleSendDue(
  d1: D1Database | undefined,
  clerkOrgId: string,
  row: DueIndexRow | null,
  next: Date | null,
): Promise<void> {
  if (!d1) return;
  try {
    if (row && (await settleWorkspaceDue(d1, SEND_DUE_KIND, row, next))) return;
  } catch (err) {
    console.warn(`[ReachSendSweep] could not settle ${clerkOrgId}:`, err);
  }
  if (next) await markWorkspaceDue(d1, SEND_DUE_KIND, clerkOrgId, next);
}
