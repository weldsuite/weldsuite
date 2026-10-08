/**
 * Domain auto-renew sweep — daily Cloudflare Cron Handler
 *
 * Finds Realtime Register domains whose expiry is inside the renewal window
 * with auto-renew on, invoices the workspace Stripe customer, and renews at
 * the registrar only after payment succeeds.
 *
 * Wired into the daily cron ("0 4 * * *") next to calendar replan.
 *
 * It used to open every paying workspace's tenant DB each night. Timing now
 * lives in the SCHEDULE_INDEX D1 `workspace_due_index` (kind `domain_renew`),
 * per AGENTS.md: each run opens only due workspaces and stores when the
 * workspace next needs a look (`nextDomainRenewCheckAt`). Writes mark a
 * workspace due through the host-api middleware in ../index.ts and the
 * Realtime Register webhook; a one-time seed (KV flag below) marks every
 * paying workspace due once.
 *
 * Work per invocation is capped so Cloudflare subrequest / wall-time
 * limits cannot abort the sweep mid-loop with no record of remaining
 * domains. Unprocessed domains stay inside the 14-day window, so their
 * workspace stays due and is picked up on the next daily run.
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import type { Env } from '../types';
import { getMasterDb, getTenantDbForWorkspace, masterSchema } from '@weldsuite/worker-kit/db';
import { runDueIndexSweep } from '@weldsuite/worker-kit/due-index';
import { getRealtimeRegistrar } from '../lib/realtime-registrar';
import {
  chargeAndRenewDomain,
  listDomainsDueForAutoRenew,
  loadNextDomainRenewCheckAt,
} from '../services/domain-renewal-billing';
import { pollRenewalProcess } from '@weldsuite/host-domain/domains';

/** KV flag: paying workspaces were seeded into the due index. Bump to reseed. */
export const DOMAIN_RENEW_SEED_KEY = 'host:domain-renew-index:seed:v1';

/** Workspaces per run; the rest stay due for the next day. */
const WORKSPACES_PER_RUN = 1000;

/** Hard cap on charge/renew attempts in one cron invocation. */
export const DOMAIN_AUTO_RENEW_MAX_PER_SWEEP = 40;

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

type Db = Awaited<ReturnType<typeof getTenantDbForWorkspace>>;
type MasterDb = ReturnType<typeof getMasterDb>;
type Registrar = NonNullable<ReturnType<typeof getRealtimeRegistrar>>;
type DueDomain = Awaited<ReturnType<typeof listDomainsDueForAutoRenew>>[number];

interface SweepContext {
  rtr: Registrar;
  masterDb: MasterDb;
  stripeSecretKey: string;
  now: Date;
}

interface SweepStats {
  domainsScanned: number;
  invoiced: number;
  renewed: number;
  pending: number;
  failed: number;
  processed: number;
}

interface SweepWorkspace {
  id: string;
  clerkOrgId: string;
}

/** Poll/charge/renew a single due domain, recording the outcome in `stats`. */
async function renewDueDomain(
  ctx: SweepContext,
  db: Db,
  ws: SweepWorkspace,
  domain: DueDomain,
  stats: SweepStats,
): Promise<void> {
  try {
    if (domain.registrationStatus === 'pending_renewal') {
      const polled = await pollRenewalProcess(db, ctx.rtr, domain.id);
      if (polled?.registrationStatus === 'renewed') {
        stats.renewed += 1;
        return;
      }
      if (polled?.registrationStatus === 'pending_renewal') {
        stats.pending += 1;
        return;
      }
    }

    const result = await chargeAndRenewDomain(db, ctx.rtr, ctx.masterDb, {
      domainId: domain.id,
      workspaceId: ws.clerkOrgId,
      stripeSecretKey: ctx.stripeSecretKey,
    });

    if (!result.ok) {
      if (result.reason === 'already_renewed') return;
      console.warn(
        `[DomainAutoRenew] ws=${ws.id} domain=${domain.fullDomain} failed: ${result.reason}`,
      );
      stats.failed += 1;
      return;
    }

    stats.invoiced += 1;
    if (result.renewed) stats.renewed += 1;
    else if (result.pending) stats.pending += 1;
  } catch (err) {
    stats.failed += 1;
    console.error(`[DomainAutoRenew] ws=${ws.id} domain=${domain.fullDomain} error:`, err);
  }
}

