/**
 * Reseller-licensing sweeps on the hourly cron (wrangler.toml `crons`).
 *
 * The cron fires every hour; each job runs only in its UTC hour and is
 * idempotent, so a repeated or late run does no harm:
 *
 *   02:xx daily    seat snapshots, licensed-credit reset, dunning sweep
 *   03:xx days 1-3 statement run for the previous month, then the Stripe
 *                  partner invoice. Days 2 and 3 only catch up what failed or
 *                  was missed on the 1st (partners whose statement is already
 *                  invoiced, paid or void are skipped).
 *
 * Plan: docs/plans/reseller-licensing.md.
 */

import { and, eq } from 'drizzle-orm';
import {
  listActiveLicencesForReset,
  partnerIdsWithLicences,
  resetLicensedCredits,
  snapshotSeats,
} from '@weldsuite/core-domain/partners';
import { monthPeriod, previousMonthPeriod } from '@weldsuite/app-api-client/schemas/partners';
import type { Env } from '../index';
import { getMasterDb, masterSchema } from '../lib/db';
import { PARTNER_TARGET, SYSTEM_ACTOR, recordAdminAudit } from '../lib/admin-audit';
import { runDunningSweep, type DunningSweepResult } from './partner-dunning';
import { runPartnerStatement } from './partner-billing';

const { partnerStatements } = masterSchema;

type MasterDb = ReturnType<typeof getMasterDb>;

/** UTC hours the jobs run in. */
export const DAILY_HOUR_UTC = 2;
export const MONTHLY_HOUR_UTC = 3;
/** The statement run is attempted on these days of the month (1 = the run, 2-3 = catch-up). */
export const MONTHLY_RUN_DAYS = 3;

/** Which jobs a cron tick at `now` runs. Pure. */
export function partnerSweepSchedule(now: Date): { daily: boolean; monthly: boolean } {
  const hour = now.getUTCHours();
  return {
    daily: hour === DAILY_HOUR_UTC,
    monthly: hour === MONTHLY_HOUR_UTC && now.getUTCDate() <= MONTHLY_RUN_DAYS,
  };
}

/** Credit resets run a few at a time; each is its own small transaction set. */
const CREDIT_RESET_CONCURRENCY = 5;

export interface CreditResetResult {
  licences: number;
  reset: number;
  skipped: number;
  failed: number;
}

/** Licensed credits for the current UTC month, for every active partner licence (no-op once done). */
export async function resetPartnerCredits(masterDb: MasterDb, now: Date): Promise<CreditResetResult> {
  const period = monthPeriod(now);
  const licences = await listActiveLicencesForReset(masterDb);
  const result: CreditResetResult = { licences: licences.length, reset: 0, skipped: 0, failed: 0 };
  for (let i = 0; i < licences.length; i += CREDIT_RESET_CONCURRENCY) {
    await Promise.all(
      licences.slice(i, i + CREDIT_RESET_CONCURRENCY).map(async (licence) => {
        try {
          const r = await resetLicensedCredits({
            db: masterDb,
            workspaceId: licence.workspaceId,
            monthlyCredits: licence.monthlyCredits,
            creditRolloverCap: licence.creditRolloverCap,
            periodStart: period.start,
            periodEnd: period.end,
          });
          if (r.skipped) result.skipped += 1;
          else result.reset += 1;
        } catch (err) {
          result.failed += 1;
          console.error(`[Partner Sweep] Credit reset failed for workspace ${licence.workspaceId}:`, err);
        }
      }),
    );
  }
  return result;
}

export interface StatementRunResult {
  period: string;
  partners: number;
  invoiced: number;
  noCharge: number;
  skipped: number;
  failed: number;
}

/**
 * Previous month's statement for every partner that has licences, then its
 * Stripe invoice. Partners already invoiced/paid/void for the period, or with
 * a settled zero statement, are skipped, which is what makes days 2-3 a
 * catch-up rather than a second run.
 */
export async function runMonthlyStatements(env: Env, masterDb: MasterDb, now: Date): Promise<StatementRunResult> {
  const period = previousMonthPeriod(now);
  const label = period.start.toISOString().slice(0, 7);
  const ids = await partnerIdsWithLicences(masterDb);
  const result: StatementRunResult = { period: label, partners: ids.length, invoiced: 0, noCharge: 0, skipped: 0, failed: 0 };

  for (const partnerId of ids) {
    try {
      const [existing] = await masterDb
        .select()
        .from(partnerStatements)
        .where(and(eq(partnerStatements.partnerId, partnerId), eq(partnerStatements.periodStart, period.start)))
        .limit(1);
      if (existing && ['invoiced', 'paid', 'void'].includes(existing.status)) {
        result.skipped += 1;
        continue;
      }
      if (existing?.status === 'final' && Number(existing.totalDue) === 0) {
        result.skipped += 1;
        continue;
      }
      const run = await runPartnerStatement(env, masterDb, {
        partnerId,
        period,
        // One key per partner and month: a retry of a half-finished run reuses it.
        keyBase: `cron:${partnerId}:${label}`,
        reopenVoided: false,
        now,
      });
      if (run.action === 'invoiced') {
        result.invoiced += 1;
        await recordAdminAudit(masterDb, {
          actor: SYSTEM_ACTOR,
          workspaceId: null,
          targetType: PARTNER_TARGET,
          targetId: partnerId,
          action: 'statement.invoiced',
          outcome: 'success',
          reason: `Monthly statement ${label}`,
          details: { statementId: run.statement.id, totalDue: run.statement.totalDue, stripeInvoiceId: run.statement.stripeInvoiceId },
        });
      } else if (run.action === 'finalized_no_charge') result.noCharge += 1;
      else result.skipped += 1;
    } catch (err) {
      result.failed += 1;
      console.error(`[Partner Sweep] Statement run for partner ${partnerId} (${label}) failed:`, err);
      await recordAdminAudit(masterDb, {
        actor: SYSTEM_ACTOR,
        workspaceId: null,
        targetType: PARTNER_TARGET,
        targetId: partnerId,
        action: 'statement.invoiced',
        outcome: 'failure',
        reason: `Monthly statement ${label}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

export interface PartnerSweepResult {
  daily: boolean;
  monthly: boolean;
  seatSnapshots?: { workspaces: number };
  credits?: CreditResetResult;
  dunning?: DunningSweepResult;
  statements?: StatementRunResult;
}

/** One cron tick: runs whichever jobs belong to this UTC hour. Each job fails on its own. */
export async function runPartnerSweeps(
  env: Env,
  now: Date = new Date(),
  masterDb: MasterDb = getMasterDb(env),
): Promise<PartnerSweepResult> {
  const schedule = partnerSweepSchedule(now);
  const result: PartnerSweepResult = { ...schedule };

  if (schedule.daily) {
    try {
      result.seatSnapshots = await snapshotSeats(masterDb, now);
    } catch (err) {
      console.error('[Partner Sweep] Seat snapshots failed:', err);
    }
    try {
      result.credits = await resetPartnerCredits(masterDb, now);
    } catch (err) {
      console.error('[Partner Sweep] Credit reset failed:', err);
    }
    try {
      result.dunning = await runDunningSweep(env, masterDb, now);
    } catch (err) {
      console.error('[Partner Sweep] Dunning sweep failed:', err);
    }
  }

  if (schedule.monthly) {
    try {
      result.statements = await runMonthlyStatements(env, masterDb, now);
    } catch (err) {
      console.error('[Partner Sweep] Statement run failed:', err);
    }
  }

  if (schedule.daily || schedule.monthly) console.log('[Partner Sweep]', JSON.stringify(result));
  return result;
}
