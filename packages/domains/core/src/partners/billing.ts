/**
 * Reseller licensing — billing services shared by billing-worker (statement
 * run, dunning sweep, admin console) and anything that needs to know whether a
 * workspace is partner-billed. See index.ts.
 *
 * Everything here reads/writes the master DB through the loosely typed
 * `PartnerDb` handle. The decision logic (`evaluateDunning`) is pure so it can
 * be tested without a database; Stripe and email live in billing-worker.
 */

import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import {
  dunningStage,
  partnerStatusForStage,
  type DunningStage,
  type LicenceSnapshot,
  type PartnerContractView,
  type PartnerStatementView,
  type PartnerStatus,
} from '@weldsuite/app-api-client/schemas/partners';
import { getActiveContract, snapshotOf } from './licences';
import { setPartnerStatus } from './partners';
import type { PartnerDb } from './types';

const { partners, partnerMembers, partnerTerritories, partnerStatements, workspaces, workspaceLicences } = masterSchema;

type PartnerStatementRow = typeof partnerStatements.$inferSelect;
type PartnerContractRow = typeof masterSchema.partnerContracts.$inferSelect;
type WorkspaceLicenceRow = typeof workspaceLicences.$inferSelect;

// ---------------------------------------------------------------------------
// Row → view mapping (admin console, portal)
// ---------------------------------------------------------------------------

export function partnerContractToView(c: PartnerContractRow): PartnerContractView {
  return {
    id: c.id,
    effectiveFrom: c.effectiveFrom.toISOString(),
    effectiveTo: c.effectiveTo?.toISOString() ?? null,
    currency: c.currency,
    revenueShareBps: c.revenueShareBps,
    baseMinimum: c.baseMinimum,
    includedCredits: c.includedCredits,
    creditFloorPrice: c.creditFloorPrice,
    extraCreditPrice: c.extraCreditPrice,
    allowedFeaturePlanIds: c.allowedFeaturePlanIds,
    paymentTermsDays: c.paymentTermsDays,
    pastDueAfterDays: c.pastDueAfterDays,
    readOnlyAfterDays: c.readOnlyAfterDays,
  };
}

/** A saved statement without its lines (lists). */
export function statementSummaryView(s: PartnerStatementRow): PartnerStatementView {
  return {
    id: s.id,
    periodStart: s.periodStart.toISOString(),
    periodEnd: s.periodEnd.toISOString(),
    currency: s.currency,
    status: s.status,
    totalResale: s.totalResale,
    totalDue: s.totalDue,
    totalMargin: s.totalMargin,
    stripeInvoiceUrl: s.stripeInvoiceUrl,
    stripeInvoicePdf: s.stripeInvoicePdf,
    dueAt: s.dueAt?.toISOString() ?? null,
    paidAt: s.paidAt?.toISOString() ?? null,
    lines: [],
  };
}

/** A licence row as the snapshot plus its dates. */
export function licenceRowView(l: WorkspaceLicenceRow): LicenceSnapshot & { startsAt: string; endsAt: string | null } {
  return { ...snapshotOf(l), startsAt: l.startsAt.toISOString(), endsAt: l.endsAt?.toISOString() ?? null };
}

// ---------------------------------------------------------------------------
// Managed-workspace lookups
// ---------------------------------------------------------------------------

/** True when the workspace is billed by a partner (`billingMode = 'partner'`). */
export async function isPartnerManagedWorkspace(db: PartnerDb, workspaceId: string): Promise<boolean> {
  const [row] = (await db
    .select({ billingMode: workspaces.billingMode })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)) as Array<{ billingMode: string }>;
  return row?.billingMode === 'partner';
}

/**
 * The seat cap of a partner-managed workspace: `licence.maxSeats` (null =
 * unlimited). `{ managed: false }` for direct workspaces, whose cap comes from
 * the plan.
 */
