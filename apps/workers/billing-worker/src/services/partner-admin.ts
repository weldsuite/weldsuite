/**
 * Reseller partner operations behind the admin console
 * (routes/admin-partners.ts, `/api/internal/admin/partners/*`).
 *
 * Reseller licensing: docs/plans/reseller-licensing.md. The master-DB write
 * paths are the shared ones in @weldsuite/core-domain/partners (the same ones
 * the partner portal uses); this file adds what only staff do: create a
 * partner with its Stripe customer, contracts, territories, members, status
 * overrides, and attach/detach of existing workspaces.
 *
 * Every function takes the AdminContext (env, master DB, acting admin,
 * request id) and throws AdminBillingError / LicenceError /
 * TerritoryConflictError, which the route maps to HTTP.
 */

import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  TerritoryConflictError,
  applyLicenceCredits,
  buildStatement,
  builtStatementView,
  findTerritoryConflicts,
  getPartner,
  invalidateWorkspaceContexts,
  inviteMember,
  licenceRowView,
  listStatements,
  overdueStatementCounts,
  partnerContractToView,
  recomputePartnerStatus,
  setLicenceStatus,
  setPartnerStatus,
  setTerritories,
  statementSummaryView,
  syncInstalledAppsToLicence,
  upsertWorkspaceLicence,
  validateLicenceTerms,
} from '@weldsuite/core-domain/partners';
import {
  monthPeriod,
  type CreatePartnerInput,
  type LicenceTerms,
  type PartnerContractInput,
  type PartnerMemberRole,
  type PartnerProfileInput,
  type PartnerStatementView,
  type WorkspaceLicenceInput,
} from '@weldsuite/app-api-client/schemas/partners';
import type { Env } from '../index';
import { getMasterDb, masterSchema } from '../lib/db';
import { getTenantDbForWorkspace } from '../lib/tenant-db';
import { generateId } from '../lib/id';
import { trySyncClerkSeatLimit } from '../lib/clerk';
import { createStripeCustomer, updateStripeCustomer } from '../lib/stripe';
import { cancelSubscriptionNow, retrieveSubscriptionForAdmin, setCancelAtPeriodEnd } from '../lib/stripe-admin';
import { AdminBillingError, type AdminContext } from './admin-billing';
import { applySubscriptionEnded } from './subscription-policy';
import { sendPartnerInvitationEmail } from './partner-mail';
import {
  invalidatePartnerWorkspaceCaches,
  parsePeriod,
  runPartnerStatement,
  statementViewFor,
  voidPartnerStatement,
  type RunStatementResult,
} from './partner-billing';

const {
  partners,
  partnerMembers,
  partnerContracts,
  partnerTerritories,
  workspaces,
  workspaceLicences,
  plans,
} = masterSchema;

type MasterDb = ReturnType<typeof getMasterDb>;
type PartnerRow = typeof partners.$inferSelect;
type WorkspaceRow = typeof workspaces.$inferSelect;

function idem(ctx: AdminContext, action: string): string {
  return `admin:${action}:${ctx.requestId}`;
}

/** The id the audit trail and licence history record for the acting admin. */
function actorId(ctx: AdminContext): string {
  return ctx.actor.userId ?? ctx.actor.email;
}

async function requirePartner(masterDb: MasterDb, partnerId: string): Promise<PartnerRow> {
  const partner = await getPartner(masterDb, partnerId);
  if (!partner) throw new AdminBillingError('NOT_FOUND', 'Partner not found');
  return partner;
}

/** A workspace by master id or Clerk org id. */
async function findWorkspace(masterDb: MasterDb, idOrOrgId: string): Promise<WorkspaceRow> {
  const [workspace] = await masterDb
    .select()
    .from(workspaces)
    .where(or(eq(workspaces.id, idOrOrgId), eq(workspaces.clerkOrgId, idOrOrgId)))
    .limit(1);
  if (!workspace) throw new AdminBillingError('NOT_FOUND', 'Workspace not found');
  if (workspace.deletedAt) throw new AdminBillingError('CONFLICT', 'This workspace has been deleted');
  return workspace;
}

