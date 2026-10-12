/**
 * Reseller licensing — provisioning services. See index.ts.
 *
 * Master-DB half of creating a partner-managed workspace, shared by
 * workspace-worker (`onboardPartnerWorkspace`, the ProvisionWorkspace workflow)
 * and any caller that needs the same checks. The Clerk side (organisation,
 * owner invitation) lives in workspace-worker.
 */

import { and, desc, eq, gte } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { generateId } from '@weldsuite/worker-kit/id';
import type { LicenceTerms } from '@weldsuite/app-api-client/schemas/partners';
import { applyLicenceCredits, LicenceError, upsertWorkspaceLicence, validateLicenceTerms } from './licences';
import { getPartner } from './partners';
import type { PartnerDb } from './types';

const { workspaces, workspaceLicences, workspaceCredits, partnerLicencePackages } = masterSchema;

/** Input of workspace-worker's `onboardPartnerWorkspace` RPC method. */
export interface PartnerOnboardInput {
  partnerId: string;
  /** The partner portal user who creates the workspace. Not made a member. */
  actorUserId: string;
  name: string;
  /** ISO-2 */
  country: string;
  region?: string;
  /** Invited as the workspace owner. */
  ownerEmail: string;
  licence: LicenceTerms & { packageId: string | null };
}

export interface PartnerOnboardResult {
  workspaceId: string;
  clerkOrgId: string;
}

/**
 * Refuse a partner workspace the partner may not have: unknown partner, a
 * package of another partner, or terms the contract does not allow
 * (`validateLicenceTerms`). Throws `LicenceError`.
 */
export async function assertPartnerOnboardAllowed(db: PartnerDb, input: PartnerOnboardInput): Promise<void> {
  const partner = await getPartner(db, input.partnerId);
  if (!partner) throw new LicenceError('NOT_FOUND', 'Partner not found');

  if (input.licence.packageId) {
    const [pkg] = (await db
      .select({ partnerId: partnerLicencePackages.partnerId })
      .from(partnerLicencePackages)
      .where(eq(partnerLicencePackages.id, input.licence.packageId))
      .limit(1)) as Array<{ partnerId: string }>;
    if (!pkg) throw new LicenceError('NOT_FOUND', 'Licence package not found');
    if (pkg.partnerId !== input.partnerId) throw new LicenceError('WRONG_PARTNER', 'This package belongs to another partner');
  }

  await validateLicenceTerms(db, input.partnerId, input.licence);
}

/**
 * A workspace this partner created under this name in the last `windowMs`
 * (default 10 minutes): a retried `onboardPartnerWorkspace` resumes it instead
 * of creating a second organisation.
 */
export async function findRecentPartnerWorkspace(
  db: PartnerDb,
  input: { partnerId: string; name: string; now?: Date; windowMs?: number },
): Promise<{ id: string; clerkOrgId: string; slug: string | null } | null> {
  const since = new Date((input.now ?? new Date()).getTime() - (input.windowMs ?? 10 * 60_000));
  const [row] = (await db
    .select({ id: workspaces.id, clerkOrgId: workspaces.clerkOrgId, slug: workspaces.slug })
    .from(workspaces)
    .where(and(eq(workspaces.partnerId, input.partnerId), eq(workspaces.name, input.name), gte(workspaces.createdAt, since)))
    .orderBy(desc(workspaces.createdAt))
    .limit(1)) as Array<{ id: string; clerkOrgId: string | null; slug: string | null }>;
  if (!row?.clerkOrgId) return null;
  return { id: row.id, clerkOrgId: row.clerkOrgId, slug: row.slug };
}

/**
 * Write the master rows of a new partner workspace: the workspace (billing mode
 * `partner`, no paywall) and its licence, with the first licence change
 * recorded. Safe to re-run, and safe against the Clerk `organization.created`
 * webhook inserting the row first: the Clerk org id is the conflict target.
 * `defaultPlanId` is the plan used when the licence names no feature plan.
 */
