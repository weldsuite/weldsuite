/**
 * Workspace licences: write path (master), installed-app sync (tenant) and the
 * credit allowance. Shared by app-api (partner portal) and billing-worker
 * (admin console routes, sweeps), which use different Drizzle drivers, so the
 * db handles are typed loosely like `@weldsuite/credits` does.
 */

import { and, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { workspaceInstalledApps } from '@weldsuite/db/schema/workspace-installed-apps';
import { getOrCreateWorkspaceCredits, grantCredits } from '@weldsuite/credits';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  belowMinimumDetails,
  monthPeriod,
  resaleMinimumShortfall,
  type BelowMinimumDetails,
  type LicenceSnapshot,
  type LicenceTerms,
  type WorkspaceLicenceStatus,
} from '@weldsuite/app-api-client/schemas/partners';
import type { PartnerDb } from './types';

const { workspaces, workspaceLicences, workspaceLicenceChanges, workspaceCredits, partnerContracts, appCatalog, plans } =
  masterSchema;

export type LicenceActor = { id: string | null; type: 'partner' | 'admin' | 'system' };

export class LicenceError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_APPS'
      | 'PLAN_NOT_ALLOWED'
      | 'NO_CONTRACT'
      | 'NOT_FOUND'
      | 'WRONG_PARTNER'
      | 'BELOW_MINIMUM',
    message: string,
    /** Set for `BELOW_MINIMUM`: where the price falls short, for the error response. */
    public readonly details?: BelowMinimumDetails,
  ) {
    super(message);
    this.name = 'LicenceError';
  }
}

export function snapshotOf(
  licence: Pick<
    typeof workspaceLicences.$inferSelect,
    | 'status'
    | 'allowedApps'
    | 'monthlyCredits'
    | 'creditRolloverCap'
    | 'maxSeats'
    | 'featurePlanId'
    | 'storageGb'
    | 'resalePricing'
    | 'packageId'
  >,
): LicenceSnapshot {
  return {
    status: licence.status,
    allowedApps: licence.allowedApps,
    monthlyCredits: licence.monthlyCredits,
    creditRolloverCap: licence.creditRolloverCap,
    maxSeats: licence.maxSeats,
    featurePlanId: licence.featurePlanId,
    storageGb: licence.storageGb,
    resalePricing: licence.resalePricing as LicenceSnapshot['resalePricing'],
    packageId: licence.packageId,
  };
}

/** The contract in force for a partner at `at` (latest effectiveFrom ≤ at, not ended). */
export async function getActiveContract(db: PartnerDb, partnerId: string, at: Date = new Date()) {
  const rows = (await db
    .select()
    .from(partnerContracts)
    .where(eq(partnerContracts.partnerId, partnerId))) as Array<typeof partnerContracts.$inferSelect>;
  const inForce = rows
    .filter((c) => c.effectiveFrom.getTime() <= at.getTime() && (!c.effectiveTo || c.effectiveTo.getTime() > at.getTime()))
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
  return inForce[0] ?? null;
}

/**
 * Reject a licence the contract does not allow: the price must cover the
 * minimum selling price at every seat count the licence allows, apps must be
 * published catalog apps, and the feature plan must be one the contract lists
 * (when it lists any).
 */
export async function validateLicenceTerms(db: PartnerDb, partnerId: string, terms: LicenceTerms): Promise<void> {
  const contract = await getActiveContract(db, partnerId);
  if (!contract) throw new LicenceError('NO_CONTRACT', 'This partner has no contract in force');

  const shortfall = resaleMinimumShortfall(contract, terms);
  if (shortfall) {
    const details = belowMinimumDetails(shortfall, contract);
    throw new LicenceError('BELOW_MINIMUM', details.message, details);
  }

  if (terms.allowedApps.length > 0) {
    const published = (await db
      .select({ code: appCatalog.code })
      .from(appCatalog)
      .where(and(inArray(appCatalog.code, terms.allowedApps), eq(appCatalog.isActive, true), eq(appCatalog.isPublished, true)))) as Array<{ code: string }>;
    const known = new Set(published.map((r) => r.code));
    const unknown = terms.allowedApps.filter((code) => !known.has(code));
    if (unknown.length > 0) throw new LicenceError('INVALID_APPS', `Unknown or unpublished apps: ${unknown.join(', ')}`);
  }

  if (terms.featurePlanId) {
    const allowed = contract.allowedFeaturePlanIds;
    if (allowed.length > 0 && !allowed.includes(terms.featurePlanId)) {
      throw new LicenceError('PLAN_NOT_ALLOWED', 'This feature plan is not allowed by the partner contract');
    }
    const [plan] = (await db.select({ id: plans.id }).from(plans).where(eq(plans.id, terms.featurePlanId)).limit(1)) as Array<{ id: string }>;
    if (!plan) throw new LicenceError('PLAN_NOT_ALLOWED', 'Unknown feature plan');
  }
}