async function requirePartnerWorkspace(masterDb: MasterDb, partnerId: string, workspaceId: string): Promise<WorkspaceRow> {
  const [workspace] = await masterDb
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.partnerId, partnerId)))
    .limit(1);
  if (!workspace) throw new AdminBillingError('NOT_FOUND', 'This partner has no such workspace');
  return workspace;
}

/** Feature plans a contract allows must exist. */
async function assertPlansExist(masterDb: MasterDb, planIds: readonly string[]): Promise<void> {
  if (planIds.length === 0) return;
  const rows = await masterDb
    .select({ id: plans.id })
    .from(plans)
    .where(and(inArray(plans.id, [...planIds]), isNull(plans.deletedAt)));
  const known = new Set(rows.map((r) => r.id));
  const missing = planIds.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new AdminBillingError('BAD_REQUEST', `Unknown feature plans: ${missing.join(', ')}`);
  }
}

// ============================================================================
// Read
// ============================================================================

export async function listPartners(masterDb: MasterDb) {
  const [rows, workspaceCounts, territoryRows, overdue] = await Promise.all([
    masterDb.select().from(partners).orderBy(asc(partners.name)),
    masterDb
      .select({ partnerId: workspaces.partnerId, count: sql<number>`count(*)::int` })
      .from(workspaces)
      .where(and(eq(workspaces.billingMode, 'partner'), isNull(workspaces.deletedAt)))
      .groupBy(workspaces.partnerId),
    masterDb
      .select({ partnerId: partnerTerritories.partnerId, country: partnerTerritories.countryCode })
      .from(partnerTerritories)
      .orderBy(asc(partnerTerritories.countryCode)),
    overdueStatementCounts(masterDb),
  ]);
  const counts = new Map(workspaceCounts.map((r) => [r.partnerId, Number(r.count)]));
  const territories = new Map<string, string[]>();
  for (const t of territoryRows) territories.set(t.partnerId, [...(territories.get(t.partnerId) ?? []), t.country]);
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    billingEmail: p.billingEmail,
    workspaceCount: counts.get(p.id) ?? 0,
    territories: territories.get(p.id) ?? [],
    overdueStatementCount: overdue.get(p.id) ?? 0,
    createdAt: p.createdAt.toISOString(),
  }));
}

export async function getPartnerDetail(masterDb: MasterDb, partnerId: string) {
  const partner = await requirePartner(masterDb, partnerId);
  const [contracts, territoryRows, members, workspaceRows, statements] = await Promise.all([
    masterDb.select().from(partnerContracts).where(eq(partnerContracts.partnerId, partnerId)).orderBy(desc(partnerContracts.effectiveFrom)),
    masterDb
      .select({ country: partnerTerritories.countryCode })
      .from(partnerTerritories)
      .where(eq(partnerTerritories.partnerId, partnerId))
      .orderBy(asc(partnerTerritories.countryCode)),
    masterDb.select().from(partnerMembers).where(eq(partnerMembers.partnerId, partnerId)).orderBy(asc(partnerMembers.createdAt)),
    masterDb
      .select({ workspace: workspaces, licence: workspaceLicences })
      .from(workspaceLicences)
      .innerJoin(workspaces, eq(workspaces.id, workspaceLicences.workspaceId))
      .where(eq(workspaceLicences.partnerId, partnerId))
      .orderBy(asc(workspaces.name)),
    listStatements(masterDb, partnerId),
  ]);
  return {
    partner,
    contracts: contracts.map(partnerContractToView),
    territories: territoryRows.map((t) => t.country),
    members: members.map((m) => ({
      id: m.id,
      email: m.email,
      role: m.role,
      userId: m.userId,
      acceptedAt: m.acceptedAt?.toISOString() ?? null,
      invitedBy: m.invitedBy,
      createdAt: m.createdAt.toISOString(),
    })),
    workspaces: workspaceRows.map((r) => ({
      workspaceId: r.workspace.id,
      name: r.workspace.name,
      slug: r.workspace.slug,
      billingMode: r.workspace.billingMode,
      licence: licenceRowView(r.licence),
    })),
    statements: statements.map(statementSummaryView),
  };
}

