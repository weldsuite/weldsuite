/**
 * WeldMail (shared `{slug}.weldmail.com` addresses) service.
 *
 * Every workspace gets a free shared subdomain at `{workspace.slug}.weldmail.com`.
 * Users can reserve plain-name addresses on it (e.g. `hello@acme.weldmail.com`)
 * up to their plan's `maxWeldMailAddresses` cap. Reservation creates a
 * `mail_accounts` row in the tenant DB and registers the email in the
 * master `mailAccountRegistry` so the inbound worker can route mail
 * back to the right workspace.
 *
 * Cloudflare Email Routing is provisioned once per shared zone (handled
 * at workspace-creation time), so the per-address reserve flow is
 * purely DB-side.
 */

import { and, eq, isNull, like } from 'drizzle-orm';
import { getMasterDb, masterSchema, schema } from '../../db';
import type { Database } from '../../db';
import type { Env } from '../../types';
import { generateId } from '../../lib/id';
import type { PlanFeatures } from '@weldsuite/db/schema/plans';

const DEFAULT_MAX_WELDMAIL_ADDRESSES = 2;
const DEFAULT_WELDMAIL_ENABLED = true;

/** Addresses reserved at the platform level — can never be claimed. */
export const RESERVED_ADDRESSES: ReadonlySet<string> = new Set([
  'admin', 'administrator', 'support', 'help', 'info', 'contact',
  'sales', 'billing', 'noreply', 'no-reply', 'postmaster', 'hostmaster',
  'webmaster', 'abuse', 'security', 'mailer-daemon', 'root', 'system',
  'mail', 'email', 'test', 'dev', 'staging', 'prod', 'production',
  'api', 'www', 'ftp', 'smtp', 'imap', 'pop',
  'weld', 'weldsuite', 'weldmail',
]);

export class WeldMailError extends Error {
  constructor(
    public readonly code:
      | 'WORKSPACE_NOT_FOUND'
      | 'RESERVED_ADDRESS'
      | 'ADDRESS_TAKEN'
      | 'PLAN_DISABLED'
      | 'PLAN_LIMIT_REACHED'
      | 'ADDRESS_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'WeldMailError';
  }
}

interface WeldMailLimits {
  enabled: boolean;
  /** null = unlimited */
  maxAddresses: number | null;
}

export function weldMailDomainFor(slug: string): string {
  return `${slug}.weldmail.com`;
}

async function getWorkspace(env: Env, orgId: string) {
  const masterDb = getMasterDb(env);
  const [workspace] = await masterDb
    .select({ id: masterSchema.workspaces.id, slug: masterSchema.workspaces.slug })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.clerkOrgId, orgId))
    .limit(1);
  return workspace ?? null;
}

async function getLimits(env: Env, orgId: string): Promise<WeldMailLimits> {
  try {
    const masterDb = getMasterDb(env);
    const [row] = await masterDb
      .select({
        planId: masterSchema.workspaces.planId,
        planFeatures: masterSchema.plans.features,
        planIsDefault: masterSchema.plans.isDefault,
        planSlug: masterSchema.plans.slug,
      })
      .from(masterSchema.workspaces)
      .leftJoin(masterSchema.plans, eq(masterSchema.workspaces.planId, masterSchema.plans.id))
      .where(eq(masterSchema.workspaces.clerkOrgId, orgId))
      .limit(1);

    if (!row?.planId || !row.planFeatures) {
      return { enabled: DEFAULT_WELDMAIL_ENABLED, maxAddresses: DEFAULT_MAX_WELDMAIL_ADDRESSES };
    }
    const features = row.planFeatures as PlanFeatures;
    const isFreePlan = row.planIsDefault || row.planSlug === 'free';
    return {
      enabled: features.weldMailEnabled ?? DEFAULT_WELDMAIL_ENABLED,
      maxAddresses: features.maxWeldMailAddresses
        ?? (isFreePlan ? DEFAULT_MAX_WELDMAIL_ADDRESSES : null),
    };
  } catch (err) {
    // Fail open with safe defaults — never block reservation on plan-lookup hiccups.
    console.error('[weldmail] plan lookup failed; using defaults:', err);
    return { enabled: DEFAULT_WELDMAIL_ENABLED, maxAddresses: DEFAULT_MAX_WELDMAIL_ADDRESSES };
  }
}

export async function getWeldMailDomain(env: Env, orgId: string): Promise<string> {
  const workspace = await getWorkspace(env, orgId);
  if (!workspace) throw new WeldMailError('WORKSPACE_NOT_FOUND', 'Workspace not found');
  return weldMailDomainFor(workspace.slug);
}

export async function checkAddressAvailability(
  env: Env,
  orgId: string,
  address: string,
) {
  if (RESERVED_ADDRESSES.has(address.toLowerCase())) {
    return { available: false, reason: 'reserved' as const };
  }
  const workspace = await getWorkspace(env, orgId);
  if (!workspace) throw new WeldMailError('WORKSPACE_NOT_FOUND', 'Workspace not found');
  const domain = weldMailDomainFor(workspace.slug);
  const email = `${address}@${domain}`;

  const masterDb = getMasterDb(env);
  const [existing] = await masterDb
    .select({ id: masterSchema.mailAccountRegistry.id })
    .from(masterSchema.mailAccountRegistry)
    .where(eq(masterSchema.mailAccountRegistry.email, email))
    .limit(1);
  if (existing) return { available: false, reason: 'taken' as const };

  return { available: true as const, email, domain };
}

