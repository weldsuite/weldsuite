/**
 * Weekly project finance snapshot, a Cloudflare cron handler (FLOW-019).
 *
 * The S-curve of a project must survive later corrections in WeldBooks,
 * WeldStash and WeldHR, so once a week each project that has a baseline gets one
 * row in `project_finance_snapshots` (planned value, earned value, actual cost,
 * committed, forecast), one per ISO week: running again in the same week
 * replaces that week's row.
 *
 * Scheduling follows ADR DATA-008 (nothing opens tenant databases on a timer):
 * the daily cron (the same one that purges files) reads the schedule-index D1
 * (`workspace_due_index`, kind `finance_snapshot`), opens just the workspaces
 * that are due, snapshots their projects and stores Monday 00:00 UTC of the next
 * week as the next due time, or drops the row when no project has a baseline
 * (then `markFinanceSnapshotDue` brings it back when a baseline is set). A
 * one-time, KV-guarded seed marks every active workspace due once.
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import type { Context } from 'hono';
import type { Database } from '@weldsuite/worker-kit/db';
import { getMasterDb, getTenantDbForWorkspace, masterSchema } from '@weldsuite/worker-kit/db';
import { markWorkspaceDue, runDueIndexSweep, type DueIndexSweepResult } from '@weldsuite/worker-kit/due-index';
import { nextWeekStartMs } from '@weldsuite/flow-domain/finance';
import type { Env, Variables } from '../types';
import { computeFinance, projectsToSnapshot, upsertSnapshot } from '../services/project-finance';
import { FILE_PURGE_CRONS } from './purge-deleted-files';

/** Runs on the daily cron, with the file purge. */
export const FINANCE_SNAPSHOT_CRONS = FILE_PURGE_CRONS;

export function isFinanceSnapshotCron(cron: string): boolean {
  return (FINANCE_SNAPSHOT_CRONS as readonly string[]).includes(cron);
}

/** KV flag: active workspaces were seeded into the due index. Bump to reseed. */
export const FINANCE_SNAPSHOT_SEED_KEY = 'flow:finance-snapshot-index:seed:v1';

/** A workspace that failed is retried after this. */
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Snapshot every project of one workspace that has a baseline. Returns how many
 * were written and when the workspace is next due (null: no project qualifies).
 */
export async function snapshotWorkspace(db: Database, now: Date): Promise<{ written: number; next: Date | null }> {
  const projects = await projectsToSnapshot(db);
  let written = 0;
  for (const project of projects) {
    try {
      await upsertSnapshot(db, project, await computeFinance(db, project, now), now);
      written += 1;
    } catch (err) {
      // One broken project must not stop the others; the next week measures it again.
      console.error(`[FinanceSnapshot] project ${project.id} failed:`, err);
    }
  }
  return { written, next: projects.length > 0 ? new Date(nextWeekStartMs(now.getTime())) : null };
}

/**
 * Tell the sweep this workspace has a project with a baseline now. Call after a
 * baseline is set. Best-effort and fire-and-forget; it can only pull the
 * workspace's due time earlier.
 */
export function markFinanceSnapshotDue(c: Context<{ Bindings: Env; Variables: Variables }>): void {
  if (!c.env.SCHEDULE_INDEX) return;
  c.executionCtx.waitUntil(markWorkspaceDue(c.env.SCHEDULE_INDEX, 'finance_snapshot', c.get('clerkOrgId')));
}

async function listActiveWorkspaceOrgIds(env: Env): Promise<string[]> {
  const rows = await getMasterDb(env)
    .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
    .from(masterSchema.workspaces)
    .where(and(eq(masterSchema.workspaces.isActive, true), isNotNull(masterSchema.workspaces.clerkOrgId)));
  return rows.map((r) => r.clerkOrgId).filter((id): id is string => !!id);
}

/** Daily tick: opens only the workspaces the `finance_snapshot` due index lists as due. */
export async function runFinanceSnapshots(
  env: Env,
  now: Date = new Date(),
): Promise<DueIndexSweepResult & { snapshots: number }> {
  let snapshots = 0;
  const result = await runDueIndexSweep({
    d1: env.SCHEDULE_INDEX,
    kv: env.WORKSPACE_CACHE,
    kind: 'finance_snapshot',
    label: '[FinanceSnapshot]',
    seed: { key: FINANCE_SNAPSHOT_SEED_KEY, listWorkspaces: () => listActiveWorkspaceOrgIds(env) },
    retryAfterMs: RETRY_AFTER_MS,
    now: now.getTime(),
    process: async (orgId) => {
      const db = (await getTenantDbForWorkspace(env, orgId)) as unknown as Database;
      const done = await snapshotWorkspace(db, now);
      snapshots += done.written;
      return done.next;
    },
  });
  if (result.due > 0 || result.failed > 0) {
    console.log(`[FinanceSnapshot] due=${result.due} processed=${result.processed} failed=${result.failed}: ${snapshots} snapshots`);
  }
  return { ...result, snapshots };
}