export interface UpsertLicenceResult {
  licence: typeof workspaceLicences.$inferSelect;
  previous: LicenceSnapshot | null;
  changeId: string;
}

/**
 * Create or replace a workspace's licence and record the change. Marks the
 * workspace partner-managed and copies the feature plan onto `plan_id`, so the
 * existing plan-limit checks keep working unchanged. Validation is the
 * caller's job (`validateLicenceTerms`); a partner may only touch its own
 * workspaces (`WRONG_PARTNER`).
 */
export async function upsertWorkspaceLicence(input: {
  db: PartnerDb;
  workspaceId: string;
  partnerId: string;
  terms: LicenceTerms;
  /** undefined keeps the current package; null clears it. */
  packageId?: string | null;
  status?: WorkspaceLicenceStatus;
  actor: LicenceActor;
  reason?: string | null;
  now?: Date;
}): Promise<UpsertLicenceResult> {
  const { db, workspaceId, partnerId, terms, actor } = input;
  const now = input.now ?? new Date();

  const [existing] = (await db
    .select()
    .from(workspaceLicences)
    .where(eq(workspaceLicences.workspaceId, workspaceId))
    .limit(1)) as Array<typeof workspaceLicences.$inferSelect>;
  if (existing && existing.partnerId !== partnerId) {
    throw new LicenceError('WRONG_PARTNER', 'This workspace belongs to another partner');
  }

  const values = {
    allowedApps: terms.allowedApps,
    monthlyCredits: terms.monthlyCredits,
    creditRolloverCap: terms.creditRolloverCap,
    maxSeats: terms.maxSeats,
    featurePlanId: terms.featurePlanId,
    storageGb: terms.storageGb,
    resalePricing: terms.resalePricing,
    // undefined keeps the current package, an explicit null clears the link.
    packageId: input.packageId === undefined ? (existing?.packageId ?? null) : input.packageId,
    status: input.status ?? existing?.status ?? 'active',
    updatedBy: actor.id,
    updatedAt: now,
  } as const;

  let licence: typeof workspaceLicences.$inferSelect;
  if (existing) {
    const [row] = await db
      .update(workspaceLicences)
      .set({ ...values, endsAt: values.status === 'ended' ? (existing.endsAt ?? now) : null })
      .where(eq(workspaceLicences.id, existing.id))
      .returning();
    licence = row;
  } else {
    const [row] = await db
      .insert(workspaceLicences)
      .values({ id: generateId('wsl'), workspaceId, partnerId, ...values, startsAt: now, createdAt: now })
      .returning();
    licence = row;
  }

  const changeId = generateId('wlc');
  await db.insert(workspaceLicenceChanges).values({
    id: changeId,
    workspaceId,
    partnerId,
    snapshot: snapshotOf(licence),
    changedBy: actor.id,
    changedByType: actor.type,
    reason: input.reason ?? null,
    changedAt: now,
  });

  await db
    .update(workspaces)
    .set({
      partnerId,
      billingMode: 'partner',
      ...(terms.featurePlanId ? { planId: terms.featurePlanId } : {}),
      paidPlanRequired: false,
      updatedAt: now,
    })
    .where(eq(workspaces.id, workspaceId));

  return { licence, previous: existing ? snapshotOf(existing) : null, changeId };
}

