/**
 * ProvisionWorkspaceWorkflow — Cloudflare Workflow
 *
 * Replaces the Trigger.dev `migrate-tenant-database` task.
 * Provisions a newly created tenant database: applies Drizzle migrations,
 * inserts initial member, installs apps, seeds sample data, sets up
 * billing/credits, and marks the workspace as provisioned.
 *
 * Uses the workspace ID as the workflow instance ID for idempotency.
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { eq, inArray } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http';
import * as schema from '@weldsuite/db/schema';
import { workspaceMembers } from '@weldsuite/db/schema/workspace-members';
import { workspaceInstalledApps } from '@weldsuite/db/schema/workspace-installed-apps';
import { taskDigestSettings } from '@weldsuite/db/schema/task-digest-settings';
import { workspaceSettings } from '@weldsuite/db/schema/workspace-settings';
import { helpdeskWorkflows } from '@weldsuite/db/schema/helpdesk-workflows';
import { workspaces, plans, workspaceCredits, creditTransactions, digestSchedules, mailAccountRegistry } from '@weldsuite/db/schema/master';
import { mailDomains } from '@weldsuite/db/schema/mail-domains';
import { mailAccounts } from '@weldsuite/db/schema/mail-accounts';
import { mailLabels } from '@weldsuite/db/schema/mail-labels';
import { encryptField, keyringFromEnv } from '@weldsuite/db/lib/crypto';
import type { Env } from '../index';
import { getMasterDb } from '../db';
import { generateId } from '../lib/id';
import { setupWorkspaceBilling } from '../services/provisioning';
import { provisionMailDomain } from '../services/mail-provisioning';
import { applyTenantMigrations } from '../lib/tenant-migrations';
import { getDefaultHelpdeskWorkflows, DEFAULT_WORKFLOW_TEMPLATE_IDS } from './default-helpdesk-workflows';
import { seedSampleData } from './seed-data';

// ── Types ────────────────────────────────────────────────────────────────

export interface InitialMember {
  userId: string;
  email?: string;
  name?: string;
  picture?: string;
  clerkMembershipId?: string;
}

export interface ProvisionWorkspaceParams {
  workspaceId: string;
  databaseUrl: string;
  workspaceName?: string;
  initialMember?: InitialMember;
  selectedApps?: string[];
  slug?: string;
  /**
   * Whether to seed demo/sample data. Defaults to true (onboarding behavior).
   * Additional workspaces created from within the platform pass false so they
   * start clean — they still get the selected apps installed, just no demo rows.
   */
  seedSampleData?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function createTenantDb(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return drizzleNeonHttp({ client: sql, schema });
}

// ── Workflow ─────────────────────────────────────────────────────────────

export class ProvisionWorkspaceWorkflow extends WorkflowEntrypoint<Env, ProvisionWorkspaceParams> {
  async run(event: WorkflowEvent<ProvisionWorkspaceParams>, step: WorkflowStep) {
    const { workspaceId, workspaceName } = event.payload;

    console.log(`[Provision] Starting provisioning for workspace ${workspaceId} (${workspaceName || 'unnamed'})`);

    // Flip status to 'provisioning' so the onboarding UI shows progress rather
    // than sitting on 'pending'/'failed' while the steps below run.
    await step.do('mark-provisioning', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
    }, async () => {
      const masterDb = getMasterDb(this.env);
      await masterDb
        .update(workspaces)
        .set({ provisioningStatus: 'provisioning', provisioningError: null, updatedAt: new Date() })
        .where(eq(workspaces.id, workspaceId));
      return { ok: true };
    });