/**
 * Process every due domain of one workspace.
 * Returns true when the per-invocation cap was hit and the sweep must stop.
 */
async function sweepWorkspaceDomains(
  ctx: SweepContext,
  db: Db,
  ws: SweepWorkspace,
  stats: SweepStats,
): Promise<boolean> {
  const due = await listDomainsDueForAutoRenew(db, ctx.now);
  stats.domainsScanned += due.length;

  for (const domain of due) {
    if (stats.processed >= DOMAIN_AUTO_RENEW_MAX_PER_SWEEP) return true;
    stats.processed += 1;
    await renewDueDomain(ctx, db, ws, domain, stats);
  }
  return false;
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
  const { workspaces } = masterSchema;

  const stats: SweepStats = {
    domainsScanned: 0,
    invoiced: 0,
    renewed: 0,
    pending: 0,
    failed: 0,
    processed: 0,
  };
  const ctx: SweepContext = {
    rtr,
    masterDb,
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    now: new Date(),
  };
  let hitCap = false;

  const sweep = await runDueIndexSweep({
    d1: env.SCHEDULE_INDEX,
    kv: env.WORKSPACE_CACHE,
    kind: 'domain_renew',
    label: '[DomainAutoRenew]',
    seed: {
      key: DOMAIN_RENEW_SEED_KEY,
      listWorkspaces: async () => {
        const rows = await masterDb
          .select({ clerkOrgId: workspaces.clerkOrgId })
          .from(workspaces)
          .where(and(eq(workspaces.isActive, true), isNotNull(workspaces.stripeCustomerId)));
        return rows.map((r) => r.clerkOrgId).filter((id): id is string => !!id);
      },
    },
    limit: WORKSPACES_PER_RUN,
    now: ctx.now.getTime(),
    shouldStop: () => hitCap,
    process: async (orgId) => {
      const [ws] = await masterDb
        .select({ id: workspaces.id, isActive: workspaces.isActive, stripeCustomerId: workspaces.stripeCustomerId })
        .from(workspaces)
        .where(eq(workspaces.clerkOrgId, orgId))
        .limit(1);
      // Gone, inactive or never billed: nothing can be renewed — drop it
      // without opening the tenant. Any later domain write marks it again.
      if (!ws?.isActive || !ws.stripeCustomerId) return null;

      const db = await getTenantDbForWorkspace(env, orgId);
      hitCap = await sweepWorkspaceDomains(ctx, db, { id: ws.id, clerkOrgId: orgId }, stats);
      // Still-due domains (cap hit, unpaid invoice) keep it due for tomorrow.
      return loadNextDomainRenewCheckAt(db, ctx.now);
    },
  });

  // A failed workspace stays due in the index and is retried tomorrow.
  const workspacesFailed = sweep.failed;
  const { domainsScanned, invoiced, renewed, pending, failed, processed } = stats;
  let skipped = 0;
  if (hitCap) {
    skipped = Math.max(0, domainsScanned - processed);
    console.warn(
      `[DomainAutoRenew] Hit per-invocation cap of ${DOMAIN_AUTO_RENEW_MAX_PER_SWEEP}; ${skipped} due domain(s) deferred to the next daily run`,
    );
  }

  console.log(
    `[DomainAutoRenew] Done. due=${sweep.due} workspaces=${sweep.processed} workspacesFailed=${workspacesFailed} scanned=${domainsScanned} invoiced=${invoiced} renewed=${renewed} pending=${pending} failed=${failed} skipped=${skipped}`,
  );

  return {
    workspacesScanned: sweep.processed,
    workspacesFailed,
    domainsScanned,
    invoiced,
    renewed,
    pending,
    failed,
    skipped,
  };
}
