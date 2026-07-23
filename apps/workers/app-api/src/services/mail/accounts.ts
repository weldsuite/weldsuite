/**
 * Mail account service — pure functions over Drizzle.
 *
 * Encapsulates the creation flow that wires a new account up to Cloudflare
 * Email Routing on the customer's zone, seeds system labels, and registers
 * the address in the master `mailAccountRegistry` so inbound webhooks can
 * resolve `email → workspace`. The route layer only deals with HTTP wiring;
 * everything below this file is provider/transport-agnostic.
 */

import { and, desc, eq, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import { schema, masterSchema, getMasterDb } from '../../db';
import type { Database, MasterDatabase } from '../../db';
import type { Env } from '../../types';
import { generateId } from '../../lib/id';
import * as cfEmail from '../../lib/cloudflare-email';
import { hasAccessToAccount, isAdminOrOwner, userAccessCondition } from './access';

const { mailAccounts, mailDomains, mailLabels, hostDomains, workspaceMembers } = schema;

const BARE_WELDMAIL_DOMAINS = ['weldmail.com', 'test.weldmail.com', 'preview.weldmail.com'];

const SYSTEM_LABEL_SEEDS = [
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
] as const;

// ---------------------------------------------------------------------------
// Errors — typed sentinels the route layer maps to HTTP status codes.
// ---------------------------------------------------------------------------

export class MailAccountError extends Error {
  constructor(
    public readonly code:
      | 'BARE_WELDMAIL_DOMAIN_BLOCKED'
      | 'WRONG_WELDMAIL_SUBDOMAIN'
      | 'DUPLICATE_EMAIL'
      | 'DOMAIN_NOT_IN_WELDHOST'
      | 'CLOUDFLARE_PROVISION_FAILED'
      | 'NOT_FOUND'
      | 'FORBIDDEN'
      | 'INVALID_USER_IDS',
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'MailAccountError';
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface MailAccountFilters {
  limit?: number;
  cursor?: string;
  search?: string;
  status?: string;
  provider?: string;
}

export async function listMailAccounts(
  db: Database,
  userId: string,
  filters: MailAccountFilters,
) {
  const limit = Math.min(filters.limit ?? 25, 100);

  const admin = await isAdminOrOwner(db, userId);
  const conditions: SQL[] = [isNull(mailAccounts.deletedAt)!];
  if (!admin) conditions.push(userAccessCondition(userId));

  if (filters.search) {
    const term = `%${filters.search}%`;
    conditions.push(or(like(mailAccounts.name, term), like(mailAccounts.email, term))!);
  }
  if (filters.status) {
    conditions.push(eq(mailAccounts.status, filters.status as never));
  }
  if (filters.provider) {
    conditions.push(eq(mailAccounts.provider, filters.provider as never));
  }

  if (filters.cursor) {
    const [cur] = await db
      .select({ createdAt: mailAccounts.createdAt, id: mailAccounts.id })
      .from(mailAccounts)
      .where(eq(mailAccounts.id, filters.cursor))
      .limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${mailAccounts.createdAt} < ${cur.createdAt} OR (${mailAccounts.createdAt} = ${cur.createdAt} AND ${mailAccounts.id} < ${cur.id}))`,
      );
    }
  }

  const where = and(...conditions);
  const filterConditions = filters.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = and(...filterConditions);

  const [rows, countRes] = await Promise.all([
    db
      .select()
      .from(mailAccounts)
      .where(where)
      .orderBy(desc(mailAccounts.createdAt), desc(mailAccounts.id))
      .limit(limit + 1),
    db.select({ count: sql<number>`count(*)::int` }).from(mailAccounts).where(countWhere),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
  const totalCount = Number(countRes[0]?.count ?? 0);

  return { data, hasMore, cursor, totalCount };
}

export async function getMailAccountStats(db: Database) {
  const result = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where status = 'active')::int`,
      inactive: sql<number>`count(*) filter (where status = 'inactive')::int`,
      error: sql<number>`count(*) filter (where status = 'error')::int`,
    })
    .from(mailAccounts)
    .where(isNull(mailAccounts.deletedAt));
  return result[0] ?? { total: 0, active: 0, inactive: 0, error: 0 };
}

export async function getMailAccount(db: Database, id: string, userId: string) {
  const [row] = await db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, id), isNull(mailAccounts.deletedAt)))
    .limit(1);
  if (!row) return null;

  const admin = await isAdminOrOwner(db, userId);
  if (!hasAccessToAccount(row, userId, admin)) return null;
  return row;
}

