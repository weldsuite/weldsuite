/**
 * Snooze wake-up sweep — Cloudflare Cron Handler (every 5 minutes).
 *
 * Snoozing only moves a mail out of the inbox; this brings it back once its
 * `snoozedUntil` has passed (`wakeDueSnoozedMessages`: one indexed UPDATE per
 * workspace). The thread listing also wakes due mail for the mailbox being
 * opened, so this sweep matters for the time nobody is looking.
 *
 * It must not open idle tenants to find out (AGENTS.md: "Never periodically
 * wake tenant databases"). Every workspace has a mailbox, so the old
 * walk-every-mailbox loop woke every tenant Neon every tick. Timing now lives
 * in the SCHEDULE_INDEX D1 `workspace_due_index` (kind `mail_snooze`):
 *
 * - The snooze / re-snooze routes mark the workspace due at the snooze time.
 * - Each tick reads only D1, opens the workspaces that are due, wakes their
 *   mail and stores when the next snoozed mail comes due (or drops the row).
 * - A one-time seed (KV flag below) marks every mailbox workspace due once,
 *   so mail snoozed before the index existed is picked up.
 *
 * Only workspace mailboxes are swept. Personal inboxes live in the shared
 * personal database, which is personal-api's.
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import type { Env } from '../types';
import { getMasterDb, getTenantDbForWorkspace, masterSchema } from '@weldsuite/worker-kit/db';
import { runDueIndexSweep, type DueIndexSweepResult } from '@weldsuite/worker-kit/due-index';
import { nextSnoozeDueAt, wakeDueSnoozedMessages } from '@weldsuite/mail-domain/snooze';

/** The cron expression that runs this sweep; keep in step with wrangler.toml. */
export const SNOOZE_SWEEP_CRONS = ['*/5 * * * *'] as const;

export function isSnoozeSweepCron(cron: string): boolean {
  return (SNOOZE_SWEEP_CRONS as readonly string[]).includes(cron);
}

/** KV flag: mailbox workspaces were seeded into the due index. Bump to reseed. */
export const SNOOZE_INDEX_SEED_KEY = 'mail:snooze-index:seed:v1';

/** A workspace that failed (Neon hiccup, broken tenant) is retried after this. */
const RETRY_AFTER_MS = 15 * 60_000;

/** The Clerk org ids of the active workspaces that have at least one mailbox. */
async function listMailWorkspaceOrgIds(env: Env): Promise<string[]> {
  const masterDb = getMasterDb(env);
  const { mailAccountRegistry, workspaces } = masterSchema;
  const rows = await masterDb
    .selectDistinct({ clerkOrgId: workspaces.clerkOrgId })
    .from(mailAccountRegistry)
    .innerJoin(workspaces, eq(mailAccountRegistry.workspaceId, workspaces.id))
    .where(
      and(
        eq(mailAccountRegistry.tenantKind, 'workspace'),
        eq(mailAccountRegistry.isActive, true),
        eq(workspaces.isActive, true),
        isNotNull(workspaces.clerkOrgId),
      ),
    );
  return rows.map((r) => r.clerkOrgId).filter((id): id is string => !!id);
}

export async function runSnoozeSweep(
  env: Env,
  now: Date = new Date(),
): Promise<DueIndexSweepResult & { woken: number }> {
  let woken = 0;
  const result = await runDueIndexSweep({
    d1: env.SCHEDULE_INDEX,
    kv: env.WORKSPACE_CACHE,
    kind: 'mail_snooze',
    label: '[SnoozeSweep]',
    seed: { key: SNOOZE_INDEX_SEED_KEY, listWorkspaces: () => listMailWorkspaceOrgIds(env) },
    retryAfterMs: RETRY_AFTER_MS,
    now: now.getTime(),
    process: async (orgId, at) => {
      const db = await getTenantDbForWorkspace(env, orgId);
      woken += (await wakeDueSnoozedMessages(db, { now: at })).woken;
      return nextSnoozeDueAt(db);
    },
  });

  if (result.due > 0 || result.failed > 0) {
    console.log(
      `[SnoozeSweep] due=${result.due} processed=${result.processed} woken=${woken} failed=${result.failed}`,
    );
  }
  return { ...result, woken };
}