// ============================================================================
// Create / update
// ============================================================================

/**
 * Create a partner: Stripe customer, profile, first contract, territories and
 * the owner's portal invitation. The Stripe customer is created first (keyed
 * on the request, so a retry reuses it); everything in the DB is one
 * transaction, so a territory conflict or bad plan leaves nothing behind.
 */
export async function createPartner(ctx: AdminContext, input: CreatePartnerInput) {
  const { masterDb } = ctx;
  const { contract, territories, ownerEmail, ...profile } = input;

  const conflicts = await findTerritoryConflicts(masterDb, null, territories);
  if (conflicts.length > 0) throw new TerritoryConflictError(conflicts);
  await assertPlansExist(masterDb, contract.allowedFeaturePlanIds);

  const partnerId = generateId('ptr');
  const stripeCustomerId = await createPartnerStripeCustomer(ctx, partnerId, profile);

  const effectiveFrom = contract.effectiveFrom ? new Date(contract.effectiveFrom) : new Date();
  const partner = await masterDb.transaction(async (tx) => {
    const [row] = await tx
      .insert(partners)
      .values({
        id: partnerId,
        name: profile.name,
        legalName: profile.legalName ?? null,
        country: profile.country ?? null,
        taxId: profile.taxId ?? null,
        billingEmail: profile.billingEmail,
        supportEmail: profile.supportEmail ?? null,
        supportUrl: profile.supportUrl ?? null,
        websiteUrl: profile.websiteUrl ?? null,
        logoUrl: profile.logoUrl ?? null,
        stripeCustomerId,
      })
      .returning();
    await tx.insert(partnerContracts).values({ id: generateId('ptc'), partnerId, ...contractValues(contract, effectiveFrom, ctx) });
    await setTerritories(tx, partnerId, territories);
    await inviteMember(tx, { partnerId, email: ownerEmail, role: 'owner', invitedBy: ctx.actor.email });
    return row!;
  });

  await sendPartnerInvitationEmail(ctx.env, { to: ownerEmail, partnerName: partner.name, role: 'owner', country: partner.country });
  return partner;
}

async function createPartnerStripeCustomer(
  ctx: AdminContext,
  partnerId: string,
  profile: Pick<PartnerProfileInput, 'name' | 'legalName' | 'billingEmail' | 'country'>,
): Promise<string> {
  if (!ctx.env.STRIPE_SECRET_KEY) throw new AdminBillingError('NOT_CONFIGURED', 'Stripe is not configured');
  const customer = (await createStripeCustomer(
    ctx.env.STRIPE_SECRET_KEY,
    {
      name: profile.legalName || profile.name,
      email: profile.billingEmail,
      metadata: { partnerId, kind: 'partner' },
    },
    idem(ctx, 'partner.customer'),
  )) as { id: string };
  if (profile.country) {
    try {
      await updateStripeCustomer(ctx.env.STRIPE_SECRET_KEY, customer.id, { address: { country: profile.country } });
    } catch (err) {
      console.warn(`[Admin Partners] Could not set the country of Stripe customer ${customer.id}:`, err);
    }
  }
  return customer.id;
}

function contractValues(contract: PartnerContractInput, effectiveFrom: Date, ctx: AdminContext) {
  return {
    effectiveFrom,
    effectiveTo: null,
    currency: contract.currency,
    revenueShareBps: contract.revenueShareBps,
    baseMinimum: contract.baseMinimum,
    includedCredits: contract.includedCredits,
    creditFloorPrice: contract.creditFloorPrice,
    extraCreditPrice: contract.extraCreditPrice,
    allowedFeaturePlanIds: contract.allowedFeaturePlanIds,
    paymentTermsDays: contract.paymentTermsDays,
    pastDueAfterDays: contract.pastDueAfterDays,
    readOnlyAfterDays: contract.readOnlyAfterDays,
    notes: contract.notes ?? null,
    createdBy: ctx.actor.email,
  };
}