/** Change only a licence's status (suspend, resume, end), recording the change. */
export async function setLicenceStatus(input: {
  db: PartnerDb;
  workspaceId: string;
  partnerId: string;
  status: WorkspaceLicenceStatus;
  actor: LicenceActor;
  reason?: string | null;
}): Promise<UpsertLicenceResult> {
  const [existing] = (await input.db
    .select()
    .from(workspaceLicences)
    .where(eq(workspaceLicences.workspaceId, input.workspaceId))
    .limit(1)) as Array<typeof workspaceLicences.$inferSelect>;
  if (!existing) throw new LicenceError('NOT_FOUND', 'Licence not found');
  const snap = snapshotOf(existing);
  return upsertWorkspaceLicence({
    db: input.db,
    workspaceId: input.workspaceId,
    partnerId: input.partnerId,
    terms: snap,
    status: input.status,
    actor: input.actor,
    reason: input.reason,
  });
}

/**
 * Make the tenant's installed system apps match the licence: licensed apps are
 * installed (or re-activated), unlicensed ones soft-deactivated. Reversible and
 * data-preserving. WeldApps (`appType: 'user'`) are left alone.
 */
export async function syncInstalledAppsToLicence(input: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tenantDb: any;
  allowedApps: readonly string[];
  actorUserId: string | null;
}): Promise<{ installed: string[]; deactivated: string[] }> {
  const { tenantDb } = input;
  const allowed = new Set(input.allowedApps);
  const rows = (await tenantDb
    .select({
      id: workspaceInstalledApps.id,
      appCode: workspaceInstalledApps.appCode,
      isActive: workspaceInstalledApps.isActive,
      deletedAt: workspaceInstalledApps.deletedAt,
      appType: workspaceInstalledApps.appType,
    })
    .from(workspaceInstalledApps)) as Array<{
    id: string;
    appCode: string;
    isActive: boolean;
    deletedAt: Date | null;
    appType: string | null;
  }>;
  const byCode = new Map(rows.map((r) => [r.appCode, r]));
  const now = new Date();
  const installed: string[] = [];
  const deactivated: string[] = [];

  const [{ maxOrder } = { maxOrder: -1 }] = (await tenantDb
    .select({ maxOrder: max(workspaceInstalledApps.displayOrder) })
    .from(workspaceInstalledApps)) as Array<{ maxOrder: number | null }>;
  let nextOrder = (maxOrder ?? -1) + 1;

  for (const code of allowed) {
    const row = byCode.get(code);
    if (row && row.isActive && !row.deletedAt) continue;
    if (row) {
      await tenantDb
        .update(workspaceInstalledApps)
        .set({ isActive: true, deletedAt: null, installedAt: now, installedBy: input.actorUserId, updatedAt: now })
        .where(eq(workspaceInstalledApps.id, row.id));
    } else {
      await tenantDb.insert(workspaceInstalledApps).values({
        id: generateId('wia'),
        appCode: code,
        isActive: true,
        displayOrder: nextOrder++,
        settings: {},
        installedAt: now,
        installedBy: input.actorUserId,
      });
    }
    installed.push(code);
  }

  for (const row of rows) {
    if (allowed.has(row.appCode) || row.appType === 'user' || !row.isActive || row.deletedAt) continue;
    await tenantDb
      .update(workspaceInstalledApps)
      .set({ isActive: false, deletedAt: now, updatedAt: now })
      .where(and(eq(workspaceInstalledApps.id, row.id), isNull(workspaceInstalledApps.deletedAt)));
    deactivated.push(row.appCode);
  }

  return { installed, deactivated };
}

const DAY_MS = 86_400_000;

/** Whole days left in the UTC month of `now` (today included) and the month's length. */
export function monthRemainder(now: Date): { remainingDays: number; daysInMonth: number } {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const daysInMonth = Math.round((end - start) / DAY_MS);
  return { remainingDays: daysInMonth - now.getUTCDate() + 1, daysInMonth };
}

/**
 * Credits to grant for a monthly-credits increase of `delta` made at `now`:
 * the rest of the month, today included, rounded down. The statement bills a
 * day at the highest allowance in force that day, so today is billed at the new
 * level, and rounding down keeps what is granted at or under what is billed.
 */
export function proratedIncreaseGrant(delta: number, now: Date): number {
  if (delta <= 0) return 0;
  const { remainingDays, daysInMonth } = monthRemainder(now);
  return Math.floor((delta * remainingDays) / daysInMonth);
}

