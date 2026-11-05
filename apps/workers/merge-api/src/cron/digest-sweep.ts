/**
 * The WeldChat daily digest (area D), run by the hourly cron in wrangler.toml.
 *
 * It never wakes idle tenant databases (ADR DATA-008): timing lives in the
 * SCHEDULE_INDEX D1 `workspace_due_index` (kind `merge_digest`, via
 * `@weldsuite/worker-kit/due-index`). Creating or changing a chat subscription
 * with `daily_digest` marks the workspace due at its next `digest_hour`; each
 * tick reads only D1, opens the workspaces that are due, posts the digests and
 * re-arms the next hour (or drops the row).
 *
 * Foundation stub: does nothing until chat subscriptions are built.
 */

import type { Env } from '../types';

/** The cron expression that runs this sweep; keep in step with wrangler.toml. */
export const DIGEST_SWEEP_CRONS = ['0 * * * *'] as const;

export function isDigestSweepCron(cron: string): boolean {
  return (DIGEST_SWEEP_CRONS as readonly string[]).includes(cron);
}

export async function runDigestSweep(_env: Env): Promise<void> {
  // Filled by area D.
}
