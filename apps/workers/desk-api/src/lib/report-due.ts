/**
 * Tell the report schedule sweep (cron/report-schedule-sweep.ts) when a
 * workspace's scheduled reports next come due. The sweep must not open tenant
 * DBs on a timer to look (ADR DATA-008), so every write to a schedule marks
 * the workspace in the schedule-index D1 (`workspace_due_index`, kind
 * `desk_report`) at the schedule's `nextRunAt`. Best-effort and
 * fire-and-forget, like lib/sla-due.ts: it can only pull the workspace's due
 * time earlier, and a D1 hiccup never fails the write.
 */

import type { Context } from 'hono';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import type { Env, Variables } from '../types';

export function markDeskReportDue(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  nextRunAt: Date | null | undefined,
): void {
  if (!nextRunAt || !c.env.SCHEDULE_INDEX) return;
  c.executionCtx.waitUntil(markWorkspaceDue(c.env.SCHEDULE_INDEX, 'desk_report', c.get('clerkOrgId'), nextRunAt));
}
