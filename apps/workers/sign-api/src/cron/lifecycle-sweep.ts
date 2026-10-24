/**
 * WeldSign lifecycle sweep — Cloudflare Cron Handler (every 15 minutes).
 *
 * Sends the automatic reminders that are due and closes open requests whose
 * expiry has passed (status `expired`, every link revoked, the sender told).
 *
 * It never wakes idle tenant DBs (DATA-008): timing lives in the
 * SCHEDULE_INDEX D1 `workspace_due_index` (kind `sign_lifecycle`). Sending a
 * request, emailing the next signing group and correcting a signer's email
 * re-derive a workspace's next due time (services/schedule.ts); each tick
 * reads only D1, opens the workspaces that are due, does their work and
 * stores when they are next due (or drops the row). A one-time seed marks
 * every workspace with a live signing link due once, from the master link
 * registry, so requests sent before the index existed are picked up.
 */

import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { getMasterDb, getTenantDbForWorkspace, getWorkspaceForOrg } from '@weldsuite/worker-kit/db';
import { runDueIndexSweep, type DueIndexSweepResult } from '@weldsuite/worker-kit/due-index';
import type { Env } from '../types';
import { expireDue, sendDueReminders } from '../services/lifecycle';
import { workspacesWithLiveLinks } from '../services/links';
import { nextLifecycleDueAt } from '../services/schedule';

/** The cron expression that runs this sweep; keep in step with wrangler.toml. */
export const LIFECYCLE_SWEEP_CRONS = ['*/15 * * * *'] as const;

export function isLifecycleSweepCron(cron: string): boolean {
  return (LIFECYCLE_SWEEP_CRONS as readonly string[]).includes(cron);
}

/** KV flag: workspaces with live links were seeded into the due index. Bump to reseed. */
export const LIFECYCLE_INDEX_SEED_KEY = 'sign:lifecycle-index:seed:v1';

/** A workspace that failed (Neon hiccup, broken tenant) is retried after this. */
const RETRY_AFTER_MS = 30 * 60_000;

export async function runLifecycleSweep(
  env: Env,
  now: Date = new Date(),
): Promise<DueIndexSweepResult & { reminded: number; expired: number }> {
  let reminded = 0;
  let expired = 0;
  const master = getMasterDb(env);
  const result = await runDueIndexSweep({
    d1: env.SCHEDULE_INDEX,
    kv: env.WORKSPACE_CACHE,
    kind: 'sign_lifecycle',
    label: '[SignLifecycle]',
    seed: { key: LIFECYCLE_INDEX_SEED_KEY, listWorkspaces: () => workspacesWithLiveLinks(master) },
    retryAfterMs: RETRY_AFTER_MS,
    now: now.getTime(),
    process: async (orgId, at) => {
      const [db, workspace] = await Promise.all([getTenantDbForWorkspace(env, orgId), getWorkspaceForOrg(env, orgId)]);
      const ctx = { env, db, master, clerkOrgId: orgId, workspaceId: workspace.id };
      const closed = await expireDue(ctx, at);
      expired += closed.length;
      reminded += await sendDueReminders(ctx, at);
      await Promise.all(
        closed.map((envelope) =>
          publishEntityEventRaw({
            env,
            workspaceId: orgId,
            userId: 'system',
            entityType: 'sign_envelope',
            action: 'expired',
            entityId: envelope.id,
            data: { id: envelope.id, title: envelope.title, status: envelope.status, senderUserId: envelope.senderUserId },
          }),
        ),
      );
      return nextLifecycleDueAt(db);
    },
  });

  if (result.due > 0 || result.failed > 0) {
    console.log(
      `[SignLifecycle] due=${result.due} processed=${result.processed} reminded=${reminded} expired=${expired} failed=${result.failed}`,
    );
  }
  return { ...result, reminded, expired };
}
