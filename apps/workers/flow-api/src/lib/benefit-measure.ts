/**
 * When benefits are due for measuring (FLOW-014).
 *
 * The monthly measuring (cron/benefit-measure.ts) must not open tenant
 * databases on a timer to look (ADR DATA-008): the timing lives in the
 * always-on schedule-index D1 (`workspace_due_index`, kind `benefit_measure`).
 * A route that creates or edits a benefit with a catalogue metric marks its
 * workspace due at the next month boundary, and the sweep opens only workspaces
 * that are due.
 */

import type { Context } from 'hono';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { nextMonthStart } from '@weldsuite/flow-domain/benefit-metrics';
import type { Env, Variables } from '../types';

/**
 * Tell the sweep this workspace has a benefit to measure at the next month
 * boundary. Call after the write. Best-effort and fire-and-forget: it can only
 * pull the workspace's due time earlier, and a D1 hiccup never fails the
 * user's request.
 */
export function markBenefitMeasureDue(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  now: Date = new Date(),
): void {
  if (!c.env.SCHEDULE_INDEX) return;
  c.executionCtx.waitUntil(
    markWorkspaceDue(c.env.SCHEDULE_INDEX, 'benefit_measure', c.get('clerkOrgId'), nextMonthStart(now)),
  );
}
