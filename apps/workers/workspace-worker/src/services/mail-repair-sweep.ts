/**
 * Hourly repair of WeldMail domains that provisioning left unrouted.
 *
 * Workspace onboarding provisions {slug}.{WELDMAIL_DOMAIN} on Cloudflare, but
 * a failure there is non-blocking (the workspace is usable without mail), so
 * a workspace can end up with an address that bounces. This sweep compares
 * recently created workspaces against the zone's Email Sending subdomains
 * (sending is the last provisioning step) and re-runs the idempotent mail
 * setup for the missing ones.
 *
 * Bounded on purpose: only workspaces from the last few days (older gaps are
 * the backfill route's job) and a handful per run, so a zone at Cloudflare's
 * 30-domain cap logs a few failures an hour instead of hammering the API.
 * Never throws.
 */

import { and, eq, gte, isNotNull, isNull } from 'drizzle-orm';
import { workspaces } from '@weldsuite/db/schema/master';
import type { Env } from '../index';
import { getMasterDb, getTenantDbForWorkspace } from '../db';
import { listProvisionedMailDomains, workspaceMailDomain } from './mail-provisioning';
import { ensureWorkspaceMail } from './workspace-mail';

const REPAIR_WINDOW_DAYS = 7;
const MAX_REPAIRS_PER_RUN = 5;

export async function repairWorkspaceMailDomains(env: Env): Promise<void> {
  try {
    const provisioned = await listProvisionedMailDomains(env);
    if (!provisioned) return;

    const masterDb = getMasterDb(env);
    const since = new Date(Date.now() - REPAIR_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const recent = await masterDb
      .select({
        id: workspaces.id,
        slug: workspaces.slug,
        name: workspaces.name,
        clerkOrgId: workspaces.clerkOrgId,
      })
      .from(workspaces)
      .where(and(
        eq(workspaces.isActive, true),
        isNull(workspaces.deletedAt),
        isNotNull(workspaces.databaseProvisionedAt),
        gte(workspaces.createdAt, since),
      ));

    const missing = recent.filter(
      (ws) => !provisioned.has(workspaceMailDomain(env, ws.slug).toLowerCase()),
    );
    if (missing.length === 0) return;
    console.log(
      `[MailRepair] ${missing.length} recent workspace(s) without a routed mail domain; repairing up to ${MAX_REPAIRS_PER_RUN}`,
    );

    for (const ws of missing.slice(0, MAX_REPAIRS_PER_RUN)) {
      try {
        if (!ws.clerkOrgId) continue;
        const result = await ensureWorkspaceMail(env, {
          tenantDb: await getTenantDbForWorkspace(env, ws.clerkOrgId),
          masterDb,
          workspaceId: ws.id,
          slug: ws.slug,
          displayName: ws.name,
        });
        console.log(`[MailRepair] Repaired ${result.domain} for workspace ${ws.id}`);
      } catch (err) {
        console.error(`[MailRepair] Could not repair the mail domain of workspace ${ws.id} (${ws.slug}):`, err);
      }
    }
  } catch (err) {
    console.error('[MailRepair] Sweep failed:', err);
  }
}
