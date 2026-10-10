/**
 * Partner-managed workspaces as seen from a workspace's own routes: the
 * billing mutation guard, the app-install licence check, `GET /billing/managed`
 * and the territory conflict body. Master DB only.
 */

import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { getTerritoryPartner, partnerPublicInfo } from '@weldsuite/core-domain/partners';
import type {
  PartnerPublicInfo,
  PartnerStatus,
  PartnerTerritoryErrorDetails,
  WorkspaceLicenceStatus,
} from '@weldsuite/app-api-client/schemas/partners';
import { masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';

const { workspaces, workspaceLicences, partners } = masterSchema;

export interface ManagedContext {
  workspaceId: string;
  partner: PartnerPublicInfo;
  partnerStatus: PartnerStatus;
  /** Null when a partner workspace has no licence row (nothing is licensed). */
  licence: {
    status: WorkspaceLicenceStatus;
    allowedApps: string[];
    monthlyCredits: number;
    maxSeats: number | null;
  } | null;
}

/** The partner and licence of a workspace, or null for a direct (self-billed) one. */
export async function getManagedContext(masterDb: MasterDatabase, clerkOrgId: string): Promise<ManagedContext | null> {
  const [row] = await masterDb
    .select({ id: workspaces.id, billingMode: workspaces.billingMode, partner: partners })
    .from(workspaces)
    .innerJoin(partners, eq(partners.id, workspaces.partnerId))
    .where(and(eq(workspaces.clerkOrgId, clerkOrgId), eq(workspaces.billingMode, 'partner')))
    .limit(1);
  if (!row) return null;

  const [licence] = await masterDb
    .select({
      status: workspaceLicences.status,
      allowedApps: workspaceLicences.allowedApps,
      monthlyCredits: workspaceLicences.monthlyCredits,
      maxSeats: workspaceLicences.maxSeats,
    })
    .from(workspaceLicences)
    .where(eq(workspaceLicences.workspaceId, row.id))
    .limit(1);

  return {
    workspaceId: row.id,
    partner: partnerPublicInfo(row.partner),
    partnerStatus: row.partner.status,
    licence: licence ?? null,
  };
}

/** A workspace is read-only when its partner is suspended or its licence is not active. */
export function isReadOnly(ctx: Pick<ManagedContext, 'partnerStatus' | 'licence'>): boolean {
  return ctx.partnerStatus === 'suspended' || ctx.licence?.status !== 'active';
}

/** `PARTNER_MANAGED` 403: a partner workspace's billing is the partner's, not Stripe's. */
export function partnerManagedResponse(c: Context, partner: PartnerPublicInfo) {
  return c.json(
    {
      error: {
        code: 'PARTNER_MANAGED',
        message: `This workspace is billed by ${partner.name}. Contact them to change your subscription.`,
        details: { partner },
      },
    },
    403,
  );
}

/** `PARTNER_TERRITORY` 409 body, shared by workspace creation and checkout. */
export function partnerTerritoryResponse(c: Context, country: string, partner: PartnerPublicInfo) {
  const details: PartnerTerritoryErrorDetails = { country, partner };
  return c.json(
    {
      error: {
        code: 'PARTNER_TERRITORY',
        message: `WeldSuite in ${country} is provided by ${partner.name}.`,
        details,
      },
    },
    409,
  );
}

/** The partner that serves a country, as public info; null when the country is open. */
export async function territoryPartnerInfo(masterDb: MasterDatabase, country: string | null): Promise<PartnerPublicInfo | null> {
  const partner = await getTerritoryPartner(masterDb, country);
  return partner ? partnerPublicInfo(partner) : null;
}