export async function managedSeatCap(
  db: PartnerDb,
  workspaceId: string,
): Promise<{ managed: false } | { managed: true; maxSeats: number | null }> {
  const [row] = (await db
    .select({ billingMode: workspaces.billingMode, maxSeats: workspaceLicences.maxSeats })
    .from(workspaces)
    .leftJoin(workspaceLicences, eq(workspaceLicences.workspaceId, workspaces.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1)) as Array<{ billingMode: string; maxSeats: number | null }>;
  if (row?.billingMode !== 'partner') return { managed: false };
  return { managed: true, maxSeats: row.maxSeats ?? null };
}

/** Partners that have at least one workspace licence (the monthly statement run). */
export async function partnerIdsWithLicences(db: PartnerDb): Promise<string[]> {
  const rows = (await db.selectDistinct({ partnerId: workspaceLicences.partnerId }).from(workspaceLicences)) as Array<{
    partnerId: string;
  }>;
  return rows.map((r) => r.partnerId);
}

export interface ActiveLicenceForReset {
  workspaceId: string;
  clerkOrgId: string | null;
  monthlyCredits: number;
  creditRolloverCap: number;
}

/** Active licences of live partner workspaces (the daily credit reset). */
export async function listActiveLicencesForReset(db: PartnerDb): Promise<ActiveLicenceForReset[]> {
  return (await db
    .select({
      workspaceId: workspaceLicences.workspaceId,
      clerkOrgId: workspaces.clerkOrgId,
      monthlyCredits: workspaceLicences.monthlyCredits,
      creditRolloverCap: workspaceLicences.creditRolloverCap,
    })
    .from(workspaceLicences)
    .innerJoin(workspaces, eq(workspaces.id, workspaceLicences.workspaceId))
    .where(
      and(
        eq(workspaceLicences.status, 'active'),
        eq(workspaces.billingMode, 'partner'),
        isNull(workspaces.deletedAt),
      ),
    )) as ActiveLicenceForReset[];
}

/** Countries in `countries` that belong to a partner other than `partnerId`. */
export async function findTerritoryConflicts(
  db: PartnerDb,
  partnerId: string | null,
  countries: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(countries.map((c) => c.toUpperCase()))];
  if (wanted.length === 0) return [];
  const taken = (await db
    .select({ country: partnerTerritories.countryCode, partnerId: partnerTerritories.partnerId })
    .from(partnerTerritories)
    .where(inArray(partnerTerritories.countryCode, wanted))) as Array<{ country: string; partnerId: string }>;
  return taken.filter((t) => t.partnerId !== partnerId).map((t) => t.country).sort();
}

// ---------------------------------------------------------------------------
// Dunning
// ---------------------------------------------------------------------------

const DUNNING_RANK: Record<DunningStage, number> = { current: 0, past_due: 1, final_warning: 2, suspended: 3 };

/** The contract defaults when neither the statement nor a contract says otherwise. */
export const DEFAULT_DUNNING_DAYS = { pastDueAfterDays: 14, readOnlyAfterDays: 30 } as const;

export interface DunningStatement {
  id: string;
  dueAt: Date | null;
  /** The terms the statement was priced with; its dunning days win over the current contract. */
  contractSnapshot?: Record<string, unknown> | null;
}

