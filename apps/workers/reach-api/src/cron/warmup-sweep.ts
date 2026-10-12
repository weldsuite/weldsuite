/**
 * Warmup progress sweep: due-index kind `reach_warmup`, run by the daily cron.
 *
 * Mailpool warms the mailboxes; this reads how far they are and moves them
 * along (`provisioning` -> `warming` -> `active`), grows the daily cap of
 * active mailboxes, and pauses mailboxes whose WeldHost domain lapsed. The
 * per-workspace logic is `processWorkspaceWarmup` (services/warmup.ts).
 *
 * It must not open idle tenants (AGENTS.md: "Never periodically wake tenant
 * databases"), so it visits only workspaces the D1 `workspace_due_index` lists:
 * a mailbox create marks the workspace due, and each visit stores when the
 * workspace next needs one (tomorrow while anything is warming or ramping, the
 * earliest domain expiry otherwise, or nothing).
 */

import { publishEntityEventRaw } from '@weldsuite/entity-events';
import type { Database } from '@weldsuite/worker-kit';
import { runDueIndexSweep, type DueIndexSweepResult } from '@weldsuite/worker-kit/due-index';
import { readReachAccess, openTenantDb } from '../lib/tenant';
import { createMailpoolClient, type MailpoolClient } from '../lib/mailpool/client';
import { MailpoolNotConfiguredError } from '../lib/mailpool/errors';
import { utcTomorrow } from '../services/access';
import { cachedWarmupLookup, processWorkspaceWarmup } from '../services/warmup';
import type { Env } from '../types';
import type { AppAccess } from '@weldsuite/worker-kit/app-access';

/** KV flag for the one-time seed. Nothing existed before WeldReach, so the seed is empty. */
export const WARMUP_INDEX_SEED_KEY = 'reach:warmup-index:seed:v1';

/** A workspace that failed (Mailpool or Neon trouble) is retried after this. */
const RETRY_AFTER_MS = 6 * 3_600_000;

/**
 * Workspaces per run. Every mailbox costs a handful of Mailpool and database
 * subrequests and one invocation allows ~1000; the rest stay due for the next tick.
 */
export const MAX_WORKSPACES_PER_RUN = 40;

export interface WarmupSweepDeps {
  mailpool?: MailpoolClient;
  openTenant?: (env: Env, clerkOrgId: string) => Promise<Database>;
  readAccess?: (env: Env, clerkOrgId: string) => Promise<AppAccess>;
  now?: Date;
}

export async function runWarmupSweep(env: Env, deps: WarmupSweepDeps = {}): Promise<DueIndexSweepResult> {
  let mailpool: MailpoolClient;
  try {
    mailpool = deps.mailpool ?? createMailpoolClient(env);
  } catch (err) {
    if (err instanceof MailpoolNotConfiguredError) {
      console.warn('[ReachWarmupSweep] MAILPOOL_API_KEY is not set; skipping');
      return { due: 0, processed: 0, failed: 0, seeded: 0 };
    }
    throw err;
  }

  const openTenant = deps.openTenant ?? openTenantDb;
  const readAccess = deps.readAccess ?? readReachAccess;
  // One warmup list per run, shared by every workspace.
  const lookup = cachedWarmupLookup(mailpool);
  let visited = 0;

  const result = await runDueIndexSweep({
    d1: env.SCHEDULE_INDEX,
    kv: env.WORKSPACE_CACHE,
    kind: 'reach_warmup',
    label: '[ReachWarmupSweep]',
    seed: { key: WARMUP_INDEX_SEED_KEY, listWorkspaces: async () => [] },
    retryAfterMs: RETRY_AFTER_MS,
    now: deps.now?.getTime(),
    shouldStop: () => visited >= MAX_WORKSPACES_PER_RUN,
    process: async (clerkOrgId, at) => {
      visited += 1;

      // Master read only: a workspace that lost access costs no tenant wake-up.
      const access = await readAccess(env, clerkOrgId);
      if (access.status === 'suspended') return utcTomorrow(at); // may come back
      if (access.status !== 'approved') return null;

      const db = await openTenant(env, clerkOrgId);
      return processWorkspaceWarmup({
        db,
        mailpool,
        lookup,
        env,
        now: at,
        publish: ({ entityId, data }) =>
          publishEntityEventRaw({
            env,
            workspaceId: clerkOrgId,
            userId: 'system',
            entityType: 'reach_mailbox',
            action: 'updated',
            entityId,
            data,
            source: 'system',
          }),
      });
    },
  });

  if (result.due > 0 || result.failed > 0) {
    console.log(`[ReachWarmupSweep] due=${result.due} processed=${result.processed} failed=${result.failed}`);
  }
  return result;
}
