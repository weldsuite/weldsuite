/**
 * Partners: lookups, territory, membership, extra credits and seat counts.
 */

import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { grantCredits } from '@weldsuite/credits';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  creditsToCents,
  fromCents,
  partnerRoleCan,
  type PartnerMemberRole,
  type PartnerPermission,
  type PartnerPublicInfo,
  type PartnerStatus,
} from '@weldsuite/app-api-client/schemas/partners';
import { getActiveContract, LicenceError } from './licences';
import type { PartnerDb } from './types';

const { partners, partnerMembers, partnerTerritories, partnerCreditGrants, workspaces, workspaceLicences, userWorkspaces, workspaceSeatSnapshots } =
  masterSchema;

export type PartnerRow = typeof partners.$inferSelect;

export function partnerPublicInfo(p: PartnerRow): PartnerPublicInfo {
  return {
    id: p.id,
    name: p.name,
    logoUrl: p.logoUrl,
    websiteUrl: p.websiteUrl,
    supportEmail: p.supportEmail,
    supportUrl: p.supportUrl,
  };
}

export async function getPartner(db: PartnerDb, partnerId: string): Promise<PartnerRow | null> {
  const [row] = (await db.select().from(partners).where(eq(partners.id, partnerId)).limit(1)) as PartnerRow[];
  return row ?? null;
}

/** The partner that owns a country, or null when the country is open for direct signup. */
export async function getTerritoryPartner(db: PartnerDb, country: string | null | undefined): Promise<PartnerRow | null> {
  if (!country || !/^[A-Za-z]{2}$/.test(country)) return null;
  const [row] = (await db
    .select({ partner: partners })
    .from(partnerTerritories)
    .innerJoin(partners, eq(partners.id, partnerTerritories.partnerId))
    .where(eq(partnerTerritories.countryCode, country.toUpperCase()))
    .limit(1)) as Array<{ partner: PartnerRow }>;
  return row?.partner ?? null;
}

/** Every territory country with its partner's public info (marketing site). */
export async function listTerritories(db: PartnerDb): Promise<Array<{ country: string; partner: PartnerPublicInfo }>> {
  const rows = (await db
    .select({ country: partnerTerritories.countryCode, partner: partners })
    .from(partnerTerritories)
    .innerJoin(partners, eq(partners.id, partnerTerritories.partnerId))) as Array<{ country: string; partner: PartnerRow }>;
  return rows
    .map((r) => ({ country: r.country, partner: partnerPublicInfo(r.partner) }))
    .sort((a, b) => a.country.localeCompare(b.country));
}

/** Replace a partner's territory list. Countries owned by another partner are refused. */
export async function setTerritories(db: PartnerDb, partnerId: string, countries: readonly string[]): Promise<void> {
  const wanted = [...new Set(countries.map((c) => c.toUpperCase()))];
  if (wanted.length > 0) {
    const taken = (await db
      .select({ country: partnerTerritories.countryCode, partnerId: partnerTerritories.partnerId })
      .from(partnerTerritories)
      .where(inArray(partnerTerritories.countryCode, wanted))) as Array<{ country: string; partnerId: string }>;
    const conflicts = taken.filter((t) => t.partnerId !== partnerId).map((t) => t.country);
    if (conflicts.length > 0) {
      throw new TerritoryConflictError(conflicts);
    }
  }
  await db.delete(partnerTerritories).where(eq(partnerTerritories.partnerId, partnerId));
  if (wanted.length > 0) {
    await db.insert(partnerTerritories).values(wanted.map((countryCode) => ({ countryCode, partnerId })));
  }
}