const PROFILE_KEYS = [
  'name',
  'legalName',
  'country',
  'taxId',
  'billingEmail',
  'supportEmail',
  'supportUrl',
  'websiteUrl',
  'logoUrl',
] as const;

export async function updatePartner(ctx: AdminContext, partnerId: string, patch: Partial<PartnerProfileInput>) {
  const { masterDb } = ctx;
  const partner = await requirePartner(masterDb, partnerId);
  const set: Record<string, unknown> = {};
  for (const key of PROFILE_KEYS) {
    if (patch[key] !== undefined) set[key] = patch[key];
  }
  if (Object.keys(set).length === 0) throw new AdminBillingError('BAD_REQUEST', 'Nothing to change');
  const [updated] = await masterDb
    .update(partners)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(partners.id, partnerId))
    .returning();

  if (partner.stripeCustomerId && ctx.env.STRIPE_SECRET_KEY && ('name' in set || 'legalName' in set || 'billingEmail' in set)) {
    try {
      await updateStripeCustomer(ctx.env.STRIPE_SECRET_KEY, partner.stripeCustomerId, {
        name: updated!.legalName || updated!.name,
        email: updated!.billingEmail,
      });
    } catch (err) {
      console.warn(`[Admin Partners] Could not update Stripe customer ${partner.stripeCustomerId}:`, err);
    }
  }
  return updated!;
}

// ============================================================================
// Contracts
// ============================================================================

/**
 * A new effective-dated contract. The one in force is closed at the new
 * `effectiveFrom` (default now); contracts are never edited in place.
 */
export async function addContract(ctx: AdminContext, partnerId: string, input: PartnerContractInput) {
  const { masterDb } = ctx;
  await requirePartner(masterDb, partnerId);
  await assertPlansExist(masterDb, input.allowedFeaturePlanIds);
  const from = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();

  const existing = await masterDb.select().from(partnerContracts).where(eq(partnerContracts.partnerId, partnerId));
  const latest = existing.reduce<Date | null>((max, c) => (!max || c.effectiveFrom > max ? c.effectiveFrom : max), null);
  if (latest && from.getTime() <= latest.getTime()) {
    throw new AdminBillingError(
      'BAD_REQUEST',
      `A new contract must start after the current one starts (${latest.toISOString().slice(0, 10)}).`,
    );
  }

  return masterDb.transaction(async (tx) => {
    await tx
      .update(partnerContracts)
      .set({ effectiveTo: from })
      .where(
        and(eq(partnerContracts.partnerId, partnerId), or(isNull(partnerContracts.effectiveTo), gt(partnerContracts.effectiveTo, from))),
      );
    const [row] = await tx
      .insert(partnerContracts)
      .values({ id: generateId('ptc'), partnerId, ...contractValues(input, from, ctx) })
      .returning();
    return partnerContractToView(row!);
  });
}

// ============================================================================
// Territories
// ============================================================================

export async function replaceTerritories(ctx: AdminContext, partnerId: string, countries: readonly string[]): Promise<string[]> {
  const { masterDb } = ctx;
  await requirePartner(masterDb, partnerId);
  await masterDb.transaction(async (tx) => {
    await setTerritories(tx, partnerId, countries);
  });
  const rows = await masterDb
    .select({ country: partnerTerritories.countryCode })
    .from(partnerTerritories)
    .where(eq(partnerTerritories.partnerId, partnerId))
    .orderBy(asc(partnerTerritories.countryCode));
  return rows.map((r) => r.country);
}

// ============================================================================
// Members
// ============================================================================

async function ownerCount(masterDb: MasterDb, partnerId: string): Promise<number> {
  const [row] = await masterDb
    .select({ count: sql<number>`count(*)::int` })
    .from(partnerMembers)
    .where(and(eq(partnerMembers.partnerId, partnerId), eq(partnerMembers.role, 'owner')));
  return Number(row?.count ?? 0);
}

