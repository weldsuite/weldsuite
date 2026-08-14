/**
 * Domain auto-renew sweep — daily Cloudflare Cron Handler
 *
 * Walks every active workspace, finds Realtime Register domains whose
 * expiry is inside the renewal window with auto-renew on, invoices the
 * workspace Stripe customer, and renews at the registrar only after
 * payment succeeds.
 *
 * Wired into the daily cron ("0 4 * * *") next to calendar replan.
 */

import { eq } from 'drizzle-orm';
import type { Env } from '../types';
import { getMasterDb, getTenantDbForWorkspace, masterSchema } from '../db';
import { getRealtimeRegistrar } from '../lib/realtime-registrar';
import {
  chargeAndRenewDomain,
  listDomainsDueForAutoRenew,
} from '../services/domain-renewal-billing';
import { pollRenewalProcess } from '../services/domains';

export async function runDomainAutoRenewSweep(env: Env): Promise<{
  workspacesScanned: number;
  domainsScanned: number;
  invoiced: number;
  renewed: number;
  pending: number;
  failed: number;
}> {
  console.log('[DomainAutoRenew] Starting daily sweep');

  const rtr = getRealtimeRegistrar(env);
  if (!rtr) {
    console.warn('[DomainAutoRenew] Realtime Register is not configured — skipping');
    return { workspacesScanned: 0, domainsScanned: 0, invoiced: 0, renewed: 0, pending: 0, failed: 0 };
  }
  if (!env.STRIPE_SECRET_KEY) {
    console.warn('[DomainAutoRenew] STRIPE_SECRET_KEY is not configured — skipping');
    return { workspacesScanned: 0, domainsScanned: 0, invoiced: 0, renewed: 0, pending: 0, failed: 0 };
  }

  const masterDb = getMasterDb(env);
  const workspaces = await masterDb
    .select({
      id: masterSchema.workspaces.id,
      clerkOrgId: masterSchema.workspaces.clerkOrgId,
      stripeCustomerId: masterSchema.workspaces.stripeCustomerId,
    })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.isActive, true));

  let wholesaleRenew = new Map<string, { renewCents?: number; currency: string }>();
  try {
    wholesaleRenew = await rtr.getPricelist();
  } catch (err) {
    console.warn('[DomainAutoRenew] pricelist fetch failed, falling back to catalog renewalPrice:', err);
  }

  let domainsScanned = 0;
  let invoiced = 0;
  let renewed = 0;
  let pending = 0;
  let failed = 0;
  const now = new Date();

  for (const ws of workspaces) {
    if (!ws.clerkOrgId) continue;
    if (!ws.stripeCustomerId) continue;

    try {
      const db = await getTenantDbForWorkspace(env, ws.clerkOrgId);
      const due = await listDomainsDueForAutoRenew(db, now);
      domainsScanned += due.length;

      for (const domain of due) {
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

          const tld = domain.tld.replace(/^\./, '').toLowerCase();
          const wholesale = wholesaleRenew.get(tld);
          const result = await chargeAndRenewDomain(db, rtr, masterDb, {
            domainId: domain.id,
            workspaceId: ws.clerkOrgId,
            stripeSecretKey: env.STRIPE_SECRET_KEY,
            wholesaleRenewCents: wholesale?.renewCents ?? null,
            wholesaleCurrency: wholesale?.currency ?? null,
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
    } catch (err) {
      console.error(`[DomainAutoRenew] Workspace ${ws.id} failed:`, err);
      failed += 1;
    }
  }

  console.log(
    `[DomainAutoRenew] Done. workspaces=${workspaces.length} scanned=${domainsScanned} invoiced=${invoiced} renewed=${renewed} pending=${pending} failed=${failed}`,
  );

  return {
    workspacesScanned: workspaces.length,
    domainsScanned,
    invoiced,
    renewed,
    pending,
    failed,
  };
}
