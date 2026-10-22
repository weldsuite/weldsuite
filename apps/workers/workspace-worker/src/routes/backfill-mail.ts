/**
 * POST /api/backfill/mail
 *
 * Backfill WeldMail domains and default team@ accounts for existing workspaces,
 * on this environment's apex (WELDMAIL_DOMAIN). Re-asserts the Cloudflare
 * provisioning of every workspace, so it also repairs domains that were never
 * routed. Protected by M2M auth. Supports ?dryRun=true for preview.
 */

import { Hono } from 'hono';
import { eq, and, isNotNull } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http';
import * as schema from '@weldsuite/db/schema';
import { workspaces } from '@weldsuite/db/schema/master';
import { mailAccounts } from '@weldsuite/db/schema/mail-accounts';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import type { Env } from '../index';
import { getMasterDb } from '../db';
import { m2mAuth } from '../middleware/m2m-auth';
import { workspaceMailDomain } from '../services/mail-provisioning';
import { ensureWorkspaceMail } from '../services/workspace-mail';

interface BackfillResult {
  workspaceId: string;
  slug: string;
  status: 'created' | 'skipped' | 'failed';
  email?: string;
  reason?: string;
}

type BackfillWorkspace = Pick<
  typeof workspaces.$inferSelect,
  'id' | 'slug' | 'name' | 'databaseUrl' | 'neonProjectId' | 'neonBranchId' | 'neonRoleName' | 'neonDatabaseName'
>;

async function backfillWorkspace(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  ws: BackfillWorkspace,
  dryRun: boolean,
): Promise<BackfillResult> {
  const emailAddress = `team@${workspaceMailDomain(env, ws.slug)}`;

  try {
    // Resolve tenant database URL
    const dbUrl = await resolveDatabaseUrl(
      env.NEON_API_KEY,
      ws as any,
      { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 },
    );
    const tenantDb = drizzleNeonHttp({ client: neon(dbUrl), schema });

    if (dryRun) {
      const [existingAccount] = await tenantDb
        .select({ id: mailAccounts.id })
        .from(mailAccounts)
        .where(eq(mailAccounts.email, emailAddress))
        .limit(1);
      return existingAccount
        ? { workspaceId: ws.id, slug: ws.slug, status: 'skipped', email: emailAddress, reason: 'Account already exists (dry run)' }
        : { workspaceId: ws.id, slug: ws.slug, status: 'created', email: emailAddress, reason: 'dry run' };
    }

    // Domain row, Cloudflare provisioning (re-asserted even when team@
    // exists, so this also repairs a domain that was never routed) and the
    // team@ mailbox. Idempotent.
    const result = await ensureWorkspaceMail(env, {
      tenantDb,
      masterDb,
      workspaceId: ws.id,
      slug: ws.slug,
      displayName: ws.name,
    });

    if (!result.accountCreated) {
      console.log(`[Backfill Mail] Re-provisioned ${result.email} for workspace ${ws.id}`);
      return { workspaceId: ws.id, slug: ws.slug, status: 'skipped', email: result.email, reason: 'Account already exists; domain re-provisioned' };
    }
    console.log(`[Backfill Mail] Created ${result.email} for workspace ${ws.id}`);
    return { workspaceId: ws.id, slug: ws.slug, status: 'created', email: result.email };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Backfill Mail] Failed for workspace ${ws.id} (${ws.slug}):`, err);
    return { workspaceId: ws.id, slug: ws.slug, status: 'failed', reason: message };
  }
}

export const backfillMailRoutes = new Hono<{ Bindings: Env }>();

backfillMailRoutes.use('*', m2mAuth());

backfillMailRoutes.post('/mail', async (c) => {
  const dryRun = c.req.query('dryRun') === 'true';
  const masterDb = getMasterDb(c.env);

  if (!c.env.CLOUDFLARE_API_TOKEN) {
    return c.json({ error: 'CLOUDFLARE_API_TOKEN is required for Cloudflare Email Routing provisioning' }, 400);
  }

  // Fetch all active, provisioned workspaces
  const allWorkspaces = await masterDb
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      databaseUrl: workspaces.databaseUrl,
      neonProjectId: workspaces.neonProjectId,
      neonBranchId: workspaces.neonBranchId,
      neonRoleName: workspaces.neonRoleName,
      neonDatabaseName: workspaces.neonDatabaseName,
    })
    .from(workspaces)
    .where(and(
      eq(workspaces.isActive, true),
      isNotNull(workspaces.databaseProvisionedAt),
    ));

  console.log(`[Backfill Mail] Found ${allWorkspaces.length} provisioned workspaces (dryRun=${dryRun})`);

  const results: BackfillResult[] = [];

  for (const ws of allWorkspaces) {
    results.push(await backfillWorkspace(c.env, masterDb, ws, dryRun));
  }

  const summary = {
    total: results.length,
    created: results.filter((r) => r.status === 'created').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
  };

  console.log(`[Backfill Mail] Done: ${JSON.stringify(summary)}`);

  return c.json({ dryRun, summary, results });
});
