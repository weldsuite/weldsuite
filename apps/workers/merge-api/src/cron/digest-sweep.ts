/**
 * The WeldChat daily digest, run by the hourly cron in wrangler.toml.
 *
 * It never wakes idle tenant databases (ADR DATA-008): timing lives in the
 * SCHEDULE_INDEX D1 `workspace_due_index` (kind `merge_digest`, via
 * `@weldsuite/worker-kit/due-index`, keyed by the Clerk org id like the other
 * kinds). Creating or changing a chat subscription with `daily_digest` marks the
 * workspace due at its next `digest_hour`; each tick reads only D1, opens the
 * workspaces that are due, posts the digests whose hour it is and re-arms the
 * workspace for the next hour any of its digests is due (or drops the row).
 *
 * No seed: the index is introduced with the feature, so no workspace has a
 * subscription before its first mark.
 */

import { getTenantDbForWorkspace, getWorkspaceForOrg } from '@weldsuite/worker-kit/db';
import { runDueIndexSweep, type DueIndexSweepResult } from '@weldsuite/worker-kit/due-index';
import type { Env } from '../types';
import { buildDigest } from '../services/chat/digest';
import { postCard } from '../services/chat/post';
import { digestSubscriptions, nextDigestAt } from '../services/chat/subscriptions';

/** The cron expression that runs this sweep; keep in step with wrangler.toml. */
export const DIGEST_SWEEP_CRONS = ['0 * * * *'] as const;

export function isDigestSweepCron(cron: string): boolean {
  return (DIGEST_SWEEP_CRONS as readonly string[]).includes(cron);
}

/** KV flag: the (empty) one-time seed ran. */
export const DIGEST_INDEX_SEED_KEY = 'merge:digest-index:seed:v1';

/** A workspace that failed (Neon hiccup, broken tenant) is retried after this. */
const RETRY_AFTER_MS = 15 * 60_000;

/** Posts the digests due at `now` for one workspace; returns when it is next due (null: no digests left). */
async function processWorkspace(env: Env, clerkOrgId: string, now: Date): Promise<Date | null> {
  const db = await getTenantDbForWorkspace(env, clerkOrgId);
  const { id: workspaceId } = await getWorkspaceForOrg(env, clerkOrgId);
  const subscriptions = await digestSubscriptions(db);
  const ctx = { db, env, userId: 'system', workspaceId, clerkOrgId };

  let next: Date | null = null;
  for (const sub of subscriptions) {
    if (sub.digestHour === now.getUTCHours()) {
      try {
        const digest = await buildDigest(db, sub, now);
        if (!digest.empty) await postCard(ctx, sub.channelId, digest.content, { kind: 'daily_digest' });
      } catch (err) {
        // Not retried: a retry would post the other subscriptions' digests twice.
        console.error(`[MergeDigest] subscription ${sub.id} failed:`, err);
      }
    }
    const at = nextDigestAt(sub.digestHour, now);
    if (next === null || at.getTime() < next.getTime()) next = at;
  }
  return next;
}

export async function runDigestSweep(env: Env, now: Date = new Date()): Promise<DueIndexSweepResult> {
  return runDueIndexSweep({
    d1: env.SCHEDULE_INDEX,
    kv: env.WORKSPACE_CACHE,
    kind: 'merge_digest',
    label: '[MergeDigest]',
    seed: { key: DIGEST_INDEX_SEED_KEY, listWorkspaces: async () => [] },
    retryAfterMs: RETRY_AFTER_MS,
    now: now.getTime(),
    process: (clerkOrgId, at) => processWorkspace(env, clerkOrgId, at),
  });
}
