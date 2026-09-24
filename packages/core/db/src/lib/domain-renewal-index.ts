/**
 * Master-DB index of WeldHost auto-renew timing (`domain_renewal_index`).
 *
 * The daily auto-renew sweep used to open every tenant Neon DB just to find
 * the few domains inside the renewal window. This index keeps, per workspace,
 * the earliest moment one of its auto-renewing domains becomes due, so the
 * sweep opens only tenants with a renewal actually due.
 *
 * The tenant host_domains table stays the source of truth. Every write here
 * re-derives the workspace's row from it, so a missed or failed write is
 * repaired by the next domain write, and the sweep re-indexes every workspace
 * it opens. Writes are best-effort: a failure logs and never fails the caller.
 *
 * Lives in @weldsuite/db (not app-api) because host_domains is written from
 * several workers: app-api, billing-worker, external-api, mcp-server and
 * workflow-worker. Call `reindexWorkspaceDomainRenewals` after any such write.
 *
 * Rows are keyed by the workspace's Clerk org id (what the sweep passes to
 * getTenantDbForWorkspace). Workspaces without one are never swept.
 */

import { and, eq, isNull, lte, or } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../schema';
import * as masterSchema from '../schema/master';

type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
type MasterDatabase = PgDatabase<PgQueryResultHKT, typeof masterSchema>;

/** How far ahead of expiry the sweep raises the renewal invoice. */
export const DOMAIN_AUTO_RENEW_WINDOW_DAYS = 14;
/** Don't chase domains that expired this many days ago (redemption is manual). */
export const DOMAIN_AUTO_RENEW_GRACE_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * The auto-renew candidates of a tenant: undeleted, auto-renew on, registered
 * through Realtime Register, active or expired. Shared by the sweep's due
 * query and the index so the two can't drift apart.
 */
export function autoRenewCandidateFilter() {
  const { hostDomains } = schema;
  return and(
    isNull(hostDomains.deletedAt),
    eq(hostDomains.autoRenew, true),
    eq(hostDomains.registrar, 'realtimeregister'),
    or(eq(hostDomains.status, 'active'), eq(hostDomains.status, 'expired')),
  );
}

/**
 * When a candidate domain is next due for the sweep, or null if it never will
 * be without another write (no expiry, or past the grace period).
 */
export function domainRenewalDueAt(
  domain: { registrationStatus: string | null; expiresAt: Date | null },
  now: Date,
): Date | null {
  if (domain.registrationStatus === 'pending_renewal') return now;
  if (!domain.expiresAt) return null;
  const expiresAt = domain.expiresAt.getTime();
  if (expiresAt < now.getTime() - DOMAIN_AUTO_RENEW_GRACE_DAYS * DAY_MS) return null;
  return new Date(expiresAt - DOMAIN_AUTO_RENEW_WINDOW_DAYS * DAY_MS);
}

/** Earliest due time across a tenant's auto-renew candidates, or null for none. */
export async function computeDomainRenewalDueAt(db: Database, now = new Date()): Promise<Date | null> {
  const { hostDomains } = schema;
  const rows = await db
    .select({ registrationStatus: hostDomains.registrationStatus, expiresAt: hostDomains.expiresAt })
    .from(hostDomains)
    .where(autoRenewCandidateFilter());

  let earliest: Date | null = null;
  for (const row of rows) {
    const dueAt = domainRenewalDueAt(row, now);
    if (dueAt && (!earliest || dueAt < earliest)) earliest = dueAt;
  }
  return earliest;
}

/** Store (or clear, when null) a workspace's next due time. Throws on failure. */
export async function writeDomainRenewalIndex(
  masterDb: MasterDatabase,
  clerkOrgId: string,
  nextDueAt: Date | null,
): Promise<void> {
  const { domainRenewalIndex } = masterSchema;
  if (!nextDueAt) {
    await masterDb.delete(domainRenewalIndex).where(eq(domainRenewalIndex.clerkOrgId, clerkOrgId));
    return;
  }
  const updatedAt = new Date();
  await masterDb
    .insert(domainRenewalIndex)
    .values({ clerkOrgId, nextDueAt, updatedAt })
    .onConflictDoUpdate({
      target: domainRenewalIndex.clerkOrgId,
      set: { nextDueAt, updatedAt },
    });
}

/**
 * The index key for a workspace. Workers name workspaces differently (app-api
 * uses the Clerk org id, external-api and mcp-server use workspaces.id), so
 * resolve either to the Clerk org id getTenantDbForWorkspace takes.
 */
async function resolveClerkOrgId(masterDb: MasterDatabase, workspaceKey: string): Promise<string | null> {
  const { workspaces } = masterSchema;
  const [row] = await masterDb
    .select({ clerkOrgId: workspaces.clerkOrgId })
    .from(workspaces)
    .where(or(eq(workspaces.clerkOrgId, workspaceKey), eq(workspaces.id, workspaceKey)))
    .limit(1);
  return row?.clerkOrgId ?? null;
}

/**
 * Re-derive a workspace's index row from its tenant DB. Call after any
 * host_domains write. `workspaceKey` is the Clerk org id or workspaces.id.
 * Best-effort: returns false (and logs) instead of throwing.
 */
export async function reindexWorkspaceDomainRenewals(
  masterDb: MasterDatabase,
  db: Database,
  workspaceKey: string | null | undefined,
): Promise<boolean> {
  if (!workspaceKey) return false;
  try {
    const clerkOrgId = await resolveClerkOrgId(masterDb, workspaceKey);
    if (!clerkOrgId) return false;
    await writeDomainRenewalIndex(masterDb, clerkOrgId, await computeDomainRenewalDueAt(db));
    return true;
  } catch (err) {
    console.warn(`[domain-renewal-index] reindex workspace ${workspaceKey} failed:`, err);
    return false;
  }
}

/** Workspaces (clerkOrgId) with a renewal due at `asOf`. Throws when master is unreachable. */
export async function listWorkspacesWithDueDomainRenewals(
  masterDb: MasterDatabase,
  asOf: Date,
  limit = 500,
): Promise<string[]> {
  const { domainRenewalIndex } = masterSchema;
  const rows = await masterDb
    .select({ clerkOrgId: domainRenewalIndex.clerkOrgId })
    .from(domainRenewalIndex)
    .where(lte(domainRenewalIndex.nextDueAt, asOf))
    .orderBy(domainRenewalIndex.nextDueAt)
    .limit(limit);
  return rows.map((r) => r.clerkOrgId);
}
