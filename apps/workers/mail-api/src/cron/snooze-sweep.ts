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
 *
 * Mailbox-store mode (design docs/plans/weldmail-mailbox-store-design.md,
 * task D2, "DATA-008"): a due workspace is still only ever the ones the D1
 * index lists — this sweep does not change which workspaces it opens, only
 * how it wakes mail once a workspace's tenant DB is open. `postgres`/`shadow`
 * keep today's single cross-mailbox `wakeDueSnoozedMessages` call, byte-
 * identical. `object`/`object-only` wake each of the workspace's mailboxes
 * through the store's `snooze.wake` op instead (the object's own alarm also
 * wakes it independently — design §3.6 — this sweep is the same belt-and-
 * suspenders D1 index the Postgres path already relies on, not a
 * replacement for the alarm).
 */

import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Env } from '../types';
import { getMasterDb, getTenantDbForWorkspace, getWorkspaceForOrg, masterSchema, schema, type Database } from '@weldsuite/worker-kit/db';
import { runDueIndexSweep, type DueIndexSweepResult } from '@weldsuite/worker-kit/due-index';
import { nextSnoozeDueAt, wakeDueSnoozedMessages } from '@weldsuite/mail-domain/snooze';
import { resolveMailStoreMode } from '@weldsuite/mail-domain/store/mode';
import { getWorkspaceMail, type MailStoreEnv } from '@weldsuite/mail-domain/store';

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

/** Every live mailbox id in the tenant DB — the mailboxes `object`/`object-only` mode wakes one by one. No access scoping: this is a system sweep, not a user request. */
async function liveMailAccountIds(db: Database): Promise<string[]> {
  const rows = await db.select({ id: schema.mailAccounts.id }).from(schema.mailAccounts).where(isNull(schema.mailAccounts.deletedAt));
  return rows.map((r) => r.id);
}

/** `object`/`object-only`: wake each mailbox through the store, returning the total woken and the earliest next-due across all of them. */
async function wakeObjectModeWorkspace(
  env: Env,
  workspaceId: string,
  clerkOrgId: string,
  db: Database,
  at: Date,
  mode: 'object' | 'object-only',
): Promise<{ woken: number; nextDue: Date | null }> {
  const { store } = await getWorkspaceMail(env as unknown as MailStoreEnv, {
    workspaceId,
    clerkOrgId,
    db,
    waitUntil: (p) => {
      p.catch(() => undefined);
    },
    // System sweep, not a user request — a bare workspace-scoped principal
    // (never an admin, never asked to open a specific mailbox: `apply` on a
    // `snooze.wake` op doesn't consult `MailAccess` at all).
    principal: { kind: 'workspace', keyId: 'system:snooze-sweep' },
    mode,
  });
  const accountIds = await liveMailAccountIds(db);
  let woken = 0;
  let nextDue: number | null = null;
  for (const accountId of accountIds) {
    const result = await store.mailbox(accountId).apply({ kind: 'snooze.wake', now: at.getTime() });
    woken += result.applied.length;
    if (result.nextSnoozeDueAt != null) {
      nextDue = nextDue === null ? result.nextSnoozeDueAt : Math.min(nextDue, result.nextSnoozeDueAt);
    }
  }
  return { woken, nextDue: nextDue === null ? null : new Date(nextDue) };
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
      const { id: workspaceId } = await getWorkspaceForOrg(env, orgId);
      const mode = await resolveMailStoreMode(env, workspaceId);
      if (mode === 'postgres' || mode === 'shadow') {
        woken += (await wakeDueSnoozedMessages(db, { now: at })).woken;
        return nextSnoozeDueAt(db);
      }
      const wake = await wakeObjectModeWorkspace(env, workspaceId, orgId, db, at, mode);
      woken += wake.woken;
      return wake.nextDue;
    },
  });

  if (result.due > 0 || result.failed > 0) {
    console.log(
      `[SnoozeSweep] due=${result.due} processed=${result.processed} woken=${woken} failed=${result.failed}`,
    );
  }
  return { ...result, woken };
}
