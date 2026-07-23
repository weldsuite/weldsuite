/**
 * AI gateway credit rollup — re-derives per-gateway spend and publishes the
 * snapshot the whole platform routes on.
 *
 * Runs on workflow-worker's existing `* * * * *` trigger. That placement is
 * load-bearing: **workflow-worker is the only worker with a cron**, so there is
 * exactly one writer by construction — no distributed coordination, no leader
 * election. (The KV lock below only guards a run overrunning its own minute.)
 *
 * Why re-aggregate instead of incrementing a counter per call: see
 * `packages/core/credits/src/gateway-costs.ts`. Short version — a SUM self-heals and
 * has no hot row; an incrementing counter drifts forever and serializes every AI
 * call on the platform through one row.
 *
 * app-api reads the published snapshot but never writes it, and never queries
 * the master DB for credit state on the hot path.
 */

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { rollupGatewayCredits } from '@weldsuite/credits/gateway-costs';
import {
  GATEWAY_ROLLUP_LOCK_KEY,
  toSnapshot,
  writeGatewayCreditSnapshot,
} from '@weldsuite/credits/gateway-cache';

import type { WorkflowEnv } from '../engine/types';

/**
 * Re-derive spend, advance expired periods, publish the KV snapshot.
 *
 * Returns the number of gateways rolled up (0 when skipped). Never throws — a
 * failed rollup must not take the cron down, and it self-limits: the snapshot
 * simply expires (120s TTL) and routing degrades to fee order.
 */
export async function runGatewayCreditRollup(env: WorkflowEnv, now = new Date()): Promise<number> {
  if (!env.DATABASE_URL_MASTER) return 0;

  // Guards an overrunning run overlapping the next minute's tick. Best-effort:
  // if KV is unavailable we proceed — a double rollup is harmless (the counter
  // is derived, so re-running just recomputes the same SUM).
  const lock = env.WORKSPACE_CACHE;
  if (lock) {
    try {
      if (await lock.get(GATEWAY_ROLLUP_LOCK_KEY)) {
        console.log('[GatewayCreditRollup] A rollup is already in flight, skipping');
        return 0;
      }
      await lock.put(GATEWAY_ROLLUP_LOCK_KEY, '1', { expirationTtl: 300 });
    } catch (err) {
      console.warn('[GatewayCreditRollup] Lock unavailable (proceeding):', err);
    }
  }

  try {
    const db = drizzle(neon(env.DATABASE_URL_MASTER));
    const rows = await rollupGatewayCredits(db, now);

    if (lock) {
      await writeGatewayCreditSnapshot(lock, toSnapshot(rows, now));
    }

    return rows.length;
  } finally {
    // Release early so a fast run doesn't block the next tick for 5 minutes.
    if (lock) {
      await lock.delete(GATEWAY_ROLLUP_LOCK_KEY).catch(() => {});
    }
  }
}
