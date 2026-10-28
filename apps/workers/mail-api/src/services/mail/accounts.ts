/**
 * Mail account service — pure functions over Drizzle.
 *
 * Encapsulates the creation flow that wires a new account up to Cloudflare
 * Email Routing on the customer's zone, seeds system labels, and registers
 * the address in the master `mailAccountRegistry` so inbound webhooks can
 * resolve `email → workspace`. The route layer only deals with HTTP wiring;
 * everything below this file is provider/transport-agnostic.
 */

import { and, desc, eq, getTableColumns, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import { schema, masterSchema, getMasterDb } from '@weldsuite/worker-kit/db';
import type { Database, MasterDatabase } from '@weldsuite/worker-kit/db';
import type { Env } from '../../types';
import { generateId } from '@weldsuite/worker-kit/id';
import * as cfEmail from '@weldsuite/worker-email';
import {
  canManageAccount,
  hasAccessToAccount,
  isAdminOrOwner,
  userAccessCondition,
  type MailPrincipal,
} from '@weldsuite/mail-domain/access';
import { ObjectMailAccess, type MailAccess } from '@weldsuite/mail-domain/store/access';
import {
  getMailDirectory,
  type DirectoryAccount,
  type DirectoryLabel,
  type MailDirectoryEnv,
} from '@weldsuite/mail-domain/store/directory';
import { mailboxStubFor } from '@weldsuite/mail-domain/store/object';
import { mailIndexFor } from '@weldsuite/mail-domain/mail-index/client';
import type { MailboxRef } from '@weldsuite/mail-domain/store/types';
import { clearCatchAllForAccount } from './domains';
import { weldMailDomainFor } from './weldmail';
import {
  SHARED_WELDMAIL_APEXES,
  isSharedWeldMailDomain,
} from '@weldsuite/app-api-client/schemas/outbound-mail';
import { matchWorkspaceRef } from '@weldsuite/db/lib/workspace-ref';

const { mailAccounts, mailDomains, mailLabels, hostDomains, workspaceMembers } = schema;

/**
 * `mail_accounts` columns safe to send to the browser: every column except
 * the encrypted credentials (`accessToken`, `refreshToken`, `apiKey`,
 * `passwordHash`) and `providerConfig`, which can carry an OAuth client id or
 * other provider secrets. List and detail reads must select this, never `*`.
 */
const {
  accessToken: _accessToken,
  refreshToken: _refreshToken,
  apiKey: _apiKey,
  passwordHash: _passwordHash,
  providerConfig: _providerConfig,
  ...publicAccountColumns
} = getTableColumns(mailAccounts);

const BARE_WELDMAIL_DOMAINS = new Set([
  ...SHARED_WELDMAIL_APEXES,
  'test.weldmail.com',
  'preview.weldmail.com',
]);

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
  { name: 'Promotions', slug: 'PROMOTIONS' },
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
      | 'DOMAIN_HAS_EXISTING_MX'
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

/**
 * Turn a Cloudflare provisioning failure into a typed `MailAccountError`.
 *
 * WeldMail supports exactly ONE inbound provider per domain, which is also
 * what Cloudflare enforces: it refuses to enable Email Routing on a zone that
 * still has third-party MX records (HTTP 409, Cloudflare code 2008), because
 * enabling would overwrite and lock them and silently break whatever mail flow
 * they serve. That is a deterministic, user-fixable conflict — a DNS edit, not
 * a retry — so it gets its own code and a 409, separate from the catch-all
 * provisioning failure.
 *
 * The generic message used to blame nameservers; that was wrong often enough to
 * be actively misleading, so the Cloudflare detail is now surfaced verbatim.
 */
function cloudflareProvisionError(domain: string, cfErr: unknown): MailAccountError {
  const detail = cfErr instanceof Error ? cfErr.message : String(cfErr);

  if (/Non-Cloudflare MX records exist|\b2008\b/i.test(detail)) {
    return new MailAccountError(
      'DOMAIN_HAS_EXISTING_MX',
      `${domain} already has an inbound mail (MX) record pointing at another provider. WeldMail supports one inbound provider per domain — remove the existing MX record in your DNS settings and try again.`,
      { domain, cloudflareError: detail },
    );
  }

  return new MailAccountError(
    'CLOUDFLARE_PROVISION_FAILED',
    `Couldn't enable Cloudflare Email Routing on ${domain}: ${detail}`,
    detail,
  );
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
  /**
   * `manage` is the settings view: admins/owners get every account, including
   * private mailboxes they cannot open. Without it the list is the mailboxes
   * the caller can open, whatever their role.
   */
  scope?: 'manage';
}

export async function listMailAccounts(
  db: Database,
  userId: string,
  filters: MailAccountFilters,
) {
  const limit = Math.min(filters.limit ?? 25, 100);

  const admin = await isAdminOrOwner(db, userId);
  const conditions: SQL[] = [isNull(mailAccounts.deletedAt)!];
  if (!(admin && filters.scope === 'manage')) conditions.push(userAccessCondition(userId, admin));

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
      .select(publicAccountColumns)
      .from(mailAccounts)
      .where(where)
      .orderBy(desc(mailAccounts.createdAt), desc(mailAccounts.id))
      .limit(limit + 1),
    db.select({ count: sql<number>`count(*)::int` }).from(mailAccounts).where(countWhere),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? data.at(-1)!.id : null;
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
    .select(publicAccountColumns)
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
// Directory-served reads (object modes — design §6, §9 task D3)
//
// `postgres`/`shadow` keep querying `mail_accounts` directly, exactly as
// above (the design: "postgres/shadow: wrap ../access.ts unchanged — no
// directory, no KV"). `object`/`object-only` serve list/detail/labels from
// the KV mailbox directory instead, with the same access filtering and
// response shape and no tenant query on the open path. The route picks
// which of the two paths to use via `readsFromObject(mode)`
// (`@weldsuite/mail-domain/store/mode`).
// ---------------------------------------------------------------------------

/**
 * Builds this request's `MailAccess` from the KV directory. `isAdmin` must be
 * the caller's own already-resolved permission check (the route's
 * `requirePermission` already paid for it, via `getPermissionsFromContext`) —
 * never a fresh tenant-DB lookup, which is exactly the Postgres round trip
 * object modes exist to avoid on this path.
 */
export async function buildDirectoryMailAccess(
  env: MailDirectoryEnv,
  db: Database,
  workspaceId: string,
  userId: string,
  isAdmin: boolean,
): Promise<MailAccess> {
  const directory = await getMailDirectory(env, workspaceId, db);
  const principal: MailPrincipal = { kind: 'user', userId };
  return new ObjectMailAccess(directory, principal, () => Promise.resolve(isAdmin));
}

function directoryAccountSortDesc(a: DirectoryAccount, b: DirectoryAccount): number {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  return a.id > b.id ? -1 : 1;
}

export interface DirectoryListResult {
  data: DirectoryAccount[];
  hasMore: boolean;
  cursor: string | null;
  totalCount: number;
}

/**
 * In-memory mirror of `listMailAccounts`'s Postgres query (design §6:
 * "filter in memory; the directory is small"), over an already
 * access-filtered `DirectoryAccount[]`. Search/status/provider/cursor/limit
 * semantics match the SQL above field for field — including the quirk that
 * the cursor's pivot `createdAt`/`id` is resolved from `accessible` itself
 * (the Postgres version resolves it from the whole table, independent of any
 * filter), so a cursor pointing at an account the caller can no longer see
 * (or that was deleted) is simply ignored rather than erroring.
 */
export function filterDirectoryAccounts(
  accessible: DirectoryAccount[],
  filters: Pick<MailAccountFilters, 'limit' | 'cursor' | 'search' | 'status' | 'provider'>,
): DirectoryListResult {
  const limit = Math.min(filters.limit ?? 25, 100);

  let filtered = accessible;
  if (filters.search) {
    const term = filters.search;
    filtered = filtered.filter((a) => a.name.includes(term) || a.email.includes(term));
  }
  if (filters.status) filtered = filtered.filter((a) => a.status === filters.status);
  if (filters.provider) filtered = filtered.filter((a) => a.provider === filters.provider);

  const sorted = [...filtered].sort(directoryAccountSortDesc);
  const totalCount = sorted.length;

  let paged = sorted;
  if (filters.cursor) {
    const pivot = accessible.find((a) => a.id === filters.cursor);
    if (pivot) {
      paged = sorted.filter(
        (a) => a.createdAt < pivot.createdAt || (a.createdAt === pivot.createdAt && a.id < pivot.id),
      );
    }
  }

  const hasMore = paged.length > limit;
  const data = hasMore ? paged.slice(0, limit) : paged;
  const cursor = hasMore && data.length > 0 ? data.at(-1)!.id : null;

  return { data, hasMore, cursor, totalCount };
}

/** Directory-served equivalent of `listMailAccounts`. `filters.scope` mirrors `MailAccess.accounts(scope)` exactly (see that method's own doc comment). */
export async function listMailAccountsFromDirectory(
  access: MailAccess,
  filters: MailAccountFilters,
): Promise<DirectoryListResult> {
  const rows = await access.accounts(filters.scope === 'manage' ? 'manage' : 'open');
  return filterDirectoryAccounts(rows, filters);
}

/** Directory-served equivalent of `getMailAccount`. `null` covers both "no such account" and "not yours", same as the Postgres version. */
export async function getMailAccountFromDirectory(access: MailAccess, id: string): Promise<DirectoryAccount | null> {
  if (!(await access.canOpen(id))) return null;
  return access.account(id);
}

/** Directory-served equivalent of `getMailAccountLabels`. The route gates this on `access.canOpen(id)` first, same as it gates the Postgres version on `checkAccountAccess`. */
export async function getMailAccountLabelsFromDirectory(
  access: MailAccess,
  accountId: string,
): Promise<DirectoryLabel[] | null> {
  if (!(await access.canOpen(accountId))) return null;
  return access.labels(accountId);
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

/** Reject bare WeldMail domains and WeldMail subdomains that aren't the caller's workspace. */
async function assertWeldmailDomainAllowed(env: Env, orgId: string, emailDomain: string): Promise<void> {
  if (BARE_WELDMAIL_DOMAINS.has(emailDomain)) {
    throw new MailAccountError(
      'BARE_WELDMAIL_DOMAIN_BLOCKED',
      'Cannot create accounts directly on WeldMail domains. Use the WeldMail address flow instead.',
    );
  }
  if (!isSharedWeldMailDomain(emailDomain)) return;

  const masterDb = getMasterDb(env);
  const [ws] = await masterDb
    .select({ slug: masterSchema.workspaces.slug })
    .from(masterSchema.workspaces)
    .where(matchWorkspaceRef(orgId))
    .limit(1);
  const allowedDomain = ws ? weldMailDomainFor(env, ws.slug) : null;
  if (!allowedDomain || emailDomain !== allowedDomain) {
    throw new MailAccountError(
      'WRONG_WELDMAIL_SUBDOMAIN',
      'You can only create WeldMail accounts on your own workspace domain. Use the WeldMail address flow instead.',
    );
  }
}

async function assertNoDuplicateAccount(db: Database, email: string): Promise<void> {
  const [existing] = await db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(and(eq(mailAccounts.email, email), isNull(mailAccounts.deletedAt)))
    .limit(1);
  if (existing) {
    throw new MailAccountError(
      'DUPLICATE_EMAIL',
      `An account for ${email} already exists (${existing.id}). Delete it first or edit the existing account.`,
    );
  }
}

/**
 * Auto-add the creator when the account is private, so they cannot lose the
 * mailbox they just made. An admin can manage it either way, so one setting up
 * a mailbox for someone else is not quietly added to it — only when nobody was
 * chosen at all.
 */
function withCreatorAssigned(
  data: CreateMailAccountInput,
  userId: string,
  creatorIsAdmin: boolean,
): string[] | undefined {
  if (data.isShared || !userId) return data.assignedUserIds;
  const chosen = data.assignedUserIds ?? [];
  if (creatorIsAdmin && chosen.length > 0) return chosen;
  return Array.from(new Set([...chosen, userId]));
}

/**
 * The domain must already exist in WeldHost — that's how we know we own
 * the Cloudflare zone. If it does, we (re-)assert Cloudflare Email
 * Routing on the zone (idempotent server-side) and create a mail_domains
 * row that future accounts on the same zone can short-circuit through.
 */
async function ensureManagedDomain(env: Env, db: Database, emailDomain: string, now: Date): Promise<void> {
  const managedDomain = await findManagedDomain(db, emailDomain);
  if (!managedDomain) {
    await provisionHostDomain(env, db, emailDomain, now);
    return;
  }
  if (managedDomain.sendProvider !== 'cloudflare' && managedDomain.receiveProvider !== 'cloudflare') {
    return;
  }
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
    throw cloudflareProvisionError(emailDomain, cfErr);
  }
}

/** First account on a WeldHost-owned domain: enable Cloudflare routing and record the mail domain. */
async function provisionHostDomain(env: Env, db: Database, emailDomain: string, now: Date): Promise<void> {
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
    throw cloudflareProvisionError(emailDomain, cfErr);
  }
  await db.insert(mailDomains).values({
    id: generateId('mdom'),
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
  await assertWeldmailDomainAllowed(env, orgId, emailDomain);

  // ---- Duplicate guard ---------------------------------------------------
  await assertNoDuplicateAccount(db, data.email);

  const id = generateId('mail');
  const now = new Date();

  const assignedUserIds = withCreatorAssigned(
    data,
    userId,
    data.isShared ? false : await isAdminOrOwner(db, userId),
  );

  // ---- Domain wiring -----------------------------------------------------
  await ensureManagedDomain(env, db, emailDomain, now);

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
    .where(matchWorkspaceRef(orgId))
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
      tenantKind: 'workspace',
      workspaceId: workspace.id,
      accountId,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: masterSchema.mailAccountRegistry.email,
      set: {
        tenantKind: 'workspace',
        workspaceId: workspace.id,
        personalAccountId: null,
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
  if (!canManageAccount(account, userId, admin)) return { found: false as const };

  // Cloudflare Email Routing has no per-mailbox principal to delete — the
  // catch-all rule is zone-scoped, not account-scoped. So delete is a pure
  // local soft-delete; the master registry row is left in place so a
  // later re-create on the same email re-points it via the existing
  // upsert (see registerInMasterRegistry).
  await db
    .update(mailAccounts)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(mailAccounts.id, id));

  // If this mailbox was a domain catch-all target, disable catch-all and
  // deactivate the master `*@domain` sentinel so unmatched mail stops landing.
  await clearCatchAllForAccount(env, db, id);

  return { found: true as const, account };
}

/**
 * Best-effort mailbox teardown for a deleted (or WeldMail-released) account,
 * in any mode that may have written the mailbox object (shadow and above —
 * design §9 task D3). The account's Postgres soft-delete has already
 * committed by the time a caller reaches this; a failure here is never a
 * reason to fail that request.
 *
 * Two separate actions, both idempotent, both logged-not-thrown:
 * - `destroy(ref)` accepts immediately and only *schedules* the object's own
 *   teardown (R2 bodies, then its own `MailIndex.dropMailbox` call) on its
 *   next alarm tick (`mailbox-object/destroy.ts`) — it does not drop the
 *   index entry synchronously.
 * - Calling `MailIndex.dropMailbox` directly here as well removes this
 *   mailbox's correspondents/address-index data right away, rather than
 *   waiting for the object's alarm to drain R2 first and reach that stage.
 */
export async function destroyMailboxObject(env: Env, ref: MailboxRef): Promise<void> {
  try {
    await mailboxStubFor(env, ref).destroy(ref);
  } catch (err) {
    console.error(
      '[mail-accounts] mailbox object destroy failed (the object retries this on its own alarm):',
      ref.workspaceId,
      ref.accountId,
      err instanceof Error ? err.message : err,
    );
  }
  try {
    const index = mailIndexFor(env, ref.workspaceId);
    if (index) await index.dropMailbox(ref.workspaceId, ref.accountId);
  } catch (err) {
    console.error(
      '[mail-accounts] MailIndex.dropMailbox failed:',
      ref.workspaceId,
      ref.accountId,
      err instanceof Error ? err.message : err,
    );
  }
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
