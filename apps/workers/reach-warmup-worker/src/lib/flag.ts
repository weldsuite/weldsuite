/**
 * Kill switch `weldreach-warmup` (Flagship, default on): when it is off the
 * crons plan, dispatch, engage and clean up nothing, and queued work is
 * released untouched. Separate from `weldreach-sending`.
 */

import { getFlags, type FlagsContext } from '@weldsuite/feature-flags/server';
import type { Env } from '../env';

export const KILL_SWITCH_FLAG = 'weldreach-warmup' as const;

/** How long a "switched off" log line is suppressed (the dispatch cron fires every minute). */
const LOG_EVERY_MS = 10 * 60_000;
let lastLoggedOffAt = 0;

/**
 * Evaluate the switch outside a request. Defaults to on when Flagship is not
 * bound (local `wrangler dev`) or when the evaluation fails.
 */
export async function isWarmupEnabled(env: Pick<Env, 'FLAGSHIP' | 'ENVIRONMENT'>, now: Date = new Date()): Promise<boolean> {
  const context: FlagsContext = {
    env,
    get: ((key: 'userId' | 'workspaceId' | 'orgId') => (key === 'userId' ? 'system' : '')) as FlagsContext['get'],
  };
  const enabled = await (await getFlags(context)).isOn(KILL_SWITCH_FLAG);
  if (!enabled && now.getTime() - lastLoggedOffAt >= LOG_EVERY_MS) {
    lastLoggedOffAt = now.getTime();
    console.log(`[reach-warmup] kill switch ${KILL_SWITCH_FLAG} is off: doing nothing`);
  }
  return enabled;
}

/** Test hook: forget when the "off" line was last logged. */
export function resetKillSwitchLog(): void {
  lastLoggedOffAt = 0;
}
