import 'server-only';

import { and, asc, desc, eq, gte, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { AppAccessRequestDetails } from '@weldsuite/db/schema/master';
import { getMasterDb, getTenantDbForWorkspace, masterSchema, schema } from './db';
import {
  EMPTY_USAGE,
  isAccessStatus,
  resolveLimits,
  type AppAccessStatus,
  type ReachUsage,
  type WeldReachLimits,
} from './app-access';

const { workspaceAppAccess, workspaces, appCatalog, users } = masterSchema;

/** One row of the Access requests list. */
export interface AccessRequestSummary {
  id: string;
  workspaceId: string;
  workspaceName: string;
  appCode: string;
  appName: string;
  status: AppAccessStatus;
  requestedAt: string | null;
  reviewedAt: string | null;
  companyName: string | null;
  targetCountries: string[];
  listSource: string | null;
  expectedDailySends: number | null;
}

/** Everything staff see and change about one workspace's access to one app. */
export interface AppAccessDetail {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  /** The Clerk org, which opens the tenant DB. Null for a workspace without one. */
  clerkOrgId: string | null;
  appCode: string;
  appName: string;
  status: AppAccessStatus;
  request: AppAccessRequestDetails | null;
  /** The stored limits with the app's defaults filled in. */
  limits: WeldReachLimits;
  /** True when no limits were stored yet (the form then shows the defaults). */
  limitsUnset: boolean;
  requestedBy: string | null;
  /** The account email of the requester, when the user is known. */
  requestedByEmail: string | null;
  requestedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  rejectionReason: string | null;
  suspendedReason: string | null;
  billingStatus: 'none' | 'active' | 'past_due' | 'canceled';
  billingStatusAt: string | null;
  hasSubscription: boolean;
}

/** An on-request app and the workspace's access to it (null: never asked, no row). */
export interface WorkspaceAppAccessEntry {
  appCode: string;
  appName: string;
  access: AppAccessDetail | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

const LIST_LIMIT = 300;

export interface AccessRequestFilters {
  /** Omit for every status. */
  status?: AppAccessStatus;
  appCode?: string;
  search?: string;
}

export async function listAccessRequests(filters: AccessRequestFilters = {}): Promise<AccessRequestSummary[]> {
  const db = getMasterDb();
  const conditions: SQL[] = [];
  if (filters.status) conditions.push(eq(workspaceAppAccess.status, filters.status));
  if (filters.appCode) conditions.push(eq(workspaceAppAccess.appCode, filters.appCode));
  const search = filters.search?.trim();
  if (search) {
    const pattern = `%${search}%`;
    const match = or(
      ilike(workspaces.name, pattern),
      ilike(workspaces.slug, pattern),
      sql`${workspaceAppAccess.request}->>'companyName' ilike ${pattern}`,
      sql`${workspaceAppAccess.request}->>'contactEmail' ilike ${pattern}`,
    );
    if (match) conditions.push(match);
  }

  const rows = await db
    .select({
      id: workspaceAppAccess.id,
      workspaceId: workspaceAppAccess.workspaceId,
      workspaceName: workspaces.name,
      appCode: workspaceAppAccess.appCode,
      appName: appCatalog.name,
      status: workspaceAppAccess.status,
      request: workspaceAppAccess.request,
      requestedAt: workspaceAppAccess.requestedAt,
      reviewedAt: workspaceAppAccess.reviewedAt,
    })
    .from(workspaceAppAccess)
    .innerJoin(workspaces, eq(workspaces.id, workspaceAppAccess.workspaceId))
    .leftJoin(appCatalog, eq(appCatalog.code, workspaceAppAccess.appCode))
    .where(conditions.length ? and(...conditions) : undefined)
    // Oldest open request first when working through the queue; newest first elsewhere.
    .orderBy(
      filters.status === 'requested' ? asc(workspaceAppAccess.requestedAt) : desc(workspaceAppAccess.updatedAt),
    )
    .limit(LIST_LIMIT);

  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    appCode: row.appCode,
    appName: row.appName ?? row.appCode,
    status: row.status,
    requestedAt: iso(row.requestedAt),
    reviewedAt: iso(row.reviewedAt),
    companyName: row.request?.companyName ?? null,
    targetCountries: row.request?.targetCountries ?? [],
    listSource: row.request?.listSource ?? null,
    expectedDailySends: row.request?.expectedDailySends ?? null,
  }));
}