export async function getMailAccountLabels(db: Database, accountId: string) {
  const [account] = await db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, accountId), isNull(mailAccounts.deletedAt)))
    .limit(1);
  if (!account) return null;

  const labels = await db.select().from(mailLabels).where(eq(mailLabels.accountId, accountId));
  return labels;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateMailAccountInput {
  name: string;
  email: string;
  displayName?: string;
  provider: 'gmail' | 'outlook' | 'office365' | 'exchange' | 'imap' | 'yahoo' | 'mailcow' | 'resend' | 'smtp' | 'cloudflare' | 'custom';
  authType: 'oauth2' | 'password' | 'api_key';
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  syncEnabled?: boolean;
  syncFrequency?: number;
  signature?: string;
  dailySendLimit?: number;
  isDefault?: boolean;
  isShared?: boolean;
  assignedUserIds?: string[];
  aiSettings?: {
    customInstructions?: string;
    defaultTone?: 'professional' | 'friendly' | 'casual';
    defaultLength?: 'short' | 'medium' | 'long';
    modelPreference?: string;
  };
}

/**
 * Create a mail account. Provisions Cloudflare Email Routing on the
 * customer's zone if the domain is a WeldHost-owned domain that hasn't yet
 * been wired up, seeds the system labels, and registers the address in
 * `mailAccountRegistry` so inbound webhooks can resolve workspace from
 * envelope recipient.
 *
 * Throws `MailAccountError` for any pre-condition the route layer should
 * map to a 4xx (duplicate email, unmanaged domain, …).
 */
