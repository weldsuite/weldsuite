/**
 * The per-workspace KV mailbox directory (design §6, task C3): account display
 * data and label definitions, cached in `WORKSPACE_CACHE` so an `object`/
 * `object-only` mailbox open never has to query the tenant DB for them. Keys
 * and the version bump live in `@weldsuite/db/lib/mailbox-directory-cache`
 * (shared with workers that cannot depend on this package, e.g.
 * workspace-worker's Clerk webhook); this file builds and reads the entry
 * itself.
 *
 * Never includes `accessToken`, `refreshToken`, `apiKey`, `passwordHash` or
 * `providerConfig` — the same five columns `@weldsuite/db/lib/sensitive-columns`
 * already lists under `mail_accounts`, reused here (`omitSensitive`) rather
 * than a second hand-written exclusion list.
 *
 * `loadAllDirectoryAccounts`/`loadDirectoryAccountsByIds`/
 * `loadDirectoryLabelsForAccounts` are also used, uncached, by
 * `store/access.ts`'s `PostgresMailAccess` — `account()`/`accounts()`/
 * `labels()` are new surface on `MailAccess` (design §2), not something
 * today's `../access.ts` already answers, so both backends return the exact
 * same `DirectoryAccount`/`DirectoryLabel` shape, built from the same query.
 */

import { and, eq, getTableColumns, inArray, isNull } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import { omitSensitive } from '@weldsuite/db/lib/sensitive-columns';
import type { MailAccount } from '@weldsuite/db/schema/mail-accounts';
import type { MailLabel } from '@weldsuite/db/schema/mail-labels';
import {
  MAILBOX_DIRECTORY_CACHE_TTL_SECONDS,
  bumpMailboxDirectoryVersion,
  mailboxDirectoryCacheKey,
  readMailboxDirectoryVersion,
} from '@weldsuite/db/lib/mailbox-directory-cache';

const { mailAccounts, mailLabels } = schema;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

type CredentialColumn = 'accessToken' | 'refreshToken' | 'apiKey' | 'passwordHash' | 'providerConfig';
type AccountDateColumn = 'lastSyncAt' | 'mailcowSyncedAt' | 'createdAt' | 'updatedAt' | 'deletedAt';

/**
 * Every `mail_accounts` column except the five credential columns (design
 * §6). Date columns are ISO strings, not `Date` instances: a directory entry
 * round-trips through KV as JSON, so a `Date` field would silently become a
 * string on a cache hit but stay a `Date` object on a cache miss — this type
 * is honest about the one shape callers actually see, built either way by
 * `toDirectoryAccount` below.
 */
export type DirectoryAccount = Omit<MailAccount, CredentialColumn | AccountDateColumn> &
  Record<AccountDateColumn, string | null> & { createdAt: string; updatedAt: string };

export type DirectoryLabel = Pick<MailLabel, 'id' | 'name' | 'slug' | 'isSystem' | 'color' | 'position' | 'aiEnabled'>;

export interface MailDirectoryEntry {
  v: 1;
  builtAt: number;
  accounts: DirectoryAccount[];
  /** Keyed by `accountId`. An account with no labels has no entry (not an empty array) — callers default with `?? []`. */
  labels: Record<string, DirectoryLabel[]>;
}

export interface MailDirectoryEnv {
  WORKSPACE_CACHE: KVNamespace;
}

// ---------------------------------------------------------------------------
// Queries (shared by the directory builder and `PostgresMailAccess`)
// ---------------------------------------------------------------------------

const SAFE_ACCOUNT_COLUMNS = omitSensitive('mail_accounts', getTableColumns(mailAccounts));
const LABEL_COLUMNS = {
  id: mailLabels.id,
  accountId: mailLabels.accountId,
  name: mailLabels.name,
  slug: mailLabels.slug,
  isSystem: mailLabels.isSystem,
  color: mailLabels.color,
  position: mailLabels.position,
  aiEnabled: mailLabels.aiEnabled,
} as const;

type SafeAccountRow = Omit<MailAccount, CredentialColumn>;

function isoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function toDirectoryAccount(row: SafeAccountRow): DirectoryAccount {
  const { lastSyncAt, mailcowSyncedAt, createdAt, updatedAt, deletedAt, ...rest } = row;
  return {
    ...rest,
    lastSyncAt: isoOrNull(lastSyncAt),
    mailcowSyncedAt: isoOrNull(mailcowSyncedAt),
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    deletedAt: isoOrNull(deletedAt),
  };
}