/**
 * Credits to take back for a decrease of `delta` made at `now`: the unused
 * part, i.e. the days AFTER today (today is still billed at the old, higher
 * level), rounded up so a raise-and-lower within one day never leaves more
 * credits granted than billed. The caller caps it at the available balance.
 */
export function proratedDecreaseTakeBack(delta: number, now: Date): number {
  if (delta <= 0) return 0;
  const { remainingDays, daysInMonth } = monthRemainder(now);
  return Math.ceil((delta * (remainingDays - 1)) / daysInMonth);
}

/**
 * Apply a licence's credit allowance to the wallet after a licence change. The
 * allocation columns follow the licence; the balance follows the statement,
 * which bills credits per UTC day (at the highest allowance of that day), so
 * the wallet moves by the prorated part of the change only:
 *
 * - increase: the delta for the rest of this month, today included (rounded down);
 * - decrease: the unused part of the delta (the days after today) is taken
 *   back, never more than the available balance, so the wallet never goes
 *   negative because of a licence change;
 * - a first licence is the same as an increase from nothing, and marks the
 *   wallet as reset this month so the daily sweep does not grant it again.
 *
 * When the monthly reset has not run yet this month (the 1st, before the
 * sweep), the reset itself grants the full new allowance, so nothing moves
 * here. Idempotent per licence change (`partner_licence:<changeId>`).
 */
