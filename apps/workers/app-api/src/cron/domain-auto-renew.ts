/**
 * Domain auto-renew sweep — daily Cloudflare Cron Handler
 *
 * Finds Realtime Register domains whose expiry is inside the renewal window
 * with auto-renew on, invoices the workspace Stripe customer, and renews at
 * the registrar only after payment succeeds.
 *
 * Due workspaces come from the master `domain_renewal_index`
 * (@weldsuite/db/lib/domain-renewal-index), not a tenant fan-out: only tenants
 * with a renewal actually due are opened (see AGENTS.md).
 *
 * Wired into the daily cron ("0 4 * * *") next to calendar replan.
 *
 * Work per invocation is capped so Cloudflare subrequest / wall-time
 * limits cannot abort the sweep mid-loop with no record of remaining
 * domains. Unprocessed domains stay inside the 14-day window (and their
 * workspace stays due in the index), so the next daily run picks them up.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { Env } from '../types';
import { getMasterDb, getTenantDbForWorkspace, masterSchema, type MasterDatabase } from '../db';
import {
  computeDomainRenewalDueAt,
  listWorkspacesWithDueDomainRenewals,
  reindexWorkspaceDomainRenewals,
  writeDomainRenewalIndex,
} from '@weldsuite/db/lib/domain-renewal-index';
import { getRealtimeRegistrar } from '../lib/realtime-registrar';
import {
  chargeAndRenewDomain,
  listDomainsDueForAutoRenew,
} from '../services/domain-renewal-billing';
import { pollRenewalProcess } from '../services/domains';

/** Hard cap on charge/renew attempts in one cron invocation. */
export const DOMAIN_AUTO_RENEW_MAX_PER_SWEEP = 40;

/** KV flag: the one-time index backfill has run. Bump the version to rebuild. */
export const DOMAIN_RENEWAL_INDEX_BACKFILL_KEY = 'weldhost:domain-renewal-index:backfill:v1';

const emptyResult = {
  workspacesScanned: 0,
  workspacesFailed: 0,
  domainsScanned: 0,
  invoiced: 0,
  renewed: 0,
  pending: 0,
  failed: 0,
  skipped: 0,
};

/**
 * One-time backfill: the only pass that opens every tenant DB. Indexes the
 * domains that existed before the index. A tenant that can't be read is
 * marked due now, so the daily sweep keeps retrying it instead of losing it.
 * The flag is set only when every index write landed.
 */
async function backfillDomainRenewalIndex(env: Env, masterDb: MasterDatabase): Promise<void> {
  console.log('[DomainAutoRenew] Backfilling domain renewal index (one-time)');
  const workspaces = await masterDb
    .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.isActive, true));

  let writeFailures = 0;
  for (const ws of workspaces) {
    if (!ws.clerkOrgId) continue;
    let nextDueAt: Date | null;
    try {
      const db = await getTenantDbForWorkspace(env, ws.clerkOrgId);
      nextDueAt = await computeDomainRenewalDueAt(db);
    } catch (err) {
      console.error(`[DomainAutoRenew] backfill workspace ${ws.clerkOrgId} failed:`, err);
      nextDueAt = new Date();
    }
    try {
      await writeDomainRenewalIndex(masterDb, ws.clerkOrgId, nextDueAt);
    } catch (err) {
      writeFailures += 1;
      console.error(`[DomainAutoRenew] backfill index write ${ws.clerkOrgId} failed:`, err);
    }
  }

  if (writeFailures === 0) {
    await env.WORKSPACE_CACHE.put(DOMAIN_RENEWAL_INDEX_BACKFILL_KEY, new Date().toISOString());
  }
}