export async function createMailAccount(
  env: Env,
  db: Database,
  orgId: string,
  userId: string,
  data: CreateMailAccountInput,
): Promise<{ id: string; name: string; email: string }> {
  // ---- WeldMail domain guard ---------------------------------------------
  const emailDomain = data.email.split('@')[1]?.toLowerCase();
  if (!emailDomain) {
    throw new MailAccountError('DOMAIN_NOT_IN_WELDHOST', 'Invalid email address');
  }
  if (BARE_WELDMAIL_DOMAINS.includes(emailDomain)) {
    throw new MailAccountError(
      'BARE_WELDMAIL_DOMAIN_BLOCKED',
      'Cannot create accounts directly on WeldMail domains. Use the WeldMail address flow instead.',
    );
  }
  if (emailDomain.endsWith('.weldmail.com')) {
    const masterDb = getMasterDb(env);
    const [ws] = await masterDb
      .select({ slug: masterSchema.workspaces.slug })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.clerkOrgId, orgId))
      .limit(1);
    const allowedDomain = ws ? `${ws.slug}.weldmail.com` : null;
    if (!allowedDomain || emailDomain !== allowedDomain) {
      throw new MailAccountError(
        'WRONG_WELDMAIL_SUBDOMAIN',
        'You can only create WeldMail accounts on your own workspace domain. Use the WeldMail address flow instead.',
      );
    }
  }

  // ---- Duplicate guard ---------------------------------------------------
  const [existing] = await db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(and(eq(mailAccounts.email, data.email), isNull(mailAccounts.deletedAt)))
    .limit(1);
  if (existing) {
    throw new MailAccountError(
      'DUPLICATE_EMAIL',
      `An account for ${data.email} already exists (${existing.id}). Delete it first or edit the existing account.`,
    );
  }

  const id = generateId('mail');
  const now = new Date();

  // Auto-add the creator when the account is private.
  let assignedUserIds = data.assignedUserIds;
  if (!data.isShared && userId) {
    const set = new Set(assignedUserIds ?? []);
    set.add(userId);
    assignedUserIds = Array.from(set);
  }

  // ---- Domain wiring -----------------------------------------------------
  // The domain must already exist in WeldHost — that's how we know we own
  // the Cloudflare zone. If it does, we (re-)assert Cloudflare Email
  // Routing on the zone (idempotent server-side) and create a mail_domains
  // row that future accounts on the same zone can short-circuit through.
  let managedDomain = await findManagedDomain(db, emailDomain);
  if (!managedDomain) {
    const [hostDomain] = await db
      .select()
      .from(hostDomains)
      .where(and(eq(hostDomains.fullDomain, emailDomain), isNull(hostDomains.deletedAt)))
      .limit(1);
    if (!hostDomain) {
      throw new MailAccountError(
        'DOMAIN_NOT_IN_WELDHOST',
        `Add ${emailDomain} in WeldHost › Domains before creating an email account on it.`,
      );
    }
    try {
      await cfEmail.createDomain(env, emailDomain);
    } catch (cfErr) {
      throw new MailAccountError(
        'CLOUDFLARE_PROVISION_FAILED',
        `Couldn't enable Cloudflare Email Routing on ${emailDomain}. Check that the domain's nameservers are on Cloudflare and the zone is active.`,
        cfErr instanceof Error ? cfErr.message : String(cfErr),
      );
    }
    const newDomainId = generateId('mdom');
    await db.insert(mailDomains).values({
      id: newDomainId,
      domainName: emailDomain,
      isActive: true,
      isPrimary: false,
      mailProvider: 'cloudflare',
      sendProvider: 'cloudflare',
      receiveProvider: 'cloudflare',
      dnsStatus: 'verified',
      cloudflareRoutingEnabled: true,
      maxEmailAccounts: 100,
      currentEmailAccounts: 0,
      createdAt: now,
      updatedAt: now,
    });
    managedDomain = await findManagedDomain(db, emailDomain);
  } else if (
    managedDomain.sendProvider === 'cloudflare' ||
    managedDomain.receiveProvider === 'cloudflare'
  ) {
    // Re-assert routing on each create. Server-side is idempotent and this
    // self-heals mail_domains rows inserted by older code paths that
    // never actually called the Cloudflare API.
    try {
      await cfEmail.createDomain(env, emailDomain);
      if (!managedDomain.cloudflareRoutingEnabled) {
        await db
          .update(mailDomains)
          .set({ cloudflareRoutingEnabled: true, updatedAt: new Date() })
          .where(eq(mailDomains.id, managedDomain.id));
      }
    } catch (cfErr) {
      throw new MailAccountError(
        'CLOUDFLARE_PROVISION_FAILED',
        `Couldn't enable Cloudflare Email Routing on ${emailDomain}.`,
        cfErr instanceof Error ? cfErr.message : String(cfErr),
      );
    }
  }

  // ---- Default-flag uniqueness ------------------------------------------
  if (data.isDefault) {
    await db
      .update(mailAccounts)
      .set({ isDefault: false })
      .where(isNull(mailAccounts.deletedAt));
  }

  // ---- Insert account ----------------------------------------------------
  await db.insert(mailAccounts).values({
    id,
    name: data.name,
    email: data.email,
    displayName: data.displayName,
    provider: data.provider,
    authType: data.authType,
    imapHost: data.imapHost,
    imapPort: data.imapPort,
    imapSecure: data.imapSecure ?? true,
    smtpHost: data.smtpHost,
    smtpPort: data.smtpPort,
    smtpSecure: data.smtpSecure ?? true,
    syncEnabled: data.syncEnabled ?? true,
    syncFrequency: data.syncFrequency ?? 5,
    signature: data.signature,
    dailySendLimit: data.dailySendLimit ?? 500,
    isDefault: data.isDefault ?? false,
    isShared: data.isShared ?? true,
    assignedUserIds,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });

  // ---- System label seed ------------------------------------------------
  await db.insert(mailLabels).values(
    SYSTEM_LABEL_SEEDS.map((label) => ({
      id: generateId('label'),
      accountId: id,
      name: label.name,
      slug: label.slug,
      isSystem: true,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    })),
  );

  // ---- Master DB registry (best-effort) ---------------------------------
  // Upserts so a re-create on a previously-deleted email re-points the
  // existing row instead of colliding on the email unique index.
  try {
    await registerInMasterRegistry(getMasterDb(env), orgId, id, data.email);
  } catch (err: unknown) {
    console.error(
      `[mail-accounts] master registry upsert failed for ${data.email}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return { id, name: data.name, email: data.email };
}

async function findManagedDomain(db: Database, emailDomain: string) {
  const [row] = await db
    .select()
    .from(mailDomains)
    .where(and(eq(mailDomains.domainName, emailDomain), isNull(mailDomains.deletedAt)))
    .limit(1);
  return row ?? null;
}

async function registerInMasterRegistry(
  masterDb: MasterDatabase,
  orgId: string,
  accountId: string,
  email: string,
) {
  const [workspace] = await masterDb
    .select({ id: masterSchema.workspaces.id })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.clerkOrgId, orgId))
    .limit(1);
  if (!workspace) {
    console.warn(`[mail-accounts] no workspace for orgId ${orgId}; skipping registry`);
    return;
  }
  await masterDb
    .insert(masterSchema.mailAccountRegistry)
    .values({
      id: generateId('reg'),
      email,
      workspaceId: workspace.id,
      accountId,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: masterSchema.mailAccountRegistry.email,
      set: {
        workspaceId: workspace.id,
        accountId,
        isActive: true,
        updatedAt: new Date(),
      },
    });
}

// ---------------------------------------------------------------------------
// Update / Delete / Assign
// ---------------------------------------------------------------------------

export type UpdateMailAccountInput = Partial<CreateMailAccountInput>;

/** Returns the row before + after update so callers can publish change diffs. */
export async function updateMailAccount(
  db: Database,
  id: string,
  data: UpdateMailAccountInput,
): Promise<{ before: typeof mailAccounts.$inferSelect; after: typeof mailAccounts.$inferSelect } | null> {
  const [before] = await db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, id), isNull(mailAccounts.deletedAt)))
    .limit(1);
  if (!before) return null;

  if (data.isDefault) {
    await db
      .update(mailAccounts)
      .set({ isDefault: false })
      .where(isNull(mailAccounts.deletedAt));
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) if (v !== undefined) patch[k] = v;

  await db
    .update(mailAccounts)
    .set(patch as typeof mailAccounts.$inferInsert)
    .where(and(eq(mailAccounts.id, id), isNull(mailAccounts.deletedAt)));

  const [after] = await db
    .select()
    .from(mailAccounts)
    .where(eq(mailAccounts.id, id))
    .limit(1);
  return { before, after: after! };
}

export async function deleteMailAccount(env: Env, db: Database, id: string, userId: string) {
  const [account] = await db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, id), isNull(mailAccounts.deletedAt)))
    .limit(1);
  if (!account) return { found: false as const };

  const admin = await isAdminOrOwner(db, userId);
  if (!hasAccessToAccount(account, userId, admin)) return { found: false as const };

  // Cloudflare Email Routing has no per-mailbox principal to delete — the
  // catch-all rule is zone-scoped, not account-scoped. So delete is a pure
  // local soft-delete; the master registry row is left in place so a
  // later re-create on the same email re-points it via the existing
  // upsert (see registerInMasterRegistry).
  await db
    .update(mailAccounts)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(mailAccounts.id, id));

  return { found: true as const, account };
}

export async function assignMailAccountUsers(
  db: Database,
  id: string,
  callerUserId: string,
  isShared: boolean,
  assignedUserIds: string[],
) {
  const admin = await isAdminOrOwner(db, callerUserId);
  if (!admin) throw new MailAccountError('FORBIDDEN', 'Only admins and owners can manage account access');

  const [account] = await db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, id), isNull(mailAccounts.deletedAt)))
    .limit(1);
  if (!account) throw new MailAccountError('NOT_FOUND', 'Mail account not found');

  if (assignedUserIds.length > 0) {
    const members = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(isNull(workspaceMembers.deletedAt));
    const memberIds = new Set(members.map((m) => m.userId));
    const invalid = assignedUserIds.filter((u) => !memberIds.has(u));
    if (invalid.length) {
      throw new MailAccountError('INVALID_USER_IDS', `Invalid user IDs: ${invalid.join(', ')}`);
    }
  }

  await db
    .update(mailAccounts)
    .set({
      isShared,
      assignedUserIds: isShared ? null : assignedUserIds,
      updatedAt: new Date(),
    })
    .where(eq(mailAccounts.id, id));

  // Return the updated row so the route can publish a complete entity event
  // without the caller having to refetch.
  const [after] = await db
    .select()
    .from(mailAccounts)
    .where(eq(mailAccounts.id, id))
    .limit(1);
  return after!;
}

export async function triggerAccountSync(db: Database, id: string, userId: string) {
  const [account] = await db
    .select({
      id: mailAccounts.id,
      isShared: mailAccounts.isShared,
      assignedUserIds: mailAccounts.assignedUserIds,
    })
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, id), isNull(mailAccounts.deletedAt)))
    .limit(1);
  if (!account) return null;

  const admin = await isAdminOrOwner(db, userId);
  if (!hasAccessToAccount(account, userId, admin)) return null;

  await db
    .update(mailAccounts)
    .set({ syncStatus: 'syncing', updatedAt: new Date() })
    .where(eq(mailAccounts.id, id));

  // TODO: enqueue a real sync job once the sync worker is wired into app-api.
  // For Cloudflare-managed domains inbound is push-driven by Email Routing,
  // so "sync" only matters for IMAP-pull providers (Gmail OAuth, Mailcow).
  return { id, syncStatus: 'syncing' as const };
}