    try {
      return await this.provisionSteps(event, step);
    } catch (err) {
      // A step exhausted its retries. Persist a terminal 'failed' status so the
      // onboarding UI can offer a retry instead of polling forever, then rethrow
      // so Cloudflare marks the workflow instance errored.
      const message = err instanceof Error ? err.message : 'Unknown provisioning error';
      console.error(`[Provision] Workspace ${workspaceId} provisioning failed:`, err);
      try {
        const masterDb = getMasterDb(this.env);
        // Only flip to terminal 'failed' if the workspace never reached ready.
        // mark-provisioned now runs mid-workflow; a failure in a post-ready tail
        // step (mail/digest/credits/billing) must not yank an already-admitted
        // user back into a failed onboarding screen. The error is still recorded.
        const [ws] = await masterDb
          .select({ databaseProvisionedAt: workspaces.databaseProvisionedAt })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .limit(1);
        await masterDb
          .update(workspaces)
          .set({
            ...(ws?.databaseProvisionedAt ? {} : { provisioningStatus: 'failed' as const }),
            provisioningError: message.slice(0, 1000),
            updatedAt: new Date(),
          })
          .where(eq(workspaces.id, workspaceId));
      } catch (statusErr) {
        console.error('[Provision] Failed to record failed status:', statusErr);
      }
      throw err;
    }
  }

  private async provisionSteps(event: WorkflowEvent<ProvisionWorkspaceParams>, step: WorkflowStep) {
    const { workspaceId, databaseUrl, workspaceName, initialMember, selectedApps, slug, seedSampleData: shouldSeedSampleData } = event.payload;

    // ── Step 1: Apply schema migrations ──────────────────────────────────
    // Delta-applier shared with RefillPoolWorkflow — a warm pool database has
    // everything pre-applied, so this completes in a single instant batch for
    // pool claims. Budgeted batches across steps: the full journal (~2,600
    // statements, each one a neon-http subrequest) exceeds what one step
    // attempt / Worker invocation may do and dies as WorkflowInternalError.
    const migrationResult = { applied: 0, skipped: 0 };
    for (let batch = 0; ; batch++) {
      const result = await step.do(`apply-migrations-${batch}`, {
        retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
      }, async () => {
        const db = createTenantDb(databaseUrl);
        return applyTenantMigrations(db, { statementBudget: 600 });
      });
      migrationResult.applied += result.applied;
      migrationResult.skipped = result.skipped;
      if (result.remaining === 0) break;
    }
    console.log(`[Provision] Migrations for ${workspaceId}: ${migrationResult.applied} applied, ${migrationResult.skipped} already present`);

    // ── Step 2: Insert initial member ────────────────────────────────────
    if (initialMember) {
      await step.do('insert-initial-member', {
        retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
      }, async () => {
        const db = createTenantDb(databaseUrl);

        // Check if member already exists (idempotent)
        const [existing] = await db
          .select({ id: workspaceMembers.id })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.userId, initialMember.userId))
          .limit(1);

        if (existing) {
          console.log(`[Provision] Member already exists: ${existing.id}, skipping`);
          return { inserted: false };
        }

        await db.insert(workspaceMembers).values({
          id: generateId('mbr'),
          userId: initialMember.userId,
          email: initialMember.email,
          name: initialMember.name,
          picture: initialMember.picture,
          role: 'OWNER',
          status: 'ACTIVE',
          clerkMembershipId: initialMember.clerkMembershipId,
          acceptedAt: new Date(),
        });

        console.log(`[Provision] Initial member inserted for workspace ${workspaceId}`);
        return { inserted: true };
      });
    }

    // ── Step 3: Install selected apps ────────────────────────────────────
    if (selectedApps && selectedApps.length > 0) {
      await step.do('install-apps', {
        retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
      }, async () => {
        const db = createTenantDb(databaseUrl);
        const now = new Date();

        for (const appCode of selectedApps) {
          try {
            await db.insert(workspaceInstalledApps).values({
              id: generateId('app'),
              appCode,
              isActive: true,
              displayOrder: 0,
              installedAt: now,
              installedBy: initialMember?.userId,
            }).onConflictDoNothing();
          } catch (appError) {
            console.warn(`[Provision] Failed to install app ${appCode}:`, appError);
          }
        }

        console.log(`[Provision] Installed ${selectedApps.length} apps for workspace ${workspaceId}`);
        return { installed: selectedApps.length };
      });
    }

    // ── Step 4: Mark workspace READY ──────────────────────────────────────
    // Everything the dashboard needs on first paint now exists: migrated
    // schema, the OWNER member, and the installed apps. Mark the workspace
    // provisioned HERE so the user can enter immediately — the remaining
    // steps (helpdesk seeds, sample data, mail account, digest, credits,
    // billing) complete in the background and nothing gates on them.
    await step.do('mark-provisioned', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
    }, async () => {
      const masterDb = getMasterDb(this.env);

      const updateData: Record<string, unknown> = {
        databaseProvisionedAt: new Date(),
        provisioningStatus: 'ready',
        provisioningError: null,
        updatedAt: new Date(),
      };

      // Store connection URL — encrypted if key is available
      if (this.env.DATABASE_ENCRYPTION_KEY || this.env.DATABASE_ENCRYPTION_KEY_V2) {
        try {
          const encrypted = await encryptField(databaseUrl, keyringFromEnv(this.env));
          updateData.databaseUrl = encrypted;
          console.log(`[Provision] Encrypted connection string stored`);
        } catch (encryptError) {
          console.warn(`[Provision] Failed to encrypt, storing plaintext:`, encryptError);
          updateData.databaseUrl = databaseUrl;
        }
      } else {
        updateData.databaseUrl = databaseUrl;
        console.log(`[Provision] Plaintext connection string stored (no encryption key)`);
      }

      await masterDb
        .update(workspaces)
        .set(updateData)
        .where(eq(workspaces.id, workspaceId));

      console.log(`[Provision] Workspace ${workspaceId} marked as provisioned`);
      return { provisioned: true, migrationsApplied: migrationResult.applied };
    });

    if (selectedApps && selectedApps.length > 0) {
      // ── Step 5: Seed default helpdesk workflows ──────────────────────
      const hasHelpdesk = selectedApps.includes('welddesk') || selectedApps.includes('helpdesk');
      if (hasHelpdesk || selectedApps.length === 0) {
        await step.do('seed-helpdesk-workflows', {
          retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
        }, async () => {
          const db = createTenantDb(databaseUrl);

          const existingDefaults = await db
            .select({ templateId: helpdeskWorkflows.templateId })
            .from(helpdeskWorkflows)
            .where(
              inArray(helpdeskWorkflows.templateId, [...DEFAULT_WORKFLOW_TEMPLATE_IDS]),
            );

          const existingTemplateIds = new Set(existingDefaults.map((w) => w.templateId));
          const defaults = getDefaultHelpdeskWorkflows(generateId);
          const toInsert = defaults.filter(
            (wf) => wf.templateId && !existingTemplateIds.has(wf.templateId),
          );

          if (toInsert.length > 0) {
            await db.insert(helpdeskWorkflows).values(toInsert);
            console.log(`[Provision] Seeded ${toInsert.length} default helpdesk workflows`);
          }

          return { seeded: toInsert.length };
        });
      }

      // ── Step 6: Seed sample data ─────────────────────────────────────
      // Skipped for additional workspaces (seedSampleData === false) — they get
      // the selected apps but start without demo rows.
      if (initialMember && shouldSeedSampleData !== false) {
        await step.do('seed-sample-data', {
          retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
        }, async () => {
          const db = createTenantDb(databaseUrl);

          const seedResult = await seedSampleData(db, {
            generateId,
            userId: initialMember.userId,
            userName: initialMember.name,
          }, selectedApps);

          console.log(
            `[Provision] Sample data: ${seedResult.seeded.length} modules seeded, ${seedResult.errors.length} errors`,
          );
          return seedResult;
        });
      }
    }

    // ── Step 7: Provision WeldMail domain and default account ─────────────
    // Non-fatal: the workspace is fully usable without email, so a mail
    // failure must not fail the workflow (POST /api/backfill/mail can
    // complete the mail setup later). The .catch below only fires after the
    // step's own retries are exhausted.
    await step.do('provision-mail-account', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
    }, async () => {
      if (!this.env.CLOUDFLARE_API_TOKEN || !slug) {
        console.log(`[Provision] Skipping mail provisioning: CLOUDFLARE_API_TOKEN=${!!this.env.CLOUDFLARE_API_TOKEN}, slug=${slug || 'missing'}`);
        return { skipped: true, reason: 'Cloudflare API token not configured or slug missing' };
      }

      const db = createTenantDb(databaseUrl);
      const masterDb = getMasterDb(this.env);
      const domain = `${slug}.weldmail.com`;
      const emailAddress = `team@${domain}`;
      const now = new Date();

      // 1. Insert mail_domains record (idempotent)
      const [existingDomain] = await db
        .select({ id: mailDomains.id })
        .from(mailDomains)
        .where(eq(mailDomains.domainName, domain))
        .limit(1);

      let domainId: string;
      if (existingDomain) {
        domainId = existingDomain.id;
        console.log(`[Provision] Mail domain ${domain} already exists: ${domainId}`);
      } else {
        domainId = generateId('mdom');
        await db.insert(mailDomains).values({
          id: domainId,
          domainName: domain,
          isActive: true,
          isPrimary: true,
          mailProvider: 'cloudflare',
          sendProvider: 'cloudflare',
          receiveProvider: 'cloudflare',
          dnsStatus: 'verified', // *.weldmail.com DNS is pre-configured
          maxEmailAccounts: 10,
          currentEmailAccounts: 0,
        });
        console.log(`[Provision] Created mail domain ${domain}: ${domainId}`);
      }

      // 2. Check if account already exists
      const [existingAccount] = await db
        .select({ id: mailAccounts.id })
        .from(mailAccounts)
        .where(eq(mailAccounts.email, emailAddress))
        .limit(1);

      if (existingAccount) {
        console.log(`[Provision] Mail account ${emailAddress} already exists: ${existingAccount.id}`);
        return { skipped: true, reason: 'Account already exists', accountId: existingAccount.id, domainId };
      }

      // 3. Ensure Cloudflare Email Routing is provisioned for
      // {slug}.weldmail.com — a subdomain of the shared weldmail.com zone
      // (idempotent — may already exist from onboard.ts).
      await provisionMailDomain(this.env, masterDb, workspaceId, slug);

      // 4. Insert mail_accounts record. Cloudflare Email Routing has no
      // per-mailbox principal — routing happens at the zone level via the
      // catch-all rule, so there is no account to create with the provider.
      const accountId = generateId('mail');
      await db.insert(mailAccounts).values({
        id: accountId,
        name: 'Team',
        email: emailAddress,
        displayName: workspaceName || slug,
        provider: 'cloudflare',
        authType: 'password',
        syncEnabled: true,
        status: 'active',
        isDefault: true,
        isShared: true,
        createdAt: now,
        updatedAt: now,
      });

      // 5. Create system labels
      const systemLabels = [
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
      await db.insert(mailLabels).values(
        systemLabels.map((label) => ({
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

      // 6. Register in master DB for inbound routing
      await masterDb
        .insert(mailAccountRegistry)
        .values({
          id: generateId('reg'),
          email: emailAddress,
          workspaceId,
          accountId,
          isActive: true,
        })
        .onConflictDoNothing();

      // 7. Update domain account count
      await db.update(mailDomains)
        .set({ currentEmailAccounts: 1, updatedAt: now })
        .where(eq(mailDomains.id, domainId));

      console.log(`[Provision] Created mail account ${emailAddress} (${accountId}) for workspace ${workspaceId}`);
      return { created: true, email: emailAddress, accountId, domainId };
    }).catch((mailErr) => {
      console.error(`[Provision] Mail provisioning failed (non-blocking) for workspace ${workspaceId}:`, mailErr);
    });

    // ── Step 8: Setup default digest schedule ────────────────────────────
    await step.do('setup-digest', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
    }, async () => {
      const db = createTenantDb(databaseUrl);

      // Insert default task_digest_settings in tenant DB (singleton row)
      const [existingDigest] = await db
        .select()
        .from(taskDigestSettings)
        .limit(1);

      if (!existingDigest) {
        await db.insert(taskDigestSettings).values({
          id: generateId('tds'),
          enabled: true,
          sendHour: 8,
          taskTypes: { projectTasks: true, personalTasks: true },
          sections: { overdue: true, dueToday: true, dueThisWeek: true },
        });
        console.log(`[Provision] Default digest settings created`);
      }

      // Read workspace timezone (may not exist yet for new workspaces)
      const [wsSettings] = await db
        .select({ timezone: workspaceSettings.timezone })
        .from(workspaceSettings)
        .limit(1);

      const timezone = wsSettings?.timezone || 'Europe/Amsterdam';

      // Insert digest_schedules row in master DB
      const masterDb = getMasterDb(this.env);
      await masterDb
        .insert(digestSchedules)
        .values({
          id: generateId('ds'),
          workspaceId,
          enabled: true,
          sendHour: 8,
          timezone,
        })
        .onConflictDoNothing();

      console.log(`[Provision] Digest schedule created (tz: ${timezone})`);
      return { timezone };
    });

    // ── Step 9: Initialize workspace credits ─────────────────────────────
    await step.do('initialize-credits', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
    }, async () => {
      const masterDb = getMasterDb(this.env);

      const [workspaceRow] = await masterDb
        .select({ planId: workspaces.planId })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);

      let planMonthlyCredits = 0;
      if (workspaceRow?.planId) {
        const [plan] = await masterDb
          .select({ monthlyCredits: plans.monthlyCredits })
          .from(plans)
          .where(eq(plans.id, workspaceRow.planId))
          .limit(1);
        planMonthlyCredits = plan?.monthlyCredits ?? 0;
      }

      if (planMonthlyCredits > 0) {
        const now = new Date();
        const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
        const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));

        await masterDb.insert(workspaceCredits).values({
          id: generateId('crd'),
          workspaceId,
          currentBalance: planMonthlyCredits,
          planCredits: planMonthlyCredits,
          subscribedCredits: 0,
          monthlyAllocation: planMonthlyCredits,
          rolledOverCredits: 0,
          rolloverCap: null,
          periodStart,
          periodEnd,
          lastResetAt: now,
        }).onConflictDoNothing();

        await masterDb.insert(creditTransactions).values({
          id: generateId('ctx'),
          workspaceId,
          type: 'monthly_allocation',
          amount: planMonthlyCredits,
          balanceAfter: planMonthlyCredits,
          description: `Initial credit allocation of ${planMonthlyCredits} credits`,
          metadata: {
            reason: 'workspace_creation',
            planCredits: planMonthlyCredits,
          },
        });

        console.log(`[Provision] Allocated ${planMonthlyCredits} initial credits`);
        return { credits: planMonthlyCredits };
      }

      return { credits: 0 };
    });

    // ── Step 10: Setup Stripe billing ────────────────────────────────────
    await step.do('setup-billing', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
    }, async () => {
      const masterDb = getMasterDb(this.env);

      const [workspaceRow] = await masterDb
        .select({ clerkOrgId: workspaces.clerkOrgId })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);

      const result = await setupWorkspaceBilling(
        this.env,
        masterDb,
        workspaceId,
        workspaceName || workspaceId,
        workspaceRow?.clerkOrgId || '',
      );

      if (result.warning) {
        console.warn(`[Provision] Billing warning: ${result.warning}`);
      } else {
        console.log(`[Provision] Billing set up: customer=${result.customerId}, subscription=${result.subscriptionId}`);
      }

      return result;
    });

    return { provisioned: true, migrationsApplied: migrationResult.applied };
  }
}
