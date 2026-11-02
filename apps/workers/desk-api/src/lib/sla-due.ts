/**
 * Tell the SLA sweep (cron/sla-sweep.ts) when a conversation's SLA clock next
 * comes due. appendDeskMessage re-derives the clocks on every desk write and
 * returns `slaCheckAt`; the sweep must not open tenant DBs on a timer to look
 * (ADR DATA-008), so the time goes into the schedule-index D1
 * (`workspace_due_index`, kind `desk_sla`). Best-effort and fire-and-forget:
 * it can only pull the workspace's due time earlier, and a D1 hiccup never
 * fails the write.
 */

import type { Context } from 'hono';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import type { Env, Variables } from '../types';

export function markDeskSlaDue(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  slaCheckAt: Date | null | undefined,
): void {
  if (!slaCheckAt || !c.env.SCHEDULE_INDEX) return;
  c.executionCtx.waitUntil(markWorkspaceDue(c.env.SCHEDULE_INDEX, 'desk_sla', c.get('clerkOrgId'), slaCheckAt));
}
