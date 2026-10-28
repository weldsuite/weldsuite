/**
 * KV keys for the per-workspace mailbox directory cache (`WORKSPACE_CACHE`):
 * account display data (every `mail_accounts` column except credentials) and
 * label definitions, read on every mail open so an object-mode mailbox never
 * touches Postgres for them (design §6,
 * docs/plans/weldmail-mailbox-store-design.md). This module only holds the
 * key format, the version read and the writer-facing bump — building and
 * reading the directory entry itself lives in `@weldsuite/mail-domain`'s
 * `store/directory.ts` (a later task), which is the only thing that writes
 * `mbxdir:<ws>:<v>`. Mirrors `./permissions-cache` exactly, down to the
 * reasoning in this comment, so a worker that cannot depend on worker-kit
 * (workspace-worker's Clerk webhook) can still invalidate the cache after a
 * write.
 *
 * Versioned rather than deleted: a write bumps `mbxdirv:<workspaceId>` and
 * every entry already cached under the old version is simply never looked up
 * again — it is left to expire on its own TTL. A read never needs to delete
 * anything.
 *
 * Invalidation is this version bump, not the cached entry's TTL
 * (`MAILBOX_DIRECTORY_CACHE_TTL_SECONDS`, 7 days — long enough that a cold
 * open of a long-idle workspace still finds a warm directory instead of
 * waiting on Postgres, the same reasoning as the permission cache's 24h).
 * Real staleness after a change is bounded by KV's propagation across colos
 * instead (up to ~60s), because every write path listed below calls
 * `bumpMailboxDirectoryVersion`. The long TTL only bounds the damage of a
 * writer that forgets to — a bug this file's own doc comment asks every
 * caller to guard against, not the routine case.
 */

/** 7 days. */
export const MAILBOX_DIRECTORY_CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;

/** `WORKSPACE_CACHE` key of a workspace's mailbox-directory version counter. */
export function mailboxDirectoryVersionKey(workspaceId: string): string {
  return `mbxdirv:${workspaceId}`;
}

/** `WORKSPACE_CACHE` key of a workspace's built directory entry, under a given version. */
export function mailboxDirectoryCacheKey(workspaceId: string, version: string): string {
  return `mbxdir:${workspaceId}:${version}`;
}

/**
 * The minimal KV surface this module needs. This package does not install
 * `@cloudflare/workers-types` (it is not itself a Worker), so a real
 * `KVNamespace` binding is typed structurally here instead — it satisfies
 * this interface, extra overloads and all.
 */
interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/**
 * Read a workspace's current mailbox-directory version, defaulting to `'0'`
 * when no version has ever been written, or on a KV failure (never throws).
 * `store/directory.ts` reads this to build the entry's cache key before
 * reading or writing `mbxdir:<ws>:<v>`; a `'0'` version simply means nothing
 * has ever been cached for this workspace, so the caller falls through to
 * Postgres and populates the cache from there.
 */
export async function readMailboxDirectoryVersion(kv: KvLike, workspaceId: string): Promise<string> {
  try {
    return (await kv.get(mailboxDirectoryVersionKey(workspaceId))) ?? '0';
  } catch (err) {
    console.warn(
      'Could not read a workspace mailbox-directory version:',
      err instanceof Error ? err.message : 'unknown error',
    );
    return '0';
  }
}

/**
 * Bump a workspace's mailbox-directory version, so every directory entry
 * already cached for it is skipped on the next read (left to expire on its
 * own TTL). Call this — passing `workspaces.id`, never the Clerk org id —
 * right after any write that changes what the built directory holds (design
 * §6): mail-api's accounts.ts create/update/delete/assign, weldmail.ts
 * address creation, sync.ts status changes, labels.ts create/update/delete,
 * workspace-worker's `ensureWorkspaceMail` and backfill-mail, and app-api's
 * test fixtures. Not after a `sentToday` bump: that field is stale in the
 * directory by design.
 *
 * Never throws: a failed bump only leaves the stale entry to expire on its
 * own TTL (up to 7 days, see the module doc comment above) rather than
 * failing the write that triggered it. A write path that cannot reach this
 * function at all is the real risk; a KV outage during the bump itself is the
 * rarer, secondary one.
 */
export async function bumpMailboxDirectoryVersion(kv: KvLike, workspaceId: string): Promise<void> {
  try {
    const key = mailboxDirectoryVersionKey(workspaceId);
    const current = await kv.get(key);
    const next = (Number.parseInt(current ?? '0', 10) || 0) + 1;
    // No TTL: the version must outlive any individual cached entry.
    await kv.put(key, String(next));
  } catch (err) {
    console.warn(
      'Could not bump a workspace mailbox-directory version:',
      err instanceof Error ? err.message : 'unknown error',
    );
  }
}
