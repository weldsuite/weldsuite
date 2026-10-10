/**
 * Reseller licensing — partner portal services (master DB only).
 *
 * Everything the portal reads or writes about a partner's managed workspaces,
 * licence packages, statements, territory requests and team. Partner users
 * never get a tenant DB: nothing here touches customer records, and the
 * workspace figures are usage numbers (seats, credits) from master tables.
 *
 * Shared with nobody else today, but kept in the domain package so billing-worker
 * and app-api read one definition of "a managed workspace row". Licence writes
 * live in `licences.ts`; statement maths in `statements.ts`.
 */

import { and, asc, desc, eq, ilike, inArray, ne, sql } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  fromCents,
  monthPeriod,
  priceWorkspaceMonth,
  type LicenceChangeView,
  type LicencePackageInput,
  type LicenceSnapshot,
  type ManagedWorkspaceRow,
  type PartnerCatalog,
  type PartnerContractView,
  type PartnerLicencePackageView,
  type PartnerMemberRole,
  type PartnerOverview,
  type PartnerRequestStatus,
  type PartnerStatementView,
  type PartnerTeamMember,
  type PartnerWorkspaceRequestView,
  type WorkspaceLicenceStatus,
  type WorkspaceMonthPrice,
} from '@weldsuite/app-api-client/schemas/partners';
import { getActiveContract, LicenceError, validateLicenceTerms } from './licences';
import { countActiveMembers, inviteMember, partnerPublicInfo, peakSeats, type PartnerRow } from './partners';
import { buildStatement, builtStatementView, listStatements, loadStatementView } from './statements';
import type { PartnerDb } from './types';

const {
  workspaces,
  workspaceLicences,
  workspaceLicenceChanges,
  workspaceCredits,
  creditTransactions,
  partners,
  partnerMembers,
  partnerLicencePackages,
  partnerStatements,
  partnerWorkspaceRequests,
  appCatalog,
  plans,
  users,
  userWorkspaces,
} = masterSchema;

type ContractRow = NonNullable<Awaited<ReturnType<typeof getActiveContract>>>;