export class TerritoryConflictError extends Error {
  constructor(public readonly countries: string[]) {
    super(`Already assigned to another partner: ${countries.join(', ')}`);
    this.name = 'TerritoryConflictError';
  }
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export interface ResolvedPartnerMember {
  partner: PartnerRow;
  memberId: string;
  role: PartnerMemberRole;
}

/**
 * The partners a user belongs to. Invitations are by email: a pending row for
 * one of the user's verified emails is claimed (userId set) on first use.
 */
export async function listPartnerMemberships(
  db: PartnerDb,
  user: { id: string; emails: readonly string[] },
): Promise<ResolvedPartnerMember[]> {
  const emails = [...new Set(user.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (emails.length > 0) {
    await db
      .update(partnerMembers)
      .set({ userId: user.id, acceptedAt: new Date(), updatedAt: new Date() })
      .where(and(isNull(partnerMembers.userId), inArray(partnerMembers.email, emails)));
  }
  const rows = (await db
    .select({ member: partnerMembers, partner: partners })
    .from(partnerMembers)
    .innerJoin(partners, eq(partners.id, partnerMembers.partnerId))
    .where(eq(partnerMembers.userId, user.id))) as Array<{
    member: typeof partnerMembers.$inferSelect;
    partner: PartnerRow;
  }>;
  return rows.map((r) => ({ partner: r.partner, memberId: r.member.id, role: r.member.role }));
}

export function memberCan(member: Pick<ResolvedPartnerMember, 'role'>, permission: PartnerPermission): boolean {
  return partnerRoleCan(member.role, permission);
}

export async function inviteMember(
  db: PartnerDb,
  input: { partnerId: string; email: string; role: PartnerMemberRole; invitedBy: string | null },
) {
  const email = input.email.trim().toLowerCase();
  const [row] = await db
    .insert(partnerMembers)
    .values({ id: generateId('ptm'), partnerId: input.partnerId, email, role: input.role, invitedBy: input.invitedBy })
    .onConflictDoUpdate({
      target: [partnerMembers.partnerId, partnerMembers.email],
      set: { role: input.role, updatedAt: new Date() },
    })
    .returning();
  return row as typeof partnerMembers.$inferSelect;
}

// ---------------------------------------------------------------------------
// Managed workspaces
// ---------------------------------------------------------------------------

/** A workspace of this partner, or null (also when it belongs to another partner). */
export async function getPartnerWorkspace(db: PartnerDb, partnerId: string, workspaceId: string) {
  const [row] = (await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.partnerId, partnerId)))
    .limit(1)) as Array<typeof workspaces.$inferSelect>;
  return row ?? null;
}

/** Active members per workspace, from master memberships (no tenant connections). */
export async function countActiveMembers(db: PartnerDb, workspaceIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (workspaceIds.length === 0) return out;
  const rows = (await db
    .select({ workspaceId: userWorkspaces.workspaceId, count: sql<number>`count(*)::int` })
    .from(userWorkspaces)
    .where(and(inArray(userWorkspaces.workspaceId, [...workspaceIds]), eq(userWorkspaces.status, 'ACTIVE')))
    .groupBy(userWorkspaces.workspaceId)) as Array<{ workspaceId: string; count: number }>;
  for (const r of rows) out.set(r.workspaceId, Number(r.count));
  return out;
}

/** Highest daily snapshot per workspace in [from, to). */
export async function peakSeats(
  db: PartnerDb,
  workspaceIds: readonly string[],
  from: Date,
  to: Date,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (workspaceIds.length === 0) return out;
  const rows = (await db
    .select({ workspaceId: workspaceSeatSnapshots.workspaceId, peak: sql<number>`max(${workspaceSeatSnapshots.activeMembers})::int` })
    .from(workspaceSeatSnapshots)
    .where(
      and(
        inArray(workspaceSeatSnapshots.workspaceId, [...workspaceIds]),
        gte(workspaceSeatSnapshots.date, from.toISOString().slice(0, 10)),
        lt(workspaceSeatSnapshots.date, to.toISOString().slice(0, 10)),
      ),
    )
    .groupBy(workspaceSeatSnapshots.workspaceId)) as Array<{ workspaceId: string; peak: number }>;
  for (const r of rows) out.set(r.workspaceId, Number(r.peak));
  return out;
}

/** Record today's member count for every licensed workspace (idempotent per day). */
export async function snapshotSeats(db: PartnerDb, now: Date = new Date()): Promise<{ workspaces: number }> {
  const licensed = (await db
    .select({ workspaceId: workspaceLicences.workspaceId })
    .from(workspaceLicences)
    .where(inArray(workspaceLicences.status, ['active', 'suspended']))) as Array<{ workspaceId: string }>;
  const ids = licensed.map((l) => l.workspaceId);
  const counts = await countActiveMembers(db, ids);
  const date = now.toISOString().slice(0, 10);
  for (const workspaceId of ids) {
    const activeMembers = counts.get(workspaceId) ?? 0;
    await db
      .insert(workspaceSeatSnapshots)
      .values({ id: generateId('wss'), workspaceId, date, activeMembers })
      .onConflictDoUpdate({
        target: [workspaceSeatSnapshots.workspaceId, workspaceSeatSnapshots.date],
        // Keep the day's peak: a sweep re-run later the same day never lowers it.
        set: { activeMembers: sql`greatest(${workspaceSeatSnapshots.activeMembers}, ${activeMembers})` },
      });
  }
  return { workspaces: ids.length };
}

// ---------------------------------------------------------------------------
// Extra credits
// ---------------------------------------------------------------------------