export async function addMember(ctx: AdminContext, partnerId: string, input: { email: string; role: PartnerMemberRole }) {
  const { masterDb } = ctx;
  const partner = await requirePartner(masterDb, partnerId);
  const email = input.email.trim().toLowerCase();
  const [existing] = await masterDb
    .select()
    .from(partnerMembers)
    .where(and(eq(partnerMembers.partnerId, partnerId), eq(partnerMembers.email, email)))
    .limit(1);
  if (existing?.role === 'owner' && input.role !== 'owner' && (await ownerCount(masterDb, partnerId)) <= 1) {
    throw new AdminBillingError('CONFLICT', 'The last owner cannot be demoted. Invite another owner first.');
  }
  const member = await inviteMember(masterDb, { partnerId, email, role: input.role, invitedBy: ctx.actor.email });
  if (!existing) {
    await sendPartnerInvitationEmail(ctx.env, { to: email, partnerName: partner.name, role: input.role, country: partner.country });
  }
  return {
    id: member.id,
    email: member.email,
    role: member.role,
    userId: member.userId,
    acceptedAt: member.acceptedAt?.toISOString() ?? null,
    createdAt: member.createdAt.toISOString(),
  };
}

export async function removeMember(ctx: AdminContext, partnerId: string, memberId: string): Promise<{ id: string; email: string }> {
  const { masterDb } = ctx;
  const [member] = await masterDb
    .select()
    .from(partnerMembers)
    .where(and(eq(partnerMembers.id, memberId), eq(partnerMembers.partnerId, partnerId)))
    .limit(1);
  if (!member) throw new AdminBillingError('NOT_FOUND', 'Member not found');
  if (member.role === 'owner' && (await ownerCount(masterDb, partnerId)) <= 1) {
    throw new AdminBillingError('CONFLICT', 'The last owner cannot be removed. Invite another owner first.');
  }
  await masterDb.delete(partnerMembers).where(eq(partnerMembers.id, memberId));
  return { id: member.id, email: member.email };
}

// ============================================================================
// Payment status override
// ============================================================================

/**
 * Staff override of a partner's payment standing: set the status now, and/or
 * pause the dunning clock (`dunningPausedUntil`, null clears). A pause on its
 * own re-evaluates the partner at once, so pausing lifts a suspension.
 *
 * Note for the console: the daily dunning sweep converges `status` to what the
 * unpaid statements say. A status set by hand therefore holds only for
 * partners with no unpaid statements (or until the next sweep); pausing the
 * clock is the lasting way to hold a partner back.
 */
export async function setStatusOverride(
  ctx: AdminContext,
  partnerId: string,
  input: { status?: PartnerRow['status']; dunningPausedUntil?: string | null },
) {
  const { masterDb, env } = ctx;
  const before = await requirePartner(masterDb, partnerId);
  if (input.status === undefined && input.dunningPausedUntil === undefined) {
    throw new AdminBillingError('BAD_REQUEST', 'Give a status, a pause date, or both');
  }

  if (input.dunningPausedUntil !== undefined) {
    await masterDb
      .update(partners)
      .set({ dunningPausedUntil: input.dunningPausedUntil ? new Date(input.dunningPausedUntil) : null, updatedAt: new Date() })
      .where(eq(partners.id, partnerId));
  }
  let changed = false;
  if (input.status !== undefined) {
    changed = await setPartnerStatus(masterDb, partnerId, input.status);
  } else {
    changed = Boolean((await recomputePartnerStatus(masterDb, partnerId))?.changed);
  }
  const after = await requirePartner(masterDb, partnerId);
  if (changed || before.dunningPausedUntil?.getTime() !== after.dunningPausedUntil?.getTime()) {
    await invalidatePartnerWorkspaceCaches(env, masterDb, partnerId);
  }
  return after;
}

// ============================================================================
// Licences, attach and detach
// ============================================================================

interface LicenceChangeOutcome {
  licence: ReturnType<typeof licenceRowView>;
  changeId: string;
  warnings: string[];
}

/**
 * The admin licence write path, the portal's flow with the admin as actor:
 * validate against the contract, write the licence and its history row, make
 * the tenant's installed apps match, apply the credit allowance, set the Clerk
 * seat cap and drop the cached workspace context. A failing tenant or Clerk
 * step does not undo the licence (it is the source of truth and the next
 * change re-applies the rest): it comes back as a warning.
 */
