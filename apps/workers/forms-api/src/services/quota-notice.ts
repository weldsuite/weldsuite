/**
 * Quota notices: workspace admins get `forms.quota` when the month's completed
 * responses reach 80 % and 100 % of the plan's limit, once per threshold per
 * month (weldsuite-documentation/plans/weldforms.md, "Plan quota"). The "already sent" marker lives
 * in KV, keyed by workspace, month and threshold.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { masterSchema, schema } from '@weldsuite/worker-kit/db';
import type { WorkspaceCtx } from './context';
import { sendQuotaMail, type MemberRecipient } from './mail';
import { monthOf } from './public-cache';
import { loadUsage } from './usage';

const { workspaceMembers } = schema;
const { workspaces } = masterSchema;

export const QUOTA_THRESHOLDS = [80, 100] as const;
export const quotaNoticeKey = (workspaceId: string, month: string, percent: number) => `forms:quota-notice:${workspaceId}:${month}:${percent}`;

/** Active members who can change the plan: owners and admins with an address. */
async function adminsOf(ctx: Pick<WorkspaceCtx, 'db'>): Promise<MemberRecipient[]> {
  const rows = await ctx.db
    .select({ userId: workspaceMembers.userId, email: workspaceMembers.email, name: workspaceMembers.name })
    .from(workspaceMembers)
    .where(and(inArray(workspaceMembers.role, ['OWNER', 'ADMIN']), isNull(workspaceMembers.deletedAt)));
  return rows.filter((r): r is { userId: string; email: string; name: string | null } => Boolean(r.email)).map((r) => ({ userId: r.userId, email: r.email, name: r.name }));
}

/** Sends the notice of the highest threshold reached that was not sent yet this month. Returns it, or null. */
export async function sendQuotaNotices(ctx: WorkspaceCtx, now = new Date()): Promise<80 | 100 | null> {
  const usage = await loadUsage(ctx, now);
  if (usage.limit === null || usage.limit <= 0) return null;
  const month = monthOf(now);
  const reached = QUOTA_THRESHOLDS.filter((t) => usage.used * 100 >= usage.limit! * t);
  const unsent: Array<80 | 100> = [];
  for (const t of reached) if (!(await ctx.env.WORKSPACE_CACHE.get(quotaNoticeKey(ctx.workspaceId, month, t)))) unsent.push(t);
  if (unsent.length === 0) return null;
  // One mail for the highest threshold; the lower one it skipped is marked too, so it never follows.
  await Promise.all(unsent.map((t) => ctx.env.WORKSPACE_CACHE.put(quotaNoticeKey(ctx.workspaceId, month, t), '1', { expirationTtl: 40 * 24 * 60 * 60 })));
  const percent = unsent[unsent.length - 1]!;
  const [workspace] = await ctx.master.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).limit(1);
  for (const admin of await adminsOf(ctx)) {
    await sendQuotaMail(ctx, admin, { workspaceName: workspace?.name ?? 'WeldSuite', percent, used: usage.used, limit: usage.limit, resetsAt: usage.periodEnd });
  }
  return percent;
}
