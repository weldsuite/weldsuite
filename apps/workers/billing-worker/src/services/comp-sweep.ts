/**
 * Comp sweep (hourly cron, see wrangler.toml).
 *
 *  1. Ends comps whose `compEndsAt` has passed (services/admin-billing.ts
 *     `endCompForWorkspace`): a still-billing subscription takes over again,
 *     otherwise the ended-subscription policy applies.
 *  2. Renews the monthly plan credits of comped workspaces. Paying workspaces
 *     get theirs from `invoice.paid`; a comp has no invoice, so the sweep does
 *     it, idempotent on (workspace, periodStart) like the webhook.
 */

import { and, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm';
import type { Env } from '../index';
import { getMasterDb, masterSchema } from '../lib/db';
import { SYSTEM_ACTOR, recordAdminAudit } from '../lib/admin-audit';
import { endCompForWorkspace } from './admin-billing';
import { updateSubscriptionCredits } from './credits';

const { workspaces, workspaceCredits, plans } = masterSchema;

/** Rows per run; the next hourly run picks up the rest. */
const SWEEP_BATCH_LIMIT = 50;

export interface CompSweepResult {
  ended: number;
  failed: number;
  creditsRenewed: number;
}

function addOneMonth(date: Date): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

/**
 * The credit period that follows `periodEnd`. A workspace that missed several
 * periods (sweep down, or credits row left behind) restarts from `now`
 * instead of being granted every missed month.
 */
export function nextCreditPeriod(periodEnd: Date, now: Date): { start: Date; end: Date } {
  const start = addOneMonth(periodEnd) <= now ? now : periodEnd;
  return { start, end: addOneMonth(start) };
}

async function endExpiredComps(env: Env, masterDb: ReturnType<typeof getMasterDb>, now: Date) {
  const due = await masterDb
    .select()
    .from(workspaces)
    .where(
      and(
        isNotNull(workspaces.compGrantedAt),
        lte(workspaces.compEndsAt, now),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(SWEEP_BATCH_LIMIT);

  let ended = 0;
  let failed = 0;
  for (const workspace of due) {
    const details = {
      planId: workspace.planId,
      compEndsAt: workspace.compEndsAt?.toISOString() ?? null,
      compGrantedBy: workspace.compGrantedBy,
    };
    try {
      const result = await endCompForWorkspace(env, masterDb, workspace);
      ended += 1;
      await recordAdminAudit(masterDb, {
        actor: SYSTEM_ACTOR,
        workspaceId: workspace.id,
        targetType: 'workspace',
        targetId: workspace.id,
        action: 'comp.expire',
        outcome: 'success',
        reason: 'Comp end date reached',
        details: { ...details, ...result },
      });
    } catch (err) {
      failed += 1;
      console.error(`[Comp Sweep] Failed to end comp of workspace ${workspace.id}:`, err);
      await recordAdminAudit(masterDb, {
        actor: SYSTEM_ACTOR,
        workspaceId: workspace.id,
        targetType: 'workspace',
        targetId: workspace.id,
        action: 'comp.expire',
        outcome: 'failure',
        reason: 'Comp end date reached',
        details,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { ended, failed };
}

async function renewCompCredits(masterDb: ReturnType<typeof getMasterDb>, now: Date): Promise<number> {
  const due = await masterDb
    .select({
      workspaceId: workspaces.id,
      monthlyCredits: plans.monthlyCredits,
      periodEnd: workspaceCredits.periodEnd,
    })
    .from(workspaces)
    .innerJoin(workspaceCredits, eq(workspaceCredits.workspaceId, workspaces.id))
    .innerJoin(plans, eq(plans.id, workspaces.planId))
    .where(
      and(
        isNotNull(workspaces.compGrantedAt),
        or(isNull(workspaces.compEndsAt), gt(workspaces.compEndsAt, now)),
        isNull(workspaces.deletedAt),
        lte(workspaceCredits.periodEnd, now),
      ),
    )
    .limit(SWEEP_BATCH_LIMIT);

  let renewed = 0;
  for (const row of due) {
    const { start, end } = nextCreditPeriod(row.periodEnd, now);
    try {
      await updateSubscriptionCredits(masterDb, row.workspaceId, {
        planCredits: row.monthlyCredits ?? 0,
        subscribedCredits: 0,
        resetPeriod: true,
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
      });
      renewed += 1;
    } catch (err) {
      console.error(`[Comp Sweep] Failed to renew credits of comped workspace ${row.workspaceId}:`, err);
    }
  }
  return renewed;
}

export async function runCompSweep(env: Env, now: Date = new Date()): Promise<CompSweepResult> {
  const masterDb = getMasterDb(env);
  const { ended, failed } = await endExpiredComps(env, masterDb, now);
  const creditsRenewed = await renewCompCredits(masterDb, now);
  console.log(`[Comp Sweep] ended=${ended} failed=${failed} creditsRenewed=${creditsRenewed}`);
  return { ended, failed, creditsRenewed };
}