/** A portal rule was broken; the route maps `code` to an HTTP status. */
export class PartnerPortalError extends Error {
  constructor(
    public readonly code:
      | 'LAST_OWNER'
      | 'ALREADY_MEMBER'
      | 'NOT_FOUND'
      | 'REQUEST_PROVISIONED'
      | 'RATE_LIMITED',
    message: string,
  ) {
    super(message);
    this.name = 'PartnerPortalError';
  }
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function contractView(c: ContractRow): PartnerContractView {
  return {
    id: c.id,
    effectiveFrom: c.effectiveFrom.toISOString(),
    effectiveTo: iso(c.effectiveTo),
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

type PackageRow = typeof partnerLicencePackages.$inferSelect;

export function packageView(p: PackageRow): PartnerLicencePackageView {
  return {
    id: p.id,
    partnerId: p.partnerId,
    name: p.name,
    description: p.description,
    allowedApps: p.allowedApps,
    monthlyCredits: p.monthlyCredits,
    maxSeats: p.maxSeats,
    featurePlanId: p.featurePlanId,
    storageGb: p.storageGb,
    defaultResalePricing: p.defaultResalePricing,
    isArchived: p.isArchived,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

type RequestRow = typeof partnerWorkspaceRequests.$inferSelect;

export function requestView(r: RequestRow): PartnerWorkspaceRequestView {
  return {
    id: r.id,
    partnerId: r.partnerId,
    requesterUserId: r.requesterUserId,
    requesterEmail: r.requesterEmail,
    requesterName: r.requesterName,
    companyName: r.companyName,
    countryCode: r.countryCode,
    selectedApps: r.selectedApps,
    message: r.message,
    status: r.status,
    workspaceId: r.workspaceId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const ZERO_PRICE: WorkspaceMonthPrice = {
  resale: 0,
  share: 0,
  baseFloor: 0,
  creditFloor: 0,
  floor: 0,
  due: 0,
  margin: 0,
  basis: 'floor',
};

// ---------------------------------------------------------------------------
// Managed workspaces
// ---------------------------------------------------------------------------

/** Credits consumed per workspace in [from, to), as positive numbers. */
export async function creditsUsedByWorkspace(
  db: PartnerDb,
  workspaceIds: readonly string[],
  from: Date,
  to: Date,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (workspaceIds.length === 0) return out;
  const rows = (await db
    .select({
      workspaceId: creditTransactions.workspaceId,
      used: sql<string>`coalesce(sum(-${creditTransactions.amount}), 0)`,
    })
    .from(creditTransactions)
    .where(
      and(
        inArray(creditTransactions.workspaceId, [...workspaceIds]),
        eq(creditTransactions.type, 'consumption'),
        sql`${creditTransactions.createdAt} >= ${from}`,
        sql`${creditTransactions.createdAt} < ${to}`,
      ),
    )
    .groupBy(creditTransactions.workspaceId)) as Array<{ workspaceId: string; used: string | number }>;
  for (const r of rows) out.set(r.workspaceId, Math.max(0, Number(r.used)));
  return out;
}

type WorkspaceRow = typeof workspaces.$inferSelect;
type LicenceRow = typeof workspaceLicences.$inferSelect;

/** Build portal rows for workspaces that already passed the partner-ownership filter. */
async function buildManagedRows(db: PartnerDb, partnerId: string, rows: readonly WorkspaceRow[]): Promise<ManagedWorkspaceRow[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const now = new Date();
  const period = monthPeriod(now);

  const [contract, licences, members, peaks, used, balances, owners, requests] = await Promise.all([
    getActiveContract(db, partnerId, now),
    db.select().from(workspaceLicences).where(inArray(workspaceLicences.workspaceId, ids)) as Promise<LicenceRow[]>,
    countActiveMembers(db, ids),
    peakSeats(db, ids, period.start, period.end),
    creditsUsedByWorkspace(db, ids, period.start, period.end),
    db
      .select({ workspaceId: workspaceCredits.workspaceId, balance: workspaceCredits.currentBalance })
      .from(workspaceCredits)
      .where(inArray(workspaceCredits.workspaceId, ids)) as Promise<Array<{ workspaceId: string; balance: number }>>,
    // The earliest active org admin is the customer's owner.
    db
      .select({ workspaceId: userWorkspaces.workspaceId, email: users.email, joinedAt: userWorkspaces.joinedAt })
      .from(userWorkspaces)
      .innerJoin(users, eq(users.id, userWorkspaces.userId))
      .where(
        and(
          inArray(userWorkspaces.workspaceId, ids),
          eq(userWorkspaces.role, 'org:admin'),
          eq(userWorkspaces.status, 'ACTIVE'),
        ),
      )
      .orderBy(asc(userWorkspaces.joinedAt)) as Promise<Array<{ workspaceId: string; email: string }>>,
    // Before the owner accepts the invite, the territory request names them.
    db
      .select({ workspaceId: partnerWorkspaceRequests.workspaceId, email: partnerWorkspaceRequests.requesterEmail })
      .from(partnerWorkspaceRequests)
      .where(and(eq(partnerWorkspaceRequests.partnerId, partnerId), inArray(partnerWorkspaceRequests.workspaceId, ids))) as Promise<
      Array<{ workspaceId: string | null; email: string }>
    >,
  ]);

  const packageIds = [...new Set(licences.map((l) => l.packageId).filter((v): v is string => Boolean(v)))];
  const packageNames = new Map<string, string>();
  if (packageIds.length > 0) {
    const pkgs = (await db
      .select({ id: partnerLicencePackages.id, name: partnerLicencePackages.name })
      .from(partnerLicencePackages)
      .where(inArray(partnerLicencePackages.id, packageIds))) as Array<{ id: string; name: string }>;
    for (const p of pkgs) packageNames.set(p.id, p.name);
  }

  const licenceBy = new Map(licences.map((l) => [l.workspaceId, l]));
  const balanceBy = new Map(balances.map((b) => [b.workspaceId, b.balance]));
  const ownerBy = new Map<string, string>();
  for (const o of owners) if (!ownerBy.has(o.workspaceId)) ownerBy.set(o.workspaceId, o.email);
  for (const r of requests) if (r.workspaceId && !ownerBy.has(r.workspaceId)) ownerBy.set(r.workspaceId, r.email);

  const out: ManagedWorkspaceRow[] = [];
  for (const ws of rows) {
    const licence = licenceBy.get(ws.id);
    if (!licence) continue;
    const activeMembers = members.get(ws.id) ?? 0;
    const seats = Math.max(activeMembers, peaks.get(ws.id) ?? 0);
    const snapshot: LicenceSnapshot = {
      status: licence.status,
      allowedApps: licence.allowedApps,
      monthlyCredits: licence.monthlyCredits,
      creditRolloverCap: licence.creditRolloverCap,
      maxSeats: licence.maxSeats,
      featurePlanId: licence.featurePlanId,
      storageGb: licence.storageGb,
      resalePricing: licence.resalePricing,
      packageId: licence.packageId,
    };
    out.push({
      workspaceId: ws.id,
      name: ws.name,
      slug: ws.slug,
      provisioningStatus: ws.provisioningStatus ?? null,
      ownerEmail: ownerBy.get(ws.id) ?? null,
      licence: { ...snapshot, startsAt: licence.startsAt.toISOString(), endsAt: iso(licence.endsAt) },
      packageName: licence.packageId ? (packageNames.get(licence.packageId) ?? null) : null,
      activeMembers,
      creditsUsedThisPeriod: used.get(ws.id) ?? 0,
      creditBalance: balanceBy.get(ws.id) ?? 0,
      estimate: contract ? priceWorkspaceMonth(contract, licence, seats) : ZERO_PRICE,
      createdAt: ws.createdAt.toISOString(),
    });
  }
  return out;
}

export interface ListManagedWorkspacesOptions {
  q?: string;
  status?: WorkspaceLicenceStatus;
  limit: number;
  offset: number;
}

/** A page of a partner's workspaces, newest first. */
export async function listManagedWorkspaces(
  db: PartnerDb,
  partnerId: string,
  opts: ListManagedWorkspacesOptions,
): Promise<{ rows: ManagedWorkspaceRow[]; totalCount: number }> {
  const conditions = [eq(workspaces.partnerId, partnerId)];
  if (opts.q) conditions.push(ilike(workspaces.name, `%${opts.q.replace(/[\\%_]/g, '\\$&')}%`));
  if (opts.status) conditions.push(eq(workspaceLicences.status, opts.status));
  const where = and(...conditions);

  const [page, [count]] = await Promise.all([
    db
      .select({ ws: workspaces })
      .from(workspaces)
      .innerJoin(workspaceLicences, eq(workspaceLicences.workspaceId, workspaces.id))
      .where(where)
      .orderBy(desc(workspaces.createdAt), desc(workspaces.id))
      .limit(opts.limit)
      .offset(opts.offset) as Promise<Array<{ ws: WorkspaceRow }>>,
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(workspaces)
      .innerJoin(workspaceLicences, eq(workspaceLicences.workspaceId, workspaces.id))
      .where(where) as Promise<Array<{ total: number }>>,
  ]);
  return { rows: await buildManagedRows(db, partnerId, page.map((p) => p.ws)), totalCount: Number(count?.total ?? 0) };
}

/** One managed workspace, or null (also when it belongs to another partner). */
export async function getManagedWorkspace(
  db: PartnerDb,
  partnerId: string,
  workspaceId: string,
): Promise<ManagedWorkspaceRow | null> {
  const [ws] = (await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.partnerId, partnerId)))
    .limit(1)) as WorkspaceRow[];
  if (!ws) return null;
  const [row] = await buildManagedRows(db, partnerId, [ws]);
  return row ?? null;
}

/** Licence history of one workspace, newest first. */
export async function listLicenceHistory(db: PartnerDb, partnerId: string, workspaceId: string): Promise<LicenceChangeView[]> {
  const rows = (await db
    .select()
    .from(workspaceLicenceChanges)
    .where(and(eq(workspaceLicenceChanges.workspaceId, workspaceId), eq(workspaceLicenceChanges.partnerId, partnerId)))
    .orderBy(desc(workspaceLicenceChanges.changedAt))
    .limit(200)) as Array<typeof workspaceLicenceChanges.$inferSelect>;
  return rows.map((r) => ({
    id: r.id,
    snapshot: r.snapshot,
    changedBy: r.changedBy,
    changedByType: r.changedByType as LicenceChangeView['changedByType'],
    reason: r.reason,
    changedAt: r.changedAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/** A balance at or below this share of the monthly allowance counts as "near the limit". */
export const NEAR_CREDIT_LIMIT_RATIO = 0.2;

export async function partnerOverview(
  db: PartnerDb,
  input: { partner: PartnerRow; role: PartnerMemberRole; includeBilling: boolean; now?: Date },
): Promise<PartnerOverview> {
  const { partner } = input;
  const now = input.now ?? new Date();

  const [contract, [wsCount], [activeCount], near, currentMonth] = await Promise.all([
    getActiveContract(db, partner.id, now),
    db.select({ n: sql<number>`count(*)::int` }).from(workspaces).where(eq(workspaces.partnerId, partner.id)) as Promise<Array<{ n: number }>>,
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(workspaceLicences)
      .where(and(eq(workspaceLicences.partnerId, partner.id), eq(workspaceLicences.status, 'active'))) as Promise<Array<{ n: number }>>,
    db
      .select({
        workspaceId: workspaceLicences.workspaceId,
        name: workspaces.name,
        balance: workspaceCredits.currentBalance,
        monthlyCredits: workspaceLicences.monthlyCredits,
      })
      .from(workspaceLicences)
      .innerJoin(workspaces, eq(workspaces.id, workspaceLicences.workspaceId))
      .innerJoin(workspaceCredits, eq(workspaceCredits.workspaceId, workspaceLicences.workspaceId))
      .where(
        and(
          eq(workspaceLicences.partnerId, partner.id),
          eq(workspaceLicences.status, 'active'),
          sql`${workspaceLicences.monthlyCredits} > 0`,
          sql`${workspaceCredits.currentBalance} <= ${workspaceLicences.monthlyCredits} * ${NEAR_CREDIT_LIMIT_RATIO}`,
        ),
      )
      .orderBy(sql`${workspaceCredits.currentBalance}::float / ${workspaceLicences.monthlyCredits} asc`)
      .limit(10) as Promise<Array<{ workspaceId: string; name: string; balance: number; monthlyCredits: number }>>,
    input.includeBilling ? currentMonthTotals(db, partner.id, now) : Promise.resolve(null),
  ]);

  return {
    partner: { ...partnerPublicInfo(partner), status: partner.status },
    role: input.role,
    contract: contract ? contractView(contract) : null,
    workspaceCount: Number(wsCount?.n ?? 0),
    activeWorkspaceCount: Number(activeCount?.n ?? 0),
    currentMonth,
    nearCreditLimit: near.map((r) => ({
      workspaceId: r.workspaceId,
      name: r.name,
      creditBalance: r.balance,
      monthlyCredits: r.monthlyCredits,
    })),
  };
}

async function currentMonthTotals(db: PartnerDb, partnerId: string, now: Date): Promise<PartnerOverview['currentMonth']> {
  try {
    const built = await buildStatement(db, partnerId, monthPeriod(now));
    return {
      totalResale: fromCents(built.totalResale),
      totalDue: fromCents(built.totalDue),
      totalMargin: fromCents(built.totalMargin),
      currency: built.currency,
    };
  } catch (err) {
    if (err instanceof LicenceError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Licence packages
// ---------------------------------------------------------------------------

export async function listPackages(db: PartnerDb, partnerId: string, includeArchived: boolean): Promise<PartnerLicencePackageView[]> {
  const where = includeArchived
    ? eq(partnerLicencePackages.partnerId, partnerId)
    : and(eq(partnerLicencePackages.partnerId, partnerId), eq(partnerLicencePackages.isArchived, false));
  const rows = (await db
    .select()
    .from(partnerLicencePackages)
    .where(where)
    .orderBy(asc(partnerLicencePackages.name))) as PackageRow[];
  return rows.map(packageView);
}

/** A non-archived package of this partner, or null. */
export async function getPackage(db: PartnerDb, partnerId: string, packageId: string): Promise<PackageRow | null> {
  const [row] = (await db
    .select()
    .from(partnerLicencePackages)
    .where(and(eq(partnerLicencePackages.id, packageId), eq(partnerLicencePackages.partnerId, partnerId)))
    .limit(1)) as PackageRow[];
  return row ?? null;
}

function packageValues(input: LicencePackageInput) {
  return {
    name: input.name,
    description: input.description ?? null,
    allowedApps: input.allowedApps,
    monthlyCredits: input.monthlyCredits,
    maxSeats: input.maxSeats,
    featurePlanId: input.featurePlanId,
    storageGb: input.storageGb,
    defaultResalePricing: input.defaultResalePricing,
  };
}

/** The terms a package must satisfy: the same checks as a workspace licence. */
function packageTerms(input: LicencePackageInput) {
  return {
    allowedApps: input.allowedApps,
    monthlyCredits: input.monthlyCredits,
    creditRolloverCap: input.creditRolloverCap,
    maxSeats: input.maxSeats,
    featurePlanId: input.featurePlanId,
    storageGb: input.storageGb,
    resalePricing: input.defaultResalePricing,
  };
}

export async function createPackage(db: PartnerDb, partnerId: string, input: LicencePackageInput): Promise<PartnerLicencePackageView> {
  await validateLicenceTerms(db, partnerId, packageTerms(input));
  const [row] = (await db
    .insert(partnerLicencePackages)
    .values({ id: generateId('plp'), partnerId, ...packageValues(input) })
    .returning()) as PackageRow[];
  return packageView(row!);
}

export async function updatePackage(
  db: PartnerDb,
  partnerId: string,
  packageId: string,
  input: LicencePackageInput,
): Promise<PartnerLicencePackageView | null> {
  const existing = await getPackage(db, partnerId, packageId);
  if (!existing) return null;
  await validateLicenceTerms(db, partnerId, packageTerms(input));
  const [row] = (await db
    .update(partnerLicencePackages)
    .set({ ...packageValues(input), updatedAt: new Date() })
    .where(and(eq(partnerLicencePackages.id, packageId), eq(partnerLicencePackages.partnerId, partnerId)))
    .returning()) as PackageRow[];
  return row ? packageView(row) : null;
}

/** Archive (never delete): workspaces keep their copy of the licence. */
export async function archivePackage(db: PartnerDb, partnerId: string, packageId: string): Promise<boolean> {
  const rows = (await db
    .update(partnerLicencePackages)
    .set({ isArchived: true, updatedAt: new Date() })
    .where(and(eq(partnerLicencePackages.id, packageId), eq(partnerLicencePackages.partnerId, partnerId)))
    .returning({ id: partnerLicencePackages.id })) as Array<{ id: string }>;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Catalog (what a licence may contain)
// ---------------------------------------------------------------------------

/** Published catalog apps, and the feature plans the contract allows (all paid plans when it lists none). */
export async function partnerCatalog(db: PartnerDb, partnerId: string): Promise<PartnerCatalog> {
  const contract = await getActiveContract(db, partnerId);
  const allowedPlanIds = contract?.allowedFeaturePlanIds ?? [];
  const planConditions = [eq(plans.isActive, true), sql`${plans.deletedAt} is null`, ne(plans.slug, 'free')];
  if (allowedPlanIds.length > 0) planConditions.push(inArray(plans.id, allowedPlanIds));

  const [apps, featurePlans] = await Promise.all([
    db
      .select({ code: appCatalog.code, name: appCatalog.name, icon: appCatalog.icon })
      .from(appCatalog)
      .where(and(eq(appCatalog.isActive, true), eq(appCatalog.isPublished, true)))
      .orderBy(asc(appCatalog.sortOrder), asc(appCatalog.name)) as Promise<PartnerCatalog['apps']>,
    db
      .select({ id: plans.id, name: plans.name, slug: plans.slug })
      .from(plans)
      .where(and(...planConditions))
      .orderBy(asc(plans.sortOrder)) as Promise<PartnerCatalog['featurePlans']>,
  ]);
  return { apps, featurePlans };
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

type StatementRow = typeof partnerStatements.$inferSelect;

function statementRowView(s: StatementRow): PartnerStatementView {
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
    dueAt: iso(s.dueAt),
    paidAt: iso(s.paidAt),
    lines: [],
  };
}

/** The live current-month statement (unsaved), or null when the partner has no contract. */
export async function currentStatementPreview(db: PartnerDb, partnerId: string, now: Date = new Date()): Promise<PartnerStatementView | null> {
  try {
    return builtStatementView(await buildStatement(db, partnerId, monthPeriod(now)));
  } catch (err) {
    if (err instanceof LicenceError) return null;
    throw err;
  }
}

/**
 * Statements for the portal list, newest first, without lines. The first item
 * is the live current-month preview. Drafts are WeldSuite's working state and
 * stay hidden; a partner sees a statement once it is final.
 */
export async function partnerStatementList(db: PartnerDb, partnerId: string, now: Date = new Date()): Promise<PartnerStatementView[]> {
  const [preview, saved] = await Promise.all([currentStatementPreview(db, partnerId, now), listStatements(db, partnerId)]);
  const out: PartnerStatementView[] = [];
  if (preview) out.push({ ...preview, lines: [] });
  for (const s of saved as StatementRow[]) {
    if (s.status === 'draft') continue;
    if (preview && s.periodStart.toISOString() === preview.periodStart) continue;
    out.push(statementRowView(s));
  }
  return out;
}

/** A saved statement of this partner with its lines, or null (also for drafts and other partners). */
export async function partnerStatement(db: PartnerDb, partnerId: string, statementId: string): Promise<PartnerStatementView | null> {
  const [row] = (await db
    .select({ id: partnerStatements.id, status: partnerStatements.status })
    .from(partnerStatements)
    .where(and(eq(partnerStatements.id, statementId), eq(partnerStatements.partnerId, partnerId)))
    .limit(1)) as Array<{ id: string; status: string }>;
  if (!row || row.status === 'draft') return null;
  return loadStatementView(db, row.id);
}

const CSV_HEADER = [
  'Workspace',
  'Workspace ID',
  'Days active',
  'Days in period',
  'Seats billed',
  'Customer price',
  'WeldSuite share',
  'Floor',
  'Credit floor',
  'Extra credits',
  'WeldSuite bills',
  'Your margin',
] as const;

/** Quote a CSV field; text that a spreadsheet would run as a formula is neutralised. */
function csvText(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One row per workspace line; amounts are plain decimals so the partner can invoice from them. */
export function statementToCsv(view: PartnerStatementView): string {
  const rows = view.lines.map((l) =>
    [
      csvText(l.workspaceName),
      csvText(l.workspaceId),
      l.daysActive,
      l.daysInPeriod,
      l.seatsBilled,
      l.resale,
      l.shareAmount,
      l.floorAmount,
      l.creditFloorAmount,
      l.extraCreditsAmount,
      l.due,
      l.margin,
    ].join(','),
  );
  return `${[CSV_HEADER.join(','), ...rows].join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// Territory requests
// ---------------------------------------------------------------------------

export async function listRequests(db: PartnerDb, partnerId: string): Promise<PartnerWorkspaceRequestView[]> {
  const rows = (await db
    .select()
    .from(partnerWorkspaceRequests)
    .where(eq(partnerWorkspaceRequests.partnerId, partnerId))
    .orderBy(desc(partnerWorkspaceRequests.createdAt))) as RequestRow[];
  return rows.map(requestView);
}

async function getRequest(db: PartnerDb, partnerId: string, requestId: string): Promise<RequestRow | null> {
  const [row] = (await db
    .select()
    .from(partnerWorkspaceRequests)
    .where(and(eq(partnerWorkspaceRequests.id, requestId), eq(partnerWorkspaceRequests.partnerId, partnerId)))
    .limit(1)) as RequestRow[];
  return row ?? null;
}

/** Mark a request contacted or declined. A provisioned request is final. */
export async function updateRequestStatus(
  db: PartnerDb,
  partnerId: string,
  requestId: string,
  status: Exclude<PartnerRequestStatus, 'new' | 'provisioned'>,
): Promise<PartnerWorkspaceRequestView | null> {
  const existing = await getRequest(db, partnerId, requestId);
  if (!existing) return null;
  if (existing.status === 'provisioned') {
    throw new PartnerPortalError('REQUEST_PROVISIONED', 'This request already has a workspace');
  }
  const [row] = (await db
    .update(partnerWorkspaceRequests)
    .set({ status, updatedAt: new Date() })
    .where(eq(partnerWorkspaceRequests.id, requestId))
    .returning()) as RequestRow[];
  return row ? requestView(row) : null;
}

/** Link a request to the workspace provisioned for it. False when it is not this partner's. */
export async function markRequestProvisioned(db: PartnerDb, partnerId: string, requestId: string, workspaceId: string): Promise<boolean> {
  const rows = (await db
    .update(partnerWorkspaceRequests)
    .set({ status: 'provisioned', workspaceId, updatedAt: new Date() })
    .where(and(eq(partnerWorkspaceRequests.id, requestId), eq(partnerWorkspaceRequests.partnerId, partnerId)))
    .returning({ id: partnerWorkspaceRequests.id })) as Array<{ id: string }>;
  return rows.length > 0;
}

/** Most requests one signed-in user may file per day. */
export const MAX_REQUESTS_PER_USER_PER_DAY = 5;

/** File a territory request from a signup. Throws RATE_LIMITED past the daily cap. */
export async function createWorkspaceRequest(
  db: PartnerDb,
  input: {
    partnerId: string;
    requesterUserId: string;
    requesterEmail: string;
    requesterName: string | null;
    companyName: string;
    countryCode: string;
    selectedApps: string[];
    message?: string;
    now?: Date;
  },
): Promise<{ id: string }> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - 86_400_000);
  const [recent] = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(partnerWorkspaceRequests)
    .where(
      and(
        eq(partnerWorkspaceRequests.requesterUserId, input.requesterUserId),
        sql`${partnerWorkspaceRequests.createdAt} >= ${since}`,
      ),
    )) as Array<{ n: number }>;
  if (Number(recent?.n ?? 0) >= MAX_REQUESTS_PER_USER_PER_DAY) {
    throw new PartnerPortalError('RATE_LIMITED', 'Too many requests today. Try again tomorrow.');
  }
  const id = generateId('pwr');
  await db.insert(partnerWorkspaceRequests).values({
    id,
    partnerId: input.partnerId,
    requesterUserId: input.requesterUserId,
    requesterEmail: input.requesterEmail.trim().toLowerCase(),
    requesterName: input.requesterName,
    companyName: input.companyName,
    countryCode: input.countryCode.toUpperCase(),
    selectedApps: input.selectedApps,
    message: input.message ?? null,
    status: 'new',
  });
  return { id };
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

type MemberRow = typeof partnerMembers.$inferSelect;

function memberView(m: MemberRow, name: string | null): PartnerTeamMember {
  return {
    id: m.id,
    email: m.email,
    role: m.role,
    userId: m.userId,
    acceptedAt: iso(m.acceptedAt),
    name,
  };
}

export async function listTeam(db: PartnerDb, partnerId: string): Promise<PartnerTeamMember[]> {
  const rows = (await db
    .select({ member: partnerMembers, firstName: users.firstName, lastName: users.lastName })
    .from(partnerMembers)
    .leftJoin(users, eq(users.id, partnerMembers.userId))
    .where(eq(partnerMembers.partnerId, partnerId))
    .orderBy(asc(partnerMembers.createdAt))) as Array<{
    member: MemberRow;
    firstName: string | null;
    lastName: string | null;
  }>;
  return rows.map((r) => memberView(r.member, [r.firstName, r.lastName].filter(Boolean).join(' ') || null));
}

/** Owner and admin emails of a partner: who hears about new territory requests. */
export async function partnerAdminEmails(db: PartnerDb, partnerId: string): Promise<string[]> {
  const rows = (await db
    .select({ email: partnerMembers.email })
    .from(partnerMembers)
    .where(and(eq(partnerMembers.partnerId, partnerId), inArray(partnerMembers.role, ['owner', 'admin'])))) as Array<{ email: string }>;
  return rows.map((r) => r.email);
}

/**
 * Add a portal user. An email that is already a member is refused: the invite
 * helper upserts the role, which would let an invite demote an owner.
 */
export async function inviteTeamMember(
  db: PartnerDb,
  input: { partnerId: string; email: string; role: PartnerMemberRole; invitedBy: string | null },
): Promise<PartnerTeamMember> {
  const email = input.email.trim().toLowerCase();
  const [existing] = (await db
    .select({ id: partnerMembers.id })
    .from(partnerMembers)
    .where(and(eq(partnerMembers.partnerId, input.partnerId), eq(partnerMembers.email, email)))
    .limit(1)) as Array<{ id: string }>;
  if (existing) throw new PartnerPortalError('ALREADY_MEMBER', 'This person is already on the team');
  const row = await inviteMember(db, { ...input, email });
  return memberView(row, null);
}

/** Owners who can actually sign in (an unaccepted invitation is not one). */
async function otherActiveOwners(db: PartnerDb, partnerId: string, exceptMemberId: string): Promise<number> {
  const [row] = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(partnerMembers)
    .where(
      and(
        eq(partnerMembers.partnerId, partnerId),
        eq(partnerMembers.role, 'owner'),
        sql`${partnerMembers.userId} is not null`,
        ne(partnerMembers.id, exceptMemberId),
      ),
    )) as Array<{ n: number }>;
  return Number(row?.n ?? 0);
}

async function getMember(db: PartnerDb, partnerId: string, memberId: string): Promise<MemberRow | null> {
  const [row] = (await db
    .select()
    .from(partnerMembers)
    .where(and(eq(partnerMembers.id, memberId), eq(partnerMembers.partnerId, partnerId)))
    .limit(1)) as MemberRow[];
  return row ?? null;
}

/** Change a member's role; the last owner cannot be demoted (LAST_OWNER). Null when not found. */
export async function updateTeamMemberRole(
  db: PartnerDb,
  partnerId: string,
  memberId: string,
  role: PartnerMemberRole,
): Promise<PartnerTeamMember | null> {
  const existing = await getMember(db, partnerId, memberId);
  if (!existing) return null;
  if (existing.role === 'owner' && role !== 'owner' && (await otherActiveOwners(db, partnerId, memberId)) === 0) {
    throw new PartnerPortalError('LAST_OWNER', 'A partner needs at least one owner');
  }
  const [row] = (await db
    .update(partnerMembers)
    .set({ role, updatedAt: new Date() })
    .where(eq(partnerMembers.id, memberId))
    .returning()) as MemberRow[];
  return row ? memberView(row, null) : null;
}

/** Remove a member; the last owner cannot be removed (LAST_OWNER). False when not found. */
export async function removeTeamMember(db: PartnerDb, partnerId: string, memberId: string): Promise<boolean> {
  const existing = await getMember(db, partnerId, memberId);
  if (!existing) return false;
  if (existing.role === 'owner' && (await otherActiveOwners(db, partnerId, memberId)) === 0) {
    throw new PartnerPortalError('LAST_OWNER', 'A partner needs at least one owner');
  }
  await db.delete(partnerMembers).where(eq(partnerMembers.id, memberId));
  return true;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Update what the partner's customers see. Only the keys present change; null clears one. */
export async function updatePartnerSettings(
  db: PartnerDb,
  partnerId: string,
  input: { supportEmail?: string | null; supportUrl?: string | null; websiteUrl?: string | null; logoUrl?: string | null },
) {
  const set: Partial<typeof partners.$inferInsert> = { updatedAt: new Date() };
  if (input.supportEmail !== undefined) set.supportEmail = input.supportEmail;
  if (input.supportUrl !== undefined) set.supportUrl = input.supportUrl;
  if (input.websiteUrl !== undefined) set.websiteUrl = input.websiteUrl;
  if (input.logoUrl !== undefined) set.logoUrl = input.logoUrl;
  const [row] = (await db.update(partners).set(set).where(eq(partners.id, partnerId)).returning()) as PartnerRow[];
  return row ? partnerPublicInfo(row) : null;
}
