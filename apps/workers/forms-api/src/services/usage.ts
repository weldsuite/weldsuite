/**
 * Plan quota: completed responses per UTC calendar month against what the
 * workspace's plan allows (weldsuite-documentation/plans/weldforms.md, "Plan quota"). Counted from
 * `form_responses.submitted_at`, no separate counter. Views, partial responses
 * and previews are not counted.
 */

import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { loadWorkspacePlan, planLimit, utcMonthRange, type WorkspacePlan } from '@weldsuite/core-domain/plan-limits';
import { schema } from '@weldsuite/worker-kit/db';
import { FORM_RESPONSE_QUOTAS, type FormsUsage } from '@weldsuite/app-api-client/schemas/weldforms';
import type { WorkspaceCtx } from './context';

const { formResponses } = schema;

export interface Usage extends FormsUsage {
  workspacePlan: WorkspacePlan;
}

export async function completedThisMonth(ctx: Pick<WorkspaceCtx, 'db'>, now = new Date()): Promise<number> {
  const { start, end } = utcMonthRange(now);
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(formResponses)
    .where(and(eq(formResponses.status, 'completed'), gte(formResponses.submittedAt, start), lt(formResponses.submittedAt, end)));
  return Number(row?.n ?? 0);
}

export async function loadUsage(ctx: Pick<WorkspaceCtx, 'db' | 'master' | 'workspaceId'>, now = new Date()): Promise<Usage> {
  const { start, end } = utcMonthRange(now);
  const [plan, used] = await Promise.all([loadWorkspacePlan(ctx.master, ctx.workspaceId), completedThisMonth(ctx, now)]);
  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    used,
    limit: planLimit(FORM_RESPONSE_QUOTAS, plan),
    plan: plan.slug,
    workspacePlan: plan,
  };
}

/** True when `used` has reached a finite limit. */
export const overQuota = (usage: Pick<FormsUsage, 'used' | 'limit'>): boolean => usage.limit !== null && usage.used >= usage.limit;