/**
 * Grant extra credits to a partner workspace now; billed on this month's
 * statement at the contract's `extraCreditPrice`. `idempotencyKey` makes a
 * retried request a no-op.
 */
export async function grantPartnerExtraCredits(input: {
  db: PartnerDb;
  partnerId: string;
  workspaceId: string;
  credits: number;
  grantedBy: string | null;
  note?: string;
  idempotencyKey: string;
}): Promise<{ grantId: string; newBalance: number; amount: string; duplicate: boolean }> {
  const { db, partnerId, workspaceId, credits } = input;
  const contract = await getActiveContract(db, partnerId);
  if (!contract) throw new LicenceError('NO_CONTRACT', 'This partner has no contract in force');
  const amountCents = creditsToCents(credits, contract.extraCreditPrice);
  const result = await grantCredits(db, {
    workspaceId,
    amount: credits,
    type: 'purchase',
    idempotencyKey: `partner_extra:${input.idempotencyKey}`,
    description: `Extra credits from partner: +${credits}`,
    metadata: { reason: 'partner_extra_credits', partnerId, note: input.note },
    userId: input.grantedBy ?? undefined,
  });
  if (result.duplicate) {
    const [existing] = (await db
      .select({ id: partnerCreditGrants.id, amount: partnerCreditGrants.amount })
      .from(partnerCreditGrants)
      .where(eq(partnerCreditGrants.creditTransactionId, result.transactionId))
      .limit(1)) as Array<{ id: string; amount: string }>;
    return { grantId: existing?.id ?? '', newBalance: result.newBalance, amount: existing?.amount ?? fromCents(amountCents), duplicate: true };
  }
  const grantId = generateId('pcg');
  await db.insert(partnerCreditGrants).values({
    id: grantId,
    partnerId,
    workspaceId,
    credits,
    unitPrice: contract.extraCreditPrice,
    amount: fromCents(amountCents),
    creditTransactionId: result.transactionId,
    grantedBy: input.grantedBy,
  });
  return { grantId, newBalance: result.newBalance, amount: fromCents(amountCents), duplicate: false };
}

/** Extra-credit charges per workspace in [from, to), in cents. */
export async function extraCreditCents(
  db: PartnerDb,
  partnerId: string,
  from: Date,
  to: Date,
): Promise<Map<string, number>> {
  const rows = (await db
    .select({ workspaceId: partnerCreditGrants.workspaceId, amount: partnerCreditGrants.amount })
    .from(partnerCreditGrants)
    .where(
      and(
        eq(partnerCreditGrants.partnerId, partnerId),
        gte(partnerCreditGrants.createdAt, from),
        lt(partnerCreditGrants.createdAt, to),
      ),
    )
    .orderBy(desc(partnerCreditGrants.createdAt))) as Array<{ workspaceId: string; amount: string }>;
  const out = new Map<string, number>();
  for (const r of rows) {
    const [whole, frac = ''] = String(r.amount).split('.');
    const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
    out.set(r.workspaceId, (out.get(r.workspaceId) ?? 0) + cents);
  }
  return out;
}

/** Set a partner's payment status (dunning sweep, staff override, payment). */
export async function setPartnerStatus(db: PartnerDb, partnerId: string, status: PartnerStatus): Promise<boolean> {
  const updated = (await db
    .update(partners)
    .set({ status, statusChangedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(partners.id, partnerId), sql`${partners.status} <> ${status}`))
    .returning({ id: partners.id })) as Array<{ id: string }>;
  return updated.length > 0;
}

/** Clerk org ids of every workspace of a partner (for cache invalidation). */
export async function partnerWorkspaceOrgIds(db: PartnerDb, partnerId: string): Promise<string[]> {
  const rows = (await db
    .select({ clerkOrgId: workspaces.clerkOrgId })
    .from(workspaces)
    .where(eq(workspaces.partnerId, partnerId))) as Array<{ clerkOrgId: string | null }>;
  return rows.map((r) => r.clerkOrgId).filter((v): v is string => Boolean(v));
}

/**
 * Drop the cached workspace contexts so a licence or partner-status change is
 * enforced now instead of after the KV TTL (300 s). worker-kit caches by Clerk
 * org id under `ws:<org>` in WORKSPACE_CACHE; other caches expire on their own.
 */
export async function invalidateWorkspaceContexts(
  kv: { delete(key: string): Promise<void> } | undefined,
  clerkOrgIds: readonly (string | null | undefined)[],
): Promise<void> {
  if (!kv) return;
  await Promise.all(
    clerkOrgIds.filter((id): id is string => Boolean(id)).map((id) => kv.delete(`ws:${id}`).catch(() => undefined)),
  );
}