function groupLabelsByAccount(rows: Array<DirectoryLabel & { accountId: string }>): Record<string, DirectoryLabel[]> {
  const byAccount: Record<string, DirectoryLabel[]> = {};
  for (const { accountId, ...label } of rows) {
    (byAccount[accountId] ??= []).push(label);
  }
  return byAccount;
}

/** Every live (non-deleted) mail account, credential columns stripped. */
export async function loadAllDirectoryAccounts(db: Database): Promise<DirectoryAccount[]> {
  const rows = await db.select(SAFE_ACCOUNT_COLUMNS).from(mailAccounts).where(isNull(mailAccounts.deletedAt));
  return rows.map(toDirectoryAccount);
}

/** Live mail accounts by id, credential columns stripped. Empty `ids` returns `[]` without a query. */
export async function loadDirectoryAccountsByIds(db: Database, ids: string[]): Promise<DirectoryAccount[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(SAFE_ACCOUNT_COLUMNS)
    .from(mailAccounts)
    .where(and(inArray(mailAccounts.id, ids), isNull(mailAccounts.deletedAt)));
  return rows.map(toDirectoryAccount);
}

/** Every live label, across every account, keyed by `accountId`. */
export async function loadAllDirectoryLabels(db: Database): Promise<Record<string, DirectoryLabel[]>> {
  const rows = await db.select(LABEL_COLUMNS).from(mailLabels).where(isNull(mailLabels.deletedAt));
  return groupLabelsByAccount(rows);
}

/** Live labels for a set of accounts, keyed by `accountId`. Empty `accountIds` returns `{}` without a query. */
export async function loadDirectoryLabelsForAccounts(
  db: Database,
  accountIds: string[],
): Promise<Record<string, DirectoryLabel[]>> {
  if (accountIds.length === 0) return {};
  const rows = await db
    .select(LABEL_COLUMNS)
    .from(mailLabels)
    .where(and(inArray(mailLabels.accountId, accountIds), isNull(mailLabels.deletedAt)));
  return groupLabelsByAccount(rows);
}

/** One batched read (design §6: "one batched Postgres read") of every account and label the directory holds. */
export async function buildMailDirectory(db: Database, now: () => number = Date.now): Promise<MailDirectoryEntry> {
  const [accounts, labels] = await Promise.all([loadAllDirectoryAccounts(db), loadAllDirectoryLabels(db)]);
  return { v: 1, builtAt: now(), accounts, labels };
}

// ---------------------------------------------------------------------------
// KV cache (versioned, 7-day TTL — see the module doc comment)
// ---------------------------------------------------------------------------

function isDirectoryEntry(value: unknown): value is MailDirectoryEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<MailDirectoryEntry>;
  return v.v === 1 && typeof v.builtAt === 'number' && Array.isArray(v.accounts) && typeof v.labels === 'object' && v.labels !== null;
}

/**
 * A workspace's mailbox directory: a cache hit under the current version, or
 * a freshly built entry (written back to KV) on a miss. Never throws — a KV
 * failure on either the read or the write falls through to (or simply
 * returns) the freshly built entry, same fail-open posture as
 * `resolveEffectivePermissionsCached`.
 */
export async function getMailDirectory(
  env: MailDirectoryEnv,
  workspaceId: string,
  db: Database,
  now: () => number = Date.now,
): Promise<MailDirectoryEntry> {
  const version = await readMailboxDirectoryVersion(env.WORKSPACE_CACHE, workspaceId);
  const key = mailboxDirectoryCacheKey(workspaceId, version);

  let cached: unknown = null;
  try {
    cached = await env.WORKSPACE_CACHE.get(key, 'json');
  } catch (err) {
    console.warn('[mail-store/directory] KV read failed, rebuilding from Postgres:', err instanceof Error ? err.message : err);
  }
  if (isDirectoryEntry(cached)) return cached;

  const built = await buildMailDirectory(db, now);
  try {
    await env.WORKSPACE_CACHE.put(key, JSON.stringify(built), { expirationTtl: MAILBOX_DIRECTORY_CACHE_TTL_SECONDS });
  } catch (err) {
    console.warn('[mail-store/directory] KV write failed, serving the freshly built directory uncached:', err instanceof Error ? err.message : err);
  }
  return built;
}

/**
 * Bump a workspace's mailbox directory so the next `getMailDirectory` rebuilds
 * it. Call after any write that changes what the directory holds (design §6):
 * account create/update/delete/assign, address creation, sync status changes,
 * label create/update/delete, workspace provisioning/backfill, test fixtures.
 */
export async function bumpMailboxDirectory(env: MailDirectoryEnv, workspaceId: string): Promise<void> {
  await bumpMailboxDirectoryVersion(env.WORKSPACE_CACHE, workspaceId);
}