export async function runDomainAutoRenewSweep(env: Env): Promise<{
  workspacesScanned: number;
  workspacesFailed: number;
  domainsScanned: number;
  invoiced: number;
  renewed: number;
  pending: number;
  failed: number;
  skipped: number;
}> {
  console.log('[DomainAutoRenew] Starting daily sweep');

  const rtr = getRealtimeRegistrar(env);
  if (!rtr) {
    console.warn('[DomainAutoRenew] Realtime Register is not configured — skipping');
    return emptyResult;
  }
  if (!env.STRIPE_SECRET_KEY) {
    console.warn('[DomainAutoRenew] STRIPE_SECRET_KEY is not configured — skipping');
    return emptyResult;
  }

  const masterDb = getMasterDb(env);
  const now = new Date();

  if (!(await env.WORKSPACE_CACHE.get(DOMAIN_RENEWAL_INDEX_BACKFILL_KEY))) {
    await backfillDomainRenewalIndex(env, masterDb);
  }

  let dueWorkspaceIds: string[];
  try {
    dueWorkspaceIds = await listWorkspacesWithDueDomainRenewals(masterDb, now);
  } catch (err) {
    // Deliberately no fallback to a tenant fan-out: skip this run instead.
    console.error('[DomainAutoRenew] Domain renewal index unavailable; skipping:', err);
    return emptyResult;
  }
  if (dueWorkspaceIds.length === 0) {
    console.log('[DomainAutoRenew] Done. No workspace has a renewal due');
    return emptyResult;
  }

  const workspaces = await masterDb
    .select({
      id: masterSchema.workspaces.id,
      clerkOrgId: masterSchema.workspaces.clerkOrgId,
      stripeCustomerId: masterSchema.workspaces.stripeCustomerId,
    })
    .from(masterSchema.workspaces)
    .where(
      and(
        eq(masterSchema.workspaces.isActive, true),
        inArray(masterSchema.workspaces.clerkOrgId, dueWorkspaceIds),
      ),
    );

  let workspacesScanned = 0;
  let domainsScanned = 0;
  let invoiced = 0;
  let renewed = 0;
  let pending = 0;
  let failed = 0;
  let skipped = 0;
  let workspacesFailed = 0;
  let processed = 0;
  let hitCap = false;

  for (const ws of workspaces) {
    if (hitCap) break;
    if (!ws.clerkOrgId) continue;
    if (!ws.stripeCustomerId) continue;

    try {
      const db = await getTenantDbForWorkspace(env, ws.clerkOrgId);
      workspacesScanned += 1;
      const due = await listDomainsDueForAutoRenew(db, now);
      domainsScanned += due.length;

      for (const domain of due) {
        if (processed >= DOMAIN_AUTO_RENEW_MAX_PER_SWEEP) {
          hitCap = true;
          break;
        }
        processed += 1;

        try {
          if (domain.registrationStatus === 'pending_renewal') {
            const polled = await pollRenewalProcess(db, rtr, domain.id);
            if (polled?.registrationStatus === 'renewed') {
              renewed += 1;
              continue;
            }
            if (polled?.registrationStatus === 'pending_renewal') {
              pending += 1;
              continue;
            }
          }

          const result = await chargeAndRenewDomain(db, rtr, masterDb, {
            domainId: domain.id,
            workspaceId: ws.clerkOrgId,
            stripeSecretKey: env.STRIPE_SECRET_KEY,
          });

          if (!result.ok) {
            if (result.reason === 'already_renewed') continue;
            console.warn(
              `[DomainAutoRenew] ws=${ws.id} domain=${domain.fullDomain} failed: ${result.reason}`,
            );
            failed += 1;
            continue;
          }

          invoiced += 1;
          if (result.renewed) renewed += 1;
          else if (result.pending) pending += 1;
        } catch (err) {
          failed += 1;
          console.error(`[DomainAutoRenew] ws=${ws.id} domain=${domain.fullDomain} error:`, err);
        }
      }

      // The tenant is awake anyway: refresh its index row (renewed domains
      // move a year out; anything still due keeps the workspace due).
      await reindexWorkspaceDomainRenewals(masterDb, db, ws.clerkOrgId);
    } catch (err) {
      console.error(`[DomainAutoRenew] Workspace ${ws.id} failed:`, err);
      workspacesFailed += 1;
    }
  }

  if (hitCap) {
    skipped = Math.max(0, domainsScanned - processed);
    console.warn(
      `[DomainAutoRenew] Hit per-invocation cap of ${DOMAIN_AUTO_RENEW_MAX_PER_SWEEP}; ${skipped} due domain(s) deferred to the next daily run`,
    );
  }

  console.log(
    `[DomainAutoRenew] Done. due=${dueWorkspaceIds.length} workspaces=${workspacesScanned} workspacesFailed=${workspacesFailed} scanned=${domainsScanned} invoiced=${invoiced} renewed=${renewed} pending=${pending} failed=${failed} skipped=${skipped}`,
  );

  return {
    workspacesScanned,
    workspacesFailed,
    domainsScanned,
    invoiced,
    renewed,
    pending,
    failed,
    skipped,
  };
}