/** Rows per status, for the filter tabs. */
export async function countAccessRequestsByStatus(): Promise<Record<AppAccessStatus, number>> {
  const db = getMasterDb();
  const rows = await db
    .select({ status: workspaceAppAccess.status, n: sql<number>`count(*)::int` })
    .from(workspaceAppAccess)
    .groupBy(workspaceAppAccess.status);
  const counts: Record<AppAccessStatus, number> = { requested: 0, approved: 0, rejected: 0, suspended: 0, revoked: 0 };
  for (const row of rows) if (isAccessStatus(row.status)) counts[row.status] = Number(row.n);
  return counts;
}

const detailColumns = {
  id: workspaceAppAccess.id,
  workspaceId: workspaceAppAccess.workspaceId,
  workspaceName: workspaces.name,
  workspaceSlug: workspaces.slug,
  clerkOrgId: workspaces.clerkOrgId,
  appCode: workspaceAppAccess.appCode,
  appName: appCatalog.name,
  status: workspaceAppAccess.status,
  request: workspaceAppAccess.request,
  limits: workspaceAppAccess.limits,
  requestedBy: workspaceAppAccess.requestedBy,
  requestedByEmail: users.email,
  requestedAt: workspaceAppAccess.requestedAt,
  reviewedBy: workspaceAppAccess.reviewedBy,
  reviewedAt: workspaceAppAccess.reviewedAt,
  reviewNotes: workspaceAppAccess.reviewNotes,
  rejectionReason: workspaceAppAccess.rejectionReason,
  suspendedReason: workspaceAppAccess.suspendedReason,
  billingStatus: workspaceAppAccess.billingStatus,
  billingStatusAt: workspaceAppAccess.billingStatusAt,
  stripeSubscriptionId: workspaceAppAccess.stripeSubscriptionId,
};


function toDetail(row: DetailRow): AppAccessDetail {
  const stored = row.limits ?? {};
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    workspaceSlug: row.workspaceSlug,
    clerkOrgId: row.clerkOrgId,
    appCode: row.appCode,
    appName: row.appName ?? row.appCode,
    status: row.status,
    request: row.request ?? null,
    limits: resolveLimits(stored),
    limitsUnset: Object.keys(stored).length === 0,
    requestedBy: row.requestedBy,
    requestedByEmail: row.requestedByEmail ?? null,
    requestedAt: iso(row.requestedAt),
    reviewedBy: row.reviewedBy,
    reviewedAt: iso(row.reviewedAt),
    reviewNotes: row.reviewNotes,
    rejectionReason: row.rejectionReason,
    suspendedReason: row.suspendedReason,
    billingStatus: row.billingStatus,
    billingStatusAt: iso(row.billingStatusAt),
    hasSubscription: Boolean(row.stripeSubscriptionId),
  };
}

function detailQuery() {
  return getMasterDb()
    .select(detailColumns)
    .from(workspaceAppAccess)
    .innerJoin(workspaces, eq(workspaces.id, workspaceAppAccess.workspaceId))
    .leftJoin(appCatalog, eq(appCatalog.code, workspaceAppAccess.appCode))
    .leftJoin(users, eq(users.id, workspaceAppAccess.requestedBy));
}

type DetailRow = Awaited<ReturnType<typeof detailQuery>>[number];

export async function getAppAccessById(id: string): Promise<AppAccessDetail | null> {
  const [row] = await detailQuery().where(eq(workspaceAppAccess.id, id)).limit(1);
  return row ? toDetail(row) : null;
}

export async function getAppAccess(workspaceId: string, appCode: string): Promise<AppAccessDetail | null> {
  const [row] = await detailQuery()
    .where(and(eq(workspaceAppAccess.workspaceId, workspaceId), eq(workspaceAppAccess.appCode, appCode)))
    .limit(1);
  return row ? toDetail(row) : null;
}

