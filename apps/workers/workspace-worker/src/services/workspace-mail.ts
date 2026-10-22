/**
 * A workspace's shared WeldMail setup: the tenant `mail_domains` row for
 * {slug}.{WELDMAIL_DOMAIN}, its Cloudflare provisioning, and the default
 * `team@` mailbox (account, system labels, master registry row).
 *
 * One idempotent routine behind the provisioning workflow, the backfill
 * route and the repair sweep, so a run that failed half-way is finished by
 * the next one. The domain row starts `pending` and only turns `verified`
 * once Cloudflare accepted the provisioning: WeldDesk and the mail setup
 * only offer verified domains, so a domain Cloudflare never routed is no
 * longer presented as working.
 */

import { eq } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import type * as schema from '@weldsuite/db/schema';
import { mailAccountRegistry } from '@weldsuite/db/schema/master';
import { mailDomains } from '@weldsuite/db/schema/mail-domains';
import { mailAccounts } from '@weldsuite/db/schema/mail-accounts';
import { mailLabels } from '@weldsuite/db/schema/mail-labels';
import type { Env } from '../index';
import type { getMasterDb } from '../db';
import { generateId } from '../lib/id';
import { provisionMailDomain, workspaceMailDomain } from './mail-provisioning';

type TenantDb = NeonHttpDatabase<typeof schema>;
type MasterDb = ReturnType<typeof getMasterDb>;

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

export interface EnsureWorkspaceMailInput {
  tenantDb: TenantDb;
  masterDb: MasterDb;
  workspaceId: string;
  slug: string;
  /** Display name of the `team@` mailbox; defaults to the slug. */
  displayName?: string | null;
}

export interface EnsureWorkspaceMailResult {
  domain: string;
  domainId: string;
  email: string;
  accountId: string;
  /** False when `team@` already existed. */
  accountCreated: boolean;
  /** False when Cloudflare isn't configured (local dev): the domain stays pending. */
  provisioned: boolean;
}

/**
 * Throws when Cloudflare refuses the provisioning; the domain row is then
 * left `pending` and no mailbox is created, so a retry (workflow step retry,
 * backfill, repair sweep) picks it up from there.
 */
export async function ensureWorkspaceMail(
  env: Env,
  input: EnsureWorkspaceMailInput,
): Promise<EnsureWorkspaceMailResult> {
  const { tenantDb, masterDb, workspaceId, slug } = input;
  const domain = workspaceMailDomain(env, slug);
  const email = `team@${domain}`;
  const now = new Date();

  // 1. Tenant mail_domains row (idempotent), pending until Cloudflare accepts.
  const [existingDomain] = await tenantDb
    .select({ id: mailDomains.id, dnsStatus: mailDomains.dnsStatus })
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
      dnsStatus: 'pending',
      maxEmailAccounts: 10,
      currentEmailAccounts: 0,
    });
    console.log(`[WorkspaceMail] Created mail domain ${domain}: ${domainId}`);
  }

  // 2. Cloudflare (idempotent). Runs on every call, so a re-run repairs a
  // workspace whose mailbox exists but whose domain was never routed.
  const provisioned = await provisionMailDomain(env, masterDb, workspaceId, slug);
  if (provisioned && existingDomain?.dnsStatus !== 'verified') {
    await tenantDb
      .update(mailDomains)
      .set({ dnsStatus: 'verified', updatedAt: now })
      .where(eq(mailDomains.id, domainId));
  }

  // 3. Default team@ mailbox (idempotent).
  const [existingAccount] = await tenantDb
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(eq(mailAccounts.email, email))
    .limit(1);
  if (existingAccount) {
    return { domain, domainId, email, accountId: existingAccount.id, accountCreated: false, provisioned };
  }

  // Cloudflare Email Routing has no per-mailbox principal — routing happens at
  // the zone level via the catch-all rule, so there is no provider account.
  const accountId = generateId('mail');
  await tenantDb.insert(mailAccounts).values({
    id: accountId,
    name: 'Team',
    email,
    displayName: input.displayName || slug,
    provider: 'cloudflare',
    authType: 'password',
    syncEnabled: true,
    status: 'active',
    isDefault: true,
    isShared: true,
    createdAt: now,
    updatedAt: now,
  });

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
    })),
  );

  // The inbound worker routes by this registry row.
  await masterDb
    .insert(mailAccountRegistry)
    .values({
      id: generateId('reg'),
      email,
      workspaceId,
      accountId,
      isActive: true,
    })
    .onConflictDoNothing();

  await tenantDb
    .update(mailDomains)
    .set({ currentEmailAccounts: 1, updatedAt: now })
    .where(eq(mailDomains.id, domainId));

  console.log(`[WorkspaceMail] Created mail account ${email} (${accountId}) for workspace ${workspaceId}`);
  return { domain, domainId, email, accountId, accountCreated: true, provisioned };
}