export async function registerPartnerWorkspace(
  db: PartnerDb,
  input: {
    clerkOrgId: string;
    name: string;
    slug: string;
    partnerId: string;
    actorUserId: string;
    licence: LicenceTerms & { packageId: string | null };
    defaultPlanId: string | null;
  },
): Promise<{ workspaceId: string; created: boolean }> {
  const planId = input.licence.featurePlanId ?? input.defaultPlanId;
  const now = new Date();
  const [row] = (await db
    .insert(workspaces)
    .values({
      id: generateId('ws'),
      clerkOrgId: input.clerkOrgId,
      name: input.name,
      slug: input.slug,
      planId,
      isActive: true,
      partnerId: input.partnerId,
      billingMode: 'partner',
      // Payment is the partner's business, handled through partner status.
      paidPlanRequired: false,
    })
    .onConflictDoUpdate({
      target: workspaces.clerkOrgId,
      set: {
        name: input.name,
        partnerId: input.partnerId,
        billingMode: 'partner',
        paidPlanRequired: false,
        ...(input.licence.featurePlanId ? { planId: input.licence.featurePlanId } : {}),
        updatedAt: now,
      },
    })
    .returning({ id: workspaces.id })) as Array<{ id: string }>;
  const workspaceId = row!.id;

  // A retry (the workspace and its licence already exist) must not write a second
  // licence change: the licence may have been edited since, and the first
  // change is what the initial credit grant is keyed on.
  const [existing] = (await db
    .select({ id: workspaceLicences.id })
    .from(workspaceLicences)
    .where(eq(workspaceLicences.workspaceId, workspaceId))
    .limit(1)) as Array<{ id: string }>;
  if (existing) return { workspaceId, created: false };

  await upsertWorkspaceLicence({
    db,
    workspaceId,
    partnerId: input.partnerId,
    terms: input.licence,
    packageId: input.licence.packageId,
    actor: { id: input.actorUserId, type: 'partner' },
    reason: 'Workspace created',
    now,
  });
  return { workspaceId, created: true };
}

/** What the ProvisionWorkspace workflow needs to know about a workspace's licence. */
export interface PartnerProvisionContext {
  /** Apps the licence allows (install-apps installs exactly these). */
  allowedApps: string[];
  monthlyCredits: number;
  creditRolloverCap: number;
}

/**
 * The licence of a partner-managed workspace, or null for a direct one. The
 * workflow reads this from the database (not its params) so that provisioning
 * follows the licence as it is when the step runs.
 */
export async function getPartnerProvisionContext(
  db: PartnerDb,
  workspaceId: string,
): Promise<PartnerProvisionContext | null> {
  const [ws] = (await db
    .select({ billingMode: workspaces.billingMode })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)) as Array<{ billingMode: string }>;
  if (ws?.billingMode !== 'partner') return null;

  const [licence] = (await db
    .select({
      allowedApps: workspaceLicences.allowedApps,
      monthlyCredits: workspaceLicences.monthlyCredits,
      creditRolloverCap: workspaceLicences.creditRolloverCap,
    })
    .from(workspaceLicences)
    .where(eq(workspaceLicences.workspaceId, workspaceId))
    .limit(1)) as Array<PartnerProvisionContext>;
  // A partner workspace without a licence row is core-only with no credits.
  return licence
    ? { allowedApps: [...licence.allowedApps], monthlyCredits: licence.monthlyCredits, creditRolloverCap: licence.creditRolloverCap }
    : { allowedApps: [], monthlyCredits: 0, creditRolloverCap: 0 };
}

/**
 * The initialize-credits step of a partner workspace: the licence's monthly
 * allowance (`applyLicenceCredits`, idempotent per licence change), and the
 * wallet marked as reset this month so the daily licensed-credit sweep does not
 * expire and grant it again.
 */
export async function initialiseLicensedCredits(
  db: PartnerDb,
  workspaceId: string,
  context: PartnerProvisionContext,
): Promise<{ granted: number }> {
  const { granted } = await applyLicenceCredits({
    db,
    workspaceId,
    previousMonthlyCredits: null,
    monthlyCredits: context.monthlyCredits,
    creditRolloverCap: context.creditRolloverCap,
    // A fixed change id makes the grant key `partner_licence:init:<workspace>`:
    // the initial allowance is granted once, however often the step re-runs.
    changeId: `init:${workspaceId}`,
  });

  await db
    .update(workspaceCredits)
    .set({ lastResetAt: new Date(), updatedAt: new Date() })
    .where(eq(workspaceCredits.workspaceId, workspaceId));
  return { granted };
}