/**
 * Every on-request app (`app_catalog.requires_approval`, plus any app this
 * workspace already has a row for) with the workspace's access to it.
 */
export async function listWorkspaceAppAccess(workspaceId: string): Promise<WorkspaceAppAccessEntry[]> {
  const db = getMasterDb();
  const [apps, rows] = await Promise.all([
    db
      .select({ code: appCatalog.code, name: appCatalog.name })
      .from(appCatalog)
      .where(and(eq(appCatalog.requiresApproval, true), eq(appCatalog.isActive, true)))
      .orderBy(asc(appCatalog.sortOrder), asc(appCatalog.name)),
    detailQuery().where(eq(workspaceAppAccess.workspaceId, workspaceId)),
  ]);

  const byCode = new Map(rows.map((row) => [row.appCode, toDetail(row)]));
  const entries: WorkspaceAppAccessEntry[] = apps.map((app) => ({
    appCode: app.code,
    appName: app.name,
    access: byCode.get(app.code) ?? null,
  }));
  // A row for an app that is no longer on request (or inactive) still shows, so access is never hidden.
  for (const [code, access] of byCode) {
    if (!entries.some((e) => e.appCode === code)) entries.push({ appCode: code, appName: access.appName, access });
  }
  return entries;
}

/** The people to email about a decision: the requester's account, else the contact on the request. */
export function requesterContact(access: AppAccessDetail): { email: string | null; name: string | null } {
  const request = access.request;
  if (access.requestedByEmail) {
    const sameAsContact = request?.contactEmail.toLowerCase() === access.requestedByEmail.toLowerCase();
    return { email: access.requestedByEmail, name: sameAsContact ? request?.contactName ?? null : null };
  }
  return { email: request?.contactEmail ?? null, name: request?.contactName ?? null };
}

// ---------------------------------------------------------------------------
// WeldReach usage, read from the workspace's own database
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Domains, mailboxes and the last 24 h / 7 days of sending, from the tenant
 * DB. Every figure is read on its own and is null when it cannot be: a tenant
 * that has not been migrated to the WeldReach tables yet, or whose database
 * cannot be opened, shows dashes instead of failing the screen.
 */
export async function getReachUsage(clerkOrgId: string | null): Promise<ReachUsage> {
  if (!clerkOrgId) return { ...EMPTY_USAGE };

  let db: Awaited<ReturnType<typeof getTenantDbForWorkspace>>;
  try {
    db = await getTenantDbForWorkspace(clerkOrgId);
  } catch (err) {
    console.warn('[admin/app-access] tenant DB unavailable for usage:', err);
    return { ...EMPTY_USAGE };
  }

  const { reachDomains, reachMailboxes, reachMessages } = schema;
  const now = Date.now();
  const since24h = new Date(now - DAY_MS);
  const since7d = new Date(now - 7 * DAY_MS);
  const count = sql<number>`count(*)::int`;

  const sent = (since: Date) =>
    db
      .select({ n: count })
      .from(reachMessages)
      .where(and(eq(reachMessages.direction, 'out'), eq(reachMessages.status, 'sent'), gte(reachMessages.sentAt, since)));
  const received = (kind: 'reply' | 'bounce') =>
    db
      .select({ n: count })
      .from(reachMessages)
      .where(and(eq(reachMessages.direction, 'in'), eq(reachMessages.kind, kind), gte(reachMessages.receivedAt, since7d)));

  const [domains, mailboxes, sent24h, sent7d, bounced7d, replies7d] = await Promise.allSettled([
    db.select({ n: count }).from(reachDomains),
    db.select({ n: count }).from(reachMailboxes).where(isNull(reachMailboxes.deletedAt)),
    sent(since24h),
    sent(since7d),
    received('bounce'),
    received('reply'),
  ]);

  const figure = (result: PromiseSettledResult<Array<{ n: number }>>): number | null =>
    result.status === 'fulfilled' ? Number(result.value[0]?.n ?? 0) : null;

  return {
    domains: figure(domains),
    mailboxes: figure(mailboxes),
    sent24h: figure(sent24h),
    sent7d: figure(sent7d),
    bounced7d: figure(bounced7d),
    replies7d: figure(replies7d),
  };
}