async function writeLicence(
  ctx: AdminContext,
  input: {
    workspace: WorkspaceRow;
    partnerId: string;
    terms: LicenceTerms;
    packageId: string | null;
    reason: string | null;
  },
): Promise<LicenceChangeOutcome> {
  const { masterDb, env } = ctx;
  const { workspace, partnerId, terms } = input;
  await validateLicenceTerms(masterDb, partnerId, terms);
  const { licence, previous, changeId } = await upsertWorkspaceLicence({
    db: masterDb,
    workspaceId: workspace.id,
    partnerId,
    terms,
    packageId: input.packageId,
    actor: { id: actorId(ctx), type: 'admin' },
    reason: input.reason,
  });

  const warnings: string[] = [];
  try {
    const tenantDb = await getTenantDbForWorkspace(env, workspace.id);
    await syncInstalledAppsToLicence({ tenantDb, allowedApps: terms.allowedApps, actorUserId: ctx.actor.userId });
  } catch (err) {
    console.error(`[Admin Partners] Installed-app sync failed for workspace ${workspace.id}:`, err);
    warnings.push('The licence was saved, but the workspace\'s installed apps could not be updated. Save the licence again to retry.');
  }
  try {
    await applyLicenceCredits({
      db: masterDb,
      workspaceId: workspace.id,
      previousMonthlyCredits: previous ? previous.monthlyCredits : null,
      monthlyCredits: licence.monthlyCredits,
      creditRolloverCap: licence.creditRolloverCap,
      changeId,
    });
  } catch (err) {
    console.error(`[Admin Partners] Licence credits failed for workspace ${workspace.id}:`, err);
    warnings.push('The licence was saved, but its credits could not be applied. The daily credit reset will pick them up.');
  }
  await trySyncClerkSeatLimit(env, masterDb, workspace.clerkOrgId, workspace.id, null, 0, 'partner licence change');
  await invalidateWorkspaceContexts(env.WORKSPACE_CACHE, [workspace.clerkOrgId]);
  return { licence: licenceRowView(licence), changeId, warnings };
}

/** Admin override of a managed workspace's licence. */
export async function setWorkspaceLicence(ctx: AdminContext, partnerId: string, workspaceId: string, input: WorkspaceLicenceInput) {
  const { masterDb } = ctx;
  await requirePartner(masterDb, partnerId);
  const workspace = await requirePartnerWorkspace(masterDb, partnerId, workspaceId);
  const { packageId, reason, ...terms } = input;
  const outcome = await writeLicence(ctx, { workspace, partnerId, terms, packageId, reason: reason ?? ctx.reason ?? null });
  return { ...outcome.licence, ...(outcome.warnings.length ? { warnings: outcome.warnings } : {}) };
}

/** Subscription states Stripe still bills (or may bill). */
const LIVE_SUBSCRIPTION = new Set(['active', 'trialing', 'past_due', 'unpaid']);

function isStripeNotFound(err: unknown): boolean {
  return err instanceof Error && /^Stripe API \S+ \S+ failed \(404\)/.test(err.message);
}

/**
 * Stop the workspace's own plan subscription: the partner pays from now on.
 * `period_end` keeps the link and lets Stripe end it (the webhook handlers
 * ignore partner workspaces and just clear the link); `now` unlinks first, so
 * the deleted-subscription webhook is a no-op, then cancels with proration.
 */
