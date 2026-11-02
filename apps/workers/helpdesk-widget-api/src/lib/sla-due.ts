/**
 * Tell desk-api's SLA sweep when a conversation's SLA clock next comes due.
 * appendDeskMessage re-derives the clocks on every visitor message and returns
 * `slaCheckAt`; the sweep opens only workspaces marked due in the
 * schedule-index D1 (`workspace_due_index`, kind `desk_sla`, ADR DATA-008).
 * Best-effort: a D1 hiccup never fails the visitor's message.
 */

import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import type { Env } from '../index';

export function markDeskSlaDue(
  env: Env,
  waitUntil: (promise: Promise<unknown>) => void,
  orgId: string,
  slaCheckAt: Date | null | undefined,
): void {
  if (!slaCheckAt || !env.SCHEDULE_INDEX) return;
  waitUntil(markWorkspaceDue(env.SCHEDULE_INDEX, 'desk_sla', orgId, slaCheckAt));
}
