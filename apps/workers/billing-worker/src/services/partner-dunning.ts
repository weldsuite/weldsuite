/**
 * Partner dunning sweep (daily, see services/partner-sweep.ts).
 *
 * For every partner with an unpaid statement: recompute the payment status
 * from the worst overdue stage (past_due at day 14, read-only at day 30,
 * counted from the invoice due date, held by a staff pause), drop the
 * workspace caches when it changed, and email the partner once per stage
 * (day 14 overdue, day 23 final warning, day 30 read-only).
 *
 * "Once per stage" is remembered in `admin_audit_events` (action
 * `dunning.notify`, keyed by statement and stage), so a re-run of the sweep
 * never mails twice, and a failed send is retried the next day.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  getPartner,
  partnerBillingRecipients,
  partnerIdsWithOpenStatements,
  recomputePartnerStatus,
} from '@weldsuite/core-domain/partners';
import type { Env } from '../index';
import { type getMasterDb, masterSchema } from '../lib/db';
import { PARTNER_TARGET, SYSTEM_ACTOR, recordAdminAudit } from '../lib/admin-audit';
import { sendPartnerDunningEmail } from './partner-mail';
import { invalidatePartnerWorkspaceCaches } from './partner-billing';

const { adminAuditEvents } = masterSchema;

type MasterDb = ReturnType<typeof getMasterDb>;

const DAY_MS = 86_400_000;

export interface DunningSweepResult {
  partners: number;
  statusChanged: number;
  emailed: number;
  failed: number;
}

async function alreadyNotified(masterDb: MasterDb, partnerId: string, statementId: string, stage: string): Promise<boolean> {
  const [row] = await masterDb
    .select({ id: adminAuditEvents.id })
    .from(adminAuditEvents)
    .where(
      and(
        eq(adminAuditEvents.targetType, PARTNER_TARGET),
        eq(adminAuditEvents.targetId, partnerId),
        eq(adminAuditEvents.action, 'dunning.notify'),
        eq(adminAuditEvents.outcome, 'success'),
        sql`${adminAuditEvents.details}->>'statementId' = ${statementId}`,
        sql`${adminAuditEvents.details}->>'stage' = ${stage}`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** One partner's dunning: status, caches, the stage email. Never throws on mail. */
export async function sweepPartnerDunning(
  env: Env,
  masterDb: MasterDb,
  partnerId: string,
  now: Date,
): Promise<{ statusChanged: boolean; emailed: boolean; failed: boolean }> {
  const evaluation = await recomputePartnerStatus(masterDb, partnerId, now);
  if (!evaluation) return { statusChanged: false, emailed: false, failed: false };
  const { state } = evaluation;

  if (evaluation.changed) {
    const workspaces = await invalidatePartnerWorkspaceCaches(env, masterDb, partnerId);
    await recordAdminAudit(masterDb, {
      actor: SYSTEM_ACTOR,
      workspaceId: null,
      targetType: PARTNER_TARGET,
      targetId: partnerId,
      action: 'partner.status.auto',
      outcome: 'success',
      reason: `Dunning: ${state.stage}`,
      details: {
        from: evaluation.previousStatus,
        to: state.status,
        stage: state.stage,
        daysOverdue: state.daysOverdue,
        statementId: state.statementId,
        workspaces,
      },
    });
  }

  if (state.stage === 'current' || !state.statementId || !state.dueAt) {
    return { statusChanged: evaluation.changed, emailed: false, failed: false };
  }
  const stage = state.stage;
  if (await alreadyNotified(masterDb, partnerId, state.statementId, stage)) {
    return { statusChanged: evaluation.changed, emailed: false, failed: false };
  }

  const statement = evaluation.openStatements.find((s) => s.id === state.statementId);
  const partner = await getPartner(masterDb, partnerId);
  if (!statement || !partner) return { statusChanged: evaluation.changed, emailed: false, failed: false };

  try {
    const to = await partnerBillingRecipients(masterDb, partnerId);
    const sent = await sendPartnerDunningEmail(env, {
      stage,
      to,
      partnerName: partner.name,
      periodStart: statement.periodStart.toISOString(),
      amountDue: statement.totalDue,
      currency: statement.currency,
      dueAt: state.dueAt.toISOString(),
      daysOverdue: state.daysOverdue,
      readOnlyAt: new Date(state.dueAt.getTime() + state.readOnlyAfterDays * DAY_MS).toISOString(),
      invoiceUrl: statement.stripeInvoiceUrl,
      country: partner.country,
    });
    if (!sent) return { statusChanged: evaluation.changed, emailed: false, failed: false };
    await recordAdminAudit(masterDb, {
      actor: SYSTEM_ACTOR,
      workspaceId: null,
      targetType: PARTNER_TARGET,
      targetId: partnerId,
      action: 'dunning.notify',
      outcome: 'success',
      details: { statementId: state.statementId, stage, daysOverdue: state.daysOverdue, recipients: to.length },
    });
    return { statusChanged: evaluation.changed, emailed: true, failed: false };
  } catch (err) {
    console.error(`[Partner Dunning] ${stage} email to partner ${partnerId} failed:`, err);
    return { statusChanged: evaluation.changed, emailed: false, failed: true };
  }
}

export async function runDunningSweep(env: Env, masterDb: MasterDb, now: Date): Promise<DunningSweepResult> {
  const ids = await partnerIdsWithOpenStatements(masterDb);
  const result: DunningSweepResult = { partners: ids.length, statusChanged: 0, emailed: 0, failed: 0 };
  for (const partnerId of ids) {
    try {
      const r = await sweepPartnerDunning(env, masterDb, partnerId, now);
      if (r.statusChanged) result.statusChanged += 1;
      if (r.emailed) result.emailed += 1;
      if (r.failed) result.failed += 1;
    } catch (err) {
      result.failed += 1;
      console.error(`[Partner Dunning] Sweep failed for partner ${partnerId}:`, err);
    }
  }
  return result;
}

