/**
 * POST /api/backfill/mail
 *
 * Backfill WeldMail domains and default team@ accounts for existing workspaces.
 * Protected by M2M auth. Supports ?dryRun=true for preview.
 */

import { Hono } from 'hono';
import { eq, and, isNotNull } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http';
import * as schema from '@weldsuite/db/schema';
import { workspaces, mailAccountRegistry } from '@weldsuite/db/schema/master';
import { mailDomains } from '@weldsuite/db/schema/mail-domains';
import { mailAccounts } from '@weldsuite/db/schema/mail-accounts';
import { mailLabels } from '@weldsuite/db/schema/mail-labels';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import type { Env } from '../index';
import { getMasterDb } from '../db';
import { generateId } from '../lib/id';
import { m2mAuth } from '../middleware/m2m-auth';
import { provisionMailDomain } from '../services/mail-provisioning';

interface BackfillResult {
  workspaceId: string;
  slug: string;
  status: 'created' | 'skipped' | 'failed';
  email?: string;
  reason?: string;
}

const SYSTEM_LABELS = [
  { name: 'Inbox', slug: 'INBOX' },
  { name: 'Sent', slug: 'SENT' },
  { name: 'Drafts', slug: 'DRAFTS' },
  { name: 'Trash', slug: 'TRASH' },
  { name: 'Spam', slug: 'SPAM' },
  { name: 'Starred', slug: 'STARRED' },
  { name: 'Important', slug: 'IMPORTANT' },
  { name: 'Archive', slug: 'ARCHIVE' },
  { name: 'Snoozed', slug: 'SNOOZED' },
  { name: 'Scheduled', slug: 'SCHEDULED' },
];

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
    const domain = `${ws.slug}.weldmail.com`;
    const emailAddress = `team@${domain}`;

    try {
      // Resolve tenant database URL
      const dbUrl = await resolveDatabaseUrl(
        c.env.NEON_API_KEY,
        ws as any,
        { v1: c.env.DATABASE_ENCRYPTION_KEY, v2: c.env.DATABASE_ENCRYPTION_KEY_V2 },
      );
      const sql = neon(dbUrl);
      const tenantDb = drizzleNeonHttp({ client: sql, schema });

      // Check if account already exists
      const [existingAccount] = await tenantDb
        .select({ id: mailAccounts.id })
        .from(mailAccounts)
        .where(eq(mailAccounts.email, emailAddress))
        .limit(1);

      if (existingAccount) {
        results.push({ workspaceId: ws.id, slug: ws.slug, status: 'skipped', reason: 'Account already exists' });
        continue;
      }

      if (dryRun) {
        results.push({ workspaceId: ws.id, slug: ws.slug, status: 'created', email: emailAddress, reason: 'dry run' });
        continue;
      }

      // 1. Provision Cloudflare Email Routing for {slug}.weldmail.com — a
      // subdomain of the shared weldmail.com zone (idempotent — re-enabling
      // routing is a no-op server-side).
      await provisionMailDomain(c.env, masterDb, ws.id, ws.slug);

      // 2. Insert mail_domains record (idempotent)
      const [existingDomain] = await tenantDb
        .select({ id: mailDomains.id })
        .from(mailDomains)
        .where(eq(mailDomains.domainName, domain))
        .limit(1);

      let domainId: string;
      if (existingDomain) {
        domainId = existingDomain.id;
      } else {
        domainId = generateId('mdom');
        await tenantDb.insert(mailDomains).values({
          id: domainId,
          domainName: domain,
          isActive: true,
          isPrimary: true,
          mailProvider: 'cloudflare',
          sendProvider: 'cloudflare',
          receiveProvider: 'cloudflare',
          dnsStatus: 'verified',
          maxEmailAccounts: 10,
          currentEmailAccounts: 0,
        });
      }

      // 3. Insert mail_accounts record. Cloudflare Email Routing has no
      // per-mailbox principal — routing happens at the zone level via the
      // catch-all rule, so there is no account to create with the provider.
      const accountId = generateId('mail');
      const now = new Date();
      await tenantDb.insert(mailAccounts).values({
        id: accountId,
        name: 'Team',
        email: emailAddress,
        displayName: ws.name || ws.slug,
        provider: 'cloudflare',
        authType: 'password',
        syncEnabled: true,
        status: 'active',
        isDefault: true,
        isShared: true,
        createdAt: now,
        updatedAt: now,
      });

      // 4. Create system labels
      await tenantDb.insert(mailLabels).values(
        SYSTEM_LABELS.map((label) => ({
          id: generateId('label'),
          accountId,
          name: label.name,
          slug: label.slug,
          isSystem: true,
          messageCount: 0,
          createdAt: now,
          updatedAt: now,
        }))
      );

      // 5. Register in master DB
      await masterDb
        .insert(mailAccountRegistry)
        .values({
          id: generateId('reg'),
          email: emailAddress,
          workspaceId: ws.id,
          accountId,
          isActive: true,
        })
        .onConflictDoNothing();

      // 6. Update domain account count
      await tenantDb.update(mailDomains)
        .set({ currentEmailAccounts: 1, updatedAt: now })
        .where(eq(mailDomains.id, domainId));

      results.push({ workspaceId: ws.id, slug: ws.slug, status: 'created', email: emailAddress });
      console.log(`[Backfill Mail] Created ${emailAddress} for workspace ${ws.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Backfill Mail] Failed for workspace ${ws.id} (${ws.slug}):`, err);
      results.push({ workspaceId: ws.id, slug: ws.slug, status: 'failed', reason: message });
    }
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
