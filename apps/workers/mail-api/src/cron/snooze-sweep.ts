/**
 * Snooze wake-up sweep — Cloudflare Cron Handler
 *
 * Runs every 5 minutes (wrangler.toml `[triggers]`, scheduled() in
 * src/index.ts). Snoozing only moves a mail out of the inbox; nothing brought
 * it back, so a snoozed mail stayed hidden for good. This walks the
 * workspaces that have a mailbox and wakes every message whose `snoozedUntil`
 * has passed (`wakeDueSnoozedMessages`: one indexed UPDATE per workspace).
 *
 * Only workspace mailboxes are swept. Personal inboxes live in the shared
 * personal database, which is personal-api's.
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import type { Env } from '../types';
import { getMasterDb, getTenantDbForWorkspace, masterSchema } from '@weldsuite/worker-kit/db';
import { wakeDueSnoozedMessages } from '../services/mail/snooze';

/** Must match the `crons` entries in wrangler.toml. */
export const SNOOZE_SWEEP_CRON = '*/5 * * * *';

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
): Promise<{ workspaces: number; woken: number; failed: number }> {
  const orgIds = await listMailWorkspaceOrgIds(env);

  let woken = 0;
  let failed = 0;
  for (const orgId of orgIds) {
    try {
      const db = await getTenantDbForWorkspace(env, orgId);
      const result = await wakeDueSnoozedMessages(db, { now });
      woken += result.woken;
    } catch (err) {
      // One broken tenant must not keep everyone else's mail snoozed.
      failed++;
      console.error(`[SnoozeSweep] Workspace ${orgId} failed:`, err instanceof Error ? err.message : err);
    }
  }

  if (woken > 0 || failed > 0) {
    console.log(`[SnoozeSweep] workspaces=${orgIds.length} woken=${woken} failed=${failed}`);
  }
  return { workspaces: orgIds.length, woken, failed };
}
