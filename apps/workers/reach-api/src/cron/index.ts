/**
 * Cron dispatch (wrangler.toml [triggers]):
 *   "* * * * *"   send sweep — reads only D1 on a quiet tick (AGENTS.md: never
 *                 wake tenant DBs on a timer) and enqueues due workspaces.
 *   "15 * * * *"  warmup progress (due-index kind reach_warmup). Workspaces are
 *                 due once a day; the hourly tick works through the backlog in
 *                 batches that stay inside the subrequest limit. At 03:15 UTC
 *                 it also runs the Mailpool slot reconciliation (master DB only).
 */

import type { Env } from '../types';
import { runSendSweep } from './send-sweep';
import { runWarmupSweep } from './warmup-sweep';
import { runSlotReconciliation } from './slot-reconciliation';

export const SEND_SWEEP_CRON = '* * * * *';
export const HOURLY_CRON = '15 * * * *';
/** UTC hour at which the hourly tick also reconciles Mailpool slots. */
export const SLOT_RECONCILIATION_HOUR_UTC = 3;

export async function handleScheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  if (event.cron === HOURLY_CRON) {
    const tasks: Promise<unknown>[] = [runWarmupSweep(env)];
    if (new Date(event.scheduledTime).getUTCHours() === SLOT_RECONCILIATION_HOUR_UTC) {
      tasks.push(runSlotReconciliation(env));
    }
    ctx.waitUntil(
      Promise.allSettled(tasks).then((results) => {
        for (const r of results) if (r.status === 'rejected') console.error('[reach-cron] hourly task failed:', r.reason);
      }),
    );
    return;
  }
  ctx.waitUntil(
    runSendSweep(env).catch((err) => {
      console.error('[reach-cron] send sweep failed:', err);
    }),
  );
}