export async function applyLicenceCredits(input: {
  db: PartnerDb;
  workspaceId: string;
  previousMonthlyCredits: number | null;
  monthlyCredits: number;
  creditRolloverCap: number;
  changeId: string;
  now?: Date;
}): Promise<{ granted: number; takenBack: number }> {
  const { db, workspaceId } = input;
  const now = input.now ?? new Date();
  const wallet = await getOrCreateWorkspaceCredits(db, workspaceId);
  const first = input.previousMonthlyCredits === null;
  const period = monthPeriod(now);
  const resetPending = !first && !hasResetSince(wallet, period.start);

  await db
    .update(workspaceCredits)
    .set({
      planCredits: input.monthlyCredits,
      subscribedCredits: 0,
      monthlyAllocation: input.monthlyCredits,
      rolloverCap: input.creditRolloverCap,
      ...(first ? { periodStart: period.start, periodEnd: period.end, lastResetAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(workspaceCredits.workspaceId, workspaceId));
  if (resetPending) return { granted: 0, takenBack: 0 };

  const delta = input.monthlyCredits - (input.previousMonthlyCredits ?? 0);
  const key = `partner_licence:${input.changeId}`;

  if (delta > 0) return grantLicenceIncrease({ db, workspaceId, delta, now, first, key, changeId: input.changeId });
  if (delta < 0) {
    return takeBackLicenceDecrease({
      db,
      workspaceId,
      delta,
      now,
      key,
      changeId: input.changeId,
      availableBalance: wallet.currentBalance,
    });
  }
  return { granted: 0, takenBack: 0 };
}

/** Whether the wallet's monthly reset already ran for the period starting at `periodStart`. */
function hasResetSince(wallet: { lastResetAt: Date | null; periodStart: Date | null }, periodStart: Date): boolean {
  return Boolean(wallet.lastResetAt && wallet.periodStart && wallet.periodStart.getTime() >= periodStart.getTime());
}

/** Grant the prorated part of a monthly-credits increase (`delta` > 0), once per `key`. */
async function grantLicenceIncrease(args: {
  db: PartnerDb;
  workspaceId: string;
  delta: number;
  now: Date;
  first: boolean;
  key: string;
  changeId: string;
}): Promise<{ granted: number; takenBack: number }> {
  const { db, workspaceId, delta, first } = args;
  const amount = proratedIncreaseGrant(delta, args.now);
  if (amount <= 0) return { granted: 0, takenBack: 0 };
  const grant = await grantCredits(db, {
    workspaceId,
    amount,
    type: first ? 'monthly_allocation' : 'adjustment',
    idempotencyKey: args.key,
    description: first
      ? `Licensed monthly credits, rest of the month: +${amount}`
      : `Licence credits increased by ${delta}, rest of the month: +${amount}`,
    metadata: { reason: 'partner_licence', changeId: args.changeId, delta, prorated: amount },
  });
  return { granted: grant.duplicate ? 0 : amount, takenBack: 0 };
}

/** Take back the unused part of a monthly-credits decrease (`delta` < 0), capped at the balance, once per `key`. */
async function takeBackLicenceDecrease(args: {
  db: PartnerDb;
  workspaceId: string;
  delta: number;
  now: Date;
  key: string;
  changeId: string;
  availableBalance: number;
}): Promise<{ granted: number; takenBack: number }> {
  const { db, workspaceId, delta } = args;
  const unused = proratedDecreaseTakeBack(-delta, args.now);
  const amount = Math.min(unused, Math.max(args.availableBalance, 0));
  if (amount <= 0) return { granted: 0, takenBack: 0 };
  const res = await grantCredits(db, {
    workspaceId,
    amount: -amount,
    type: 'adjustment',
    idempotencyKey: args.key,
    description: `Licence credits decreased by ${-delta}, unused part taken back: -${amount}`,
    metadata: { reason: 'partner_licence', changeId: args.changeId, delta, prorated: unused, takenBack: amount },
  });
  return { granted: 0, takenBack: res.duplicate ? 0 : amount };
}

/**
 * Monthly reset for a licensed workspace (idempotent per period): unused
 * credits above the rollover cap expire, then the allowance is granted. Debt
 * (a negative balance from settled calls) is carried, never forgiven. Extra
 * credits a partner granted belong to that month and follow the same rule.
 */
export async function resetLicensedCredits(input: {
  db: PartnerDb;
  workspaceId: string;
  monthlyCredits: number;
  creditRolloverCap: number;
  periodStart: Date;
  periodEnd: Date;
}): Promise<{ expired: number; granted: number; skipped: boolean }> {
  const { db, workspaceId, periodStart } = input;
  const credits = await getOrCreateWorkspaceCredits(db, workspaceId);
  if (credits.lastResetAt && credits.periodStart && credits.periodStart.getTime() >= periodStart.getTime()) {
    return { expired: 0, granted: 0, skipped: true };
  }
  const key = periodStart.toISOString();
  const keep = Math.min(Math.max(credits.currentBalance, 0), input.creditRolloverCap);
  const expire = Math.max(credits.currentBalance, 0) - keep;
  let expired = 0;
  if (expire > 0) {
    const res = await grantCredits(db, {
      workspaceId,
      amount: -expire,
      type: 'adjustment',
      idempotencyKey: `partner_expire:${workspaceId}:${key}`,
      description: `Unused credits expired: -${expire}`,
      metadata: { reason: 'credit_rollover_expired', periodStart: key },
    });
    if (!res.duplicate) expired = expire;
  }
  let granted = 0;
  if (input.monthlyCredits > 0) {
    const res = await grantCredits(db, {
      workspaceId,
      amount: input.monthlyCredits,
      type: 'monthly_allocation',
      idempotencyKey: `partner_grant:${workspaceId}:${key}`,
      description: `Monthly licensed credits: +${input.monthlyCredits}`,
      metadata: { reason: 'partner_monthly_grant', periodStart: key },
    });
    if (!res.duplicate) granted = input.monthlyCredits;
  }
  await db
    .update(workspaceCredits)
    .set({
      monthlyAllocation: input.monthlyCredits,
      planCredits: input.monthlyCredits,
      rolledOverCredits: keep,
      rolloverCap: input.creditRolloverCap,
      periodStart,
      periodEnd: input.periodEnd,
      lastResetAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(workspaceCredits.workspaceId, workspaceId));
  return { expired, granted, skipped: false };
}

/** Credits consumed in [from, to), as a positive number. */
export async function creditsUsedBetween(db: PartnerDb, workspaceId: string, from: Date, to: Date): Promise<number> {
  const { creditTransactions } = masterSchema;
  const [row] = (await db
    .select({ used: sql<string>`coalesce(sum(-${creditTransactions.amount}), 0)` })
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.workspaceId, workspaceId),
        eq(creditTransactions.type, 'consumption'),
        sql`${creditTransactions.createdAt} >= ${from}`,
        sql`${creditTransactions.createdAt} < ${to}`,
      ),
    )) as Array<{ used: string | number }>;
  return Math.max(0, Number(row?.used ?? 0));
}