export interface ReserveAddressInput {
  address: string;
  name?: string;
  displayName?: string;
}

export async function reserveAddress(
  env: Env,
  db: Database,
  orgId: string,
  data: ReserveAddressInput,
) {
  if (RESERVED_ADDRESSES.has(data.address.toLowerCase())) {
    throw new WeldMailError('RESERVED_ADDRESS', 'This address is reserved');
  }
  const workspace = await getWorkspace(env, orgId);
  if (!workspace) throw new WeldMailError('WORKSPACE_NOT_FOUND', 'Workspace not found');

  const domain = weldMailDomainFor(workspace.slug);
  const email = `${data.address}@${domain}`;

  const limits = await getLimits(env, orgId);
  if (!limits.enabled) {
    throw new WeldMailError(
      'PLAN_DISABLED',
      'WeldMail is not available on your current plan. Upgrade to enable shared email addresses.',
    );
  }

  const masterDb = getMasterDb(env);
  const [taken] = await masterDb
    .select({ id: masterSchema.mailAccountRegistry.id })
    .from(masterSchema.mailAccountRegistry)
    .where(eq(masterSchema.mailAccountRegistry.email, email))
    .limit(1);
  if (taken) throw new WeldMailError('ADDRESS_TAKEN', 'This address is already taken');

  // Workspace cap check — counts only live accounts on this shared domain.
  const existing = await db
    .select({ id: schema.mailAccounts.id })
    .from(schema.mailAccounts)
    .where(
      and(
        like(schema.mailAccounts.email, `%@${domain}`),
        isNull(schema.mailAccounts.deletedAt),
      ),
    );
  if (limits.maxAddresses !== null && existing.length >= limits.maxAddresses) {
    const plural = limits.maxAddresses === 1 ? '' : 'es';
    throw new WeldMailError(
      'PLAN_LIMIT_REACHED',
      `You have reached your plan limit of ${limits.maxAddresses} WeldMail address${plural}. Upgrade your plan to add more.`,
    );
  }

  const accountId = generateId('mail');
  const [account] = await db
    .insert(schema.mailAccounts)
    .values({
      id: accountId,
      name: data.name || data.address,
      email,
      displayName: data.displayName || data.name || data.address,
      provider: 'custom',
      authType: 'api_key',
      status: 'active',
      syncEnabled: false,
      isDefault: existing.length === 0,
    })
    .returning();

  await masterDb.insert(masterSchema.mailAccountRegistry).values({
    id: generateId('reg'),
    email,
    workspaceId: workspace.id,
    accountId,
    isActive: true,
  });

  return account!;
}

export async function listAddresses(env: Env, db: Database, orgId: string) {
  const workspace = await getWorkspace(env, orgId);
  if (!workspace) throw new WeldMailError('WORKSPACE_NOT_FOUND', 'Workspace not found');
  const domain = weldMailDomainFor(workspace.slug);
  const limits = await getLimits(env, orgId);

  const accounts = await db
    .select({
      id: schema.mailAccounts.id,
      email: schema.mailAccounts.email,
      name: schema.mailAccounts.name,
      displayName: schema.mailAccounts.displayName,
      status: schema.mailAccounts.status,
      isDefault: schema.mailAccounts.isDefault,
      createdAt: schema.mailAccounts.createdAt,
    })
    .from(schema.mailAccounts)
    .where(
      and(
        like(schema.mailAccounts.email, `%@${domain}`),
        isNull(schema.mailAccounts.deletedAt),
      ),
    );

  return {
    addresses: accounts,
    total: accounts.length,
    limit: limits.maxAddresses,
    enabled: limits.enabled,
    domain,
  };
}

export async function releaseAddress(
  env: Env,
  db: Database,
  orgId: string,
  accountId: string,
) {
  const workspace = await getWorkspace(env, orgId);
  if (!workspace) throw new WeldMailError('WORKSPACE_NOT_FOUND', 'Workspace not found');
  const domain = weldMailDomainFor(workspace.slug);

  const [account] = await db
    .select()
    .from(schema.mailAccounts)
    .where(
      and(
        eq(schema.mailAccounts.id, accountId),
        like(schema.mailAccounts.email, `%@${domain}`),
        isNull(schema.mailAccounts.deletedAt),
      ),
    )
    .limit(1);
  if (!account) throw new WeldMailError('ADDRESS_NOT_FOUND', 'WeldMail address not found');

  await db
    .update(schema.mailAccounts)
    .set({ deletedAt: new Date(), status: 'inactive', updatedAt: new Date() })
    .where(eq(schema.mailAccounts.id, accountId));

  // Keep the registry row for audit/history — just flip the active flag.
  await getMasterDb(env)
    .update(masterSchema.mailAccountRegistry)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(masterSchema.mailAccountRegistry.email, account.email));

  return { id: accountId, email: account.email };
}