async function cancelDirectSubscription(
  ctx: AdminContext,
  workspace: WorkspaceRow,
  mode: 'now' | 'period_end',
): Promise<{ canceled: boolean }> {
  const subscriptionId = workspace.stripeSubscriptionId;
  if (!subscriptionId) return { canceled: false };
  const key = ctx.env.STRIPE_SECRET_KEY;
  if (!key) throw new AdminBillingError('NOT_CONFIGURED', 'Stripe is not configured');

  let status: string | null = null;
  try {
    status = (await retrieveSubscriptionForAdmin(key, subscriptionId)).status;
  } catch (err) {
    if (!isStripeNotFound(err)) throw err;
  }
  if (!status || !LIVE_SUBSCRIPTION.has(status)) return { canceled: false };

  if (mode === 'period_end') {
    await setCancelAtPeriodEnd(key, subscriptionId, true);
    await ctx.masterDb
      .update(workspaces)
      .set({ subscriptionCancelAtPeriodEnd: true, updatedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));
    return { canceled: true };
  }

  await ctx.masterDb
    .update(workspaces)
    .set({ stripeSubscriptionId: null, updatedAt: new Date() })
    .where(and(eq(workspaces.id, workspace.id), eq(workspaces.stripeSubscriptionId, subscriptionId)));
  try {
    await cancelSubscriptionNow(key, subscriptionId);
  } catch (err) {
    if (!isStripeNotFound(err)) {
      await ctx.masterDb
        .update(workspaces)
        .set({ stripeSubscriptionId: subscriptionId, updatedAt: new Date() })
        .where(and(eq(workspaces.id, workspace.id), isNull(workspaces.stripeSubscriptionId)));
      throw err;
    }
  }
  return { canceled: true };
}

/**
 * Move an existing direct workspace under a partner. The direct subscription
 * is cancelled first (so the customer is never billed twice), then the
 * licence is written like any admin licence change. Comp and the paywall /
 * scheduled-deletion state of the direct plan are cleared.
 */