export interface DunningState {
  stage: DunningStage;
  daysOverdue: number;
  /** The partner status this stage maps to. */
  status: PartnerStatus;
  /** The statement driving the stage (the worst one), null when nothing is open. */
  statementId: string | null;
  dueAt: Date | null;
  pastDueAfterDays: number;
  readOnlyAfterDays: number;
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Where a partner stands: the worst stage across its unpaid statements. Each
 * statement is judged on the dunning days it was priced with (falling back to
 * `fallback`, the contract in force). A staff pause holds the clock at
 * `current`. Pure.
 */
export function evaluateDunning(input: {
  statements: readonly DunningStatement[];
  fallback: { pastDueAfterDays: number; readOnlyAfterDays: number };
  pausedUntil?: Date | null;
  now: Date;
}): DunningState {
  let worst: DunningState = {
    stage: 'current',
    daysOverdue: 0,
    status: 'active',
    statementId: null,
    dueAt: null,
    pastDueAfterDays: input.fallback.pastDueAfterDays,
    readOnlyAfterDays: input.fallback.readOnlyAfterDays,
  };
  for (const s of input.statements) {
    if (!s.dueAt) continue;
    const snap = s.contractSnapshot ?? {};
    let pastDueAfterDays = positiveInt(snap.pastDueAfterDays) ?? input.fallback.pastDueAfterDays;
    let readOnlyAfterDays = positiveInt(snap.readOnlyAfterDays) ?? input.fallback.readOnlyAfterDays;
    if (readOnlyAfterDays <= pastDueAfterDays) {
      pastDueAfterDays = input.fallback.pastDueAfterDays;
      readOnlyAfterDays = input.fallback.readOnlyAfterDays;
    }
    const { stage, daysOverdue } = dunningStage({
      dueAt: s.dueAt,
      now: input.now,
      pastDueAfterDays,
      readOnlyAfterDays,
      pausedUntil: input.pausedUntil,
    });
    const better =
      DUNNING_RANK[stage] > DUNNING_RANK[worst.stage] ||
      (stage === worst.stage && daysOverdue > worst.daysOverdue) ||
      worst.statementId === null;
    if (better) {
      worst = {
        stage,
        daysOverdue,
        status: partnerStatusForStage(stage),
        statementId: s.id,
        dueAt: s.dueAt,
        pastDueAfterDays,
        readOnlyAfterDays,
      };
    }
  }
  return worst;
}

/** Partners with at least one unpaid (invoiced) statement: the dunning sweep's worklist. */
export async function partnerIdsWithOpenStatements(db: PartnerDb): Promise<string[]> {
  const rows = (await db
    .selectDistinct({ partnerId: partnerStatements.partnerId })
    .from(partnerStatements)
    .where(eq(partnerStatements.status, 'invoiced'))) as Array<{ partnerId: string }>;
  return rows.map((r) => r.partnerId);
}

/** Unpaid statements per partner whose due date has passed. */
export async function overdueStatementCounts(db: PartnerDb, now: Date = new Date()): Promise<Map<string, number>> {
  const rows = (await db
    .select({ partnerId: partnerStatements.partnerId, count: sql<number>`count(*)::int` })
    .from(partnerStatements)
    .where(and(eq(partnerStatements.status, 'invoiced'), lt(partnerStatements.dueAt, now)))
    .groupBy(partnerStatements.partnerId)) as Array<{ partnerId: string; count: number }>;
  return new Map(rows.map((r) => [r.partnerId, Number(r.count)]));
}

export interface PartnerStatusEvaluation {
  state: DunningState;
  /** The partner's status before this evaluation. */
  previousStatus: PartnerStatus;
  /** True when the stored status was changed. */
  changed: boolean;
  /** The unpaid statements the state was derived from. */
  openStatements: Array<typeof partnerStatements.$inferSelect>;
}

/**
 * Recompute a partner's payment status from its unpaid statements and store
 * it: the worst stage wins, a staff pause holds the clock, and a partner with
 * nothing overdue is `active` again. Used by the daily sweep, the
 * `invoice.paid` webhook and statement voids. Callers invalidate the workspace
 * caches when `changed`.
 */
export async function recomputePartnerStatus(
  db: PartnerDb,
  partnerId: string,
  now: Date = new Date(),
): Promise<PartnerStatusEvaluation | null> {
  const [partner] = (await db.select().from(partners).where(eq(partners.id, partnerId)).limit(1)) as Array<
    typeof partners.$inferSelect
  >;
  if (!partner) return null;
  const open = (await db
    .select()
    .from(partnerStatements)
    .where(and(eq(partnerStatements.partnerId, partnerId), eq(partnerStatements.status, 'invoiced')))) as Array<
    typeof partnerStatements.$inferSelect
  >;
  const contract = await getActiveContract(db, partnerId, now);
  const fallback = contract
    ? { pastDueAfterDays: contract.pastDueAfterDays, readOnlyAfterDays: contract.readOnlyAfterDays }
    : { ...DEFAULT_DUNNING_DAYS };
  const state = evaluateDunning({
    statements: open.map((s) => ({ id: s.id, dueAt: s.dueAt, contractSnapshot: s.contractSnapshot })),
    fallback,
    pausedUntil: partner.dunningPausedUntil,
    now,
  });
  const changed = await setPartnerStatus(db, partnerId, state.status);
  return { state, previousStatus: partner.status, changed, openStatements: open };
}

/**
 * Mark a statement paid from its Stripe invoice. Only an invoiced statement
 * moves (a replayed webhook, or a voided statement, is a no-op → null).
 */
export async function markStatementPaidByInvoice(
  db: PartnerDb,
  stripeInvoiceId: string,
  paidAt: Date,
): Promise<{ partnerId: string; statementId: string } | null> {
  const rows = (await db
    .update(partnerStatements)
    .set({ status: 'paid', paidAt, updatedAt: new Date() })
    .where(
      and(eq(partnerStatements.stripeInvoiceId, stripeInvoiceId), inArray(partnerStatements.status, ['invoiced', 'final'])),
    )
    .returning({ id: partnerStatements.id, partnerId: partnerStatements.partnerId })) as Array<{
    id: string;
    partnerId: string;
  }>;
  const row = rows[0];
  return row ? { partnerId: row.partnerId, statementId: row.id } : null;
}

/** True when a Stripe invoice belongs to a partner statement (it has no workspace). */
export async function isPartnerStatementInvoice(
  db: PartnerDb,
  stripeInvoiceId: string,
  stripeCustomerId?: string | null,
): Promise<boolean> {
  const [statement] = (await db
    .select({ id: partnerStatements.id })
    .from(partnerStatements)
    .where(eq(partnerStatements.stripeInvoiceId, stripeInvoiceId))
    .limit(1)) as Array<{ id: string }>;
  if (statement) return true;
  if (!stripeCustomerId) return false;
  const [partner] = (await db
    .select({ id: partners.id })
    .from(partners)
    .where(eq(partners.stripeCustomerId, stripeCustomerId))
    .limit(1)) as Array<{ id: string }>;
  return Boolean(partner);
}

/**
 * Where a partner's billing mail goes: its billing email plus every owner and
 * billing member, lower-cased and de-duplicated.
 */
export async function partnerBillingRecipients(db: PartnerDb, partnerId: string): Promise<string[]> {
  const [partner] = (await db
    .select({ billingEmail: partners.billingEmail })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1)) as Array<{ billingEmail: string }>;
  const members = (await db
    .select({ email: partnerMembers.email })
    .from(partnerMembers)
    .where(and(eq(partnerMembers.partnerId, partnerId), inArray(partnerMembers.role, ['owner', 'billing'])))) as Array<{
    email: string;
  }>;
  const all = [partner?.billingEmail, ...members.map((m) => m.email)]
    .map((e) => e?.trim().toLowerCase())
    .filter((e): e is string => Boolean(e));
  return [...new Set(all)];
}