export async function attachWorkspace(
  ctx: AdminContext,
  partnerId: string,
  input: {
    workspaceId: string;
    licence: LicenceTerms & { packageId: string | null };
    cancelDirectSubscription: 'now' | 'period_end';
    reason: string;
  },
) {
  const { masterDb, env } = ctx;
  await requirePartner(masterDb, partnerId);
  const workspace = await findWorkspace(masterDb, input.workspaceId);
  if (workspace.billingMode === 'partner') {
    throw new AdminBillingError(
      'CONFLICT',
      workspace.partnerId === partnerId
        ? 'This workspace is already managed by this partner.'
        : 'This workspace is managed by another partner. Detach it there first.',
    );
  }
  const { packageId, ...terms } = input.licence;
  // Validate before touching Stripe: a bad licence must not cancel a subscription.
  await validateLicenceTerms(masterDb, partnerId, terms);

  const warnings: string[] = [];
  const cancel = await cancelDirectSubscription(ctx, workspace, input.cancelDirectSubscription);
  if (workspace.stripePhoneSubscriptionId) {
    warnings.push('The workspace still has its own phone-number subscription, which is billed to its Stripe customer, not the partner.');
  }
  if (workspace.stripeAgentsSubscriptionId) {
    warnings.push('The workspace still has its own agents subscription, which is billed to its Stripe customer, not the partner.');
  }

  const outcome = await writeLicence(ctx, { workspace, partnerId, terms, packageId, reason: input.reason });
  warnings.push(...outcome.warnings);

  await masterDb
    .update(workspaces)
    .set({
      compGrantedAt: null,
      compEndsAt: null,
      compGrantedBy: null,
      compReason: null,
      // The direct plan's paywall and pay-or-delete schedule end here, except an admin-requested deletion.
      ...(workspace.deletionRequestedBy ? {} : { trialExpiredAt: null, scheduledDeletionAt: null }),
      ...(cancel.canceled && input.cancelDirectSubscription === 'now'
        ? { subscriptionStatus: null, subscriptionCycle: null, subscriptionCurrentPeriodStart: null, subscriptionCurrentPeriodEnd: null, subscriptionCancelAtPeriodEnd: false }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspace.id));
  await invalidateWorkspaceContexts(env.WORKSPACE_CACHE, [workspace.clerkOrgId]);

  return { workspaceId: workspace.id, subscriptionCanceled: cancel.canceled, ...(warnings.length ? { warnings } : {}) };
}

/**
 * Take a workspace back from a partner: the licence ends, the workspace is
 * direct again with the paywall and the normal 30-day grace window to add a
 * payment method. Its data and installed apps are kept.
 */
export async function detachWorkspace(ctx: AdminContext, partnerId: string, workspaceId: string, reason: string) {
  const { masterDb, env } = ctx;
  await requirePartner(masterDb, partnerId);
  const workspace = await requirePartnerWorkspace(masterDb, partnerId, workspaceId);

  // End the licence first (this is what stops the statement charging from today).
  const ended = await setLicenceStatus({
    db: masterDb,
    workspaceId: workspace.id,
    partnerId,
    status: 'ended',
    actor: { id: actorId(ctx), type: 'admin' },
    reason,
  });
  try {
    await applyLicenceCredits({
      db: masterDb,
      workspaceId: workspace.id,
      previousMonthlyCredits: ended.previous?.monthlyCredits ?? null,
      monthlyCredits: 0,
      creditRolloverCap: 0,
      changeId: ended.changeId,
    });
  } catch (err) {
    console.error(`[Admin Partners] Could not clear the licensed allowance of workspace ${workspace.id}:`, err);
  }

  const direct = {
    billingMode: 'direct' as const,
    partnerId: null,
    paidPlanRequired: true,
    stripeSubscriptionId: null,
  };
  await masterDb
    .update(workspaces)
    .set({ ...direct, updatedAt: new Date() })
    .where(eq(workspaces.id, workspace.id));
  // Pay-or-delete grace window, the same policy a cancelled new-signup subscription gets.
  const outcome = await applySubscriptionEnded(env, masterDb, { ...workspace, ...direct });

  const [plan] = workspace.planId
    ? await masterDb.select().from(plans).where(eq(plans.id, workspace.planId)).limit(1)
    : [];
  await trySyncClerkSeatLimit(env, masterDb, workspace.clerkOrgId, workspace.id, plan ?? null, 0, 'partner detach');
  await invalidateWorkspaceContexts(env.WORKSPACE_CACHE, [workspace.clerkOrgId]);
  return { workspaceId: workspace.id, outcome };
}

// ============================================================================
// Statements
// ============================================================================

function periodFrom(value: string | undefined, now: Date): { start: Date; end: Date } {
  if (value === undefined || value === '') return monthPeriod(now);
  const period = parsePeriod(value);
  if (!period) throw new AdminBillingError('BAD_REQUEST', 'period must look like 2026-09');
  return period;
}

/** The statement for a month, computed live (nothing saved). */
export async function previewStatement(masterDb: MasterDb, partnerId: string, period: string | undefined): Promise<PartnerStatementView> {
  await requirePartner(masterDb, partnerId);
  const built = await buildStatement(masterDb, partnerId, periodFrom(period, new Date()));
  return builtStatementView(built);
}

export async function getStatement(masterDb: MasterDb, partnerId: string, statementId: string): Promise<PartnerStatementView> {
  return statementViewFor(masterDb, partnerId, statementId);
}

/** Re-build the month's statement and invoice it (see runPartnerStatement). */
export async function runStatement(
  ctx: AdminContext,
  partnerId: string,
  period: string | undefined,
): Promise<PartnerStatementView & { action: RunStatementResult['action'] }> {
  const { masterDb, env } = ctx;
  await requirePartner(masterDb, partnerId);
  const range = periodFrom(period ?? previousPeriodLabel(new Date()), new Date());
  const run = await runPartnerStatement(env, masterDb, {
    partnerId,
    period: range,
    keyBase: idem(ctx, 'statement.run'),
    reopenVoided: true,
  });
  if (run.action === 'unchanged') {
    throw new AdminBillingError(
      'CONFLICT',
      `This statement is already ${run.statement.status}. Void it first to run it again.`,
    );
  }
  return { ...(await statementViewFor(masterDb, partnerId, run.statement.id)), action: run.action };
}

function previousPeriodLabel(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

export async function voidStatement(ctx: AdminContext, partnerId: string, statementId: string): Promise<PartnerStatementView> {
  const { masterDb, env } = ctx;
  await requirePartner(masterDb, partnerId);
  await voidPartnerStatement(env, masterDb, { partnerId, statementId, keyBase: idem(ctx, 'statement.void') });
  return statementViewFor(masterDb, partnerId, statementId);
}

