/**
 * Recording a GitHub App installation as a WeldMerge connection (MERGE-002).
 *
 * `recordGithubInstallation(tenantDb, masterDb, ...)` upserts the
 * `merge_connections` row and the master `merge_provider_index` row
 * (`kind = installation`), and answers what changed so the caller can publish
 * the `merge_connection` created/updated event. merge-api's public setup route
 * (`/public/merge/github/setup`) and connect-api's
 * `GET /api/weldconnect/github/callback` both call it, so the two install
 * paths cannot drift. Removal and suspend/unsuspend go through the same module
 * (`removeGithubInstallationIndex`, `releaseGithubInstallationIndex`,
 * `setGithubInstallationStatus`).
 *
 * A member never takes an installation from another workspace: the index row
 * is claimed (written, or refreshed when it already names the workspace)
 * before anything else, and a row naming another workspace refuses the
 * recording with `GithubInstallationTakenError` (`installation_taken`).
 *
 * Pure of Hono and of any worker env: the caller hands in the two databases
 * and the encryption keyring.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { mergeConnections, type MergeConnectionStatus } from '@weldsuite/db/schema';
import { mergeProviderIndex } from '@weldsuite/db/schema/master';
import { encryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';

/** Either driver (neon-http in workers, pglite in tests). */
export type InstallationDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type MergeConnectionRecord = typeof mergeConnections.$inferSelect;

export interface RecordGithubInstallationInput {
  /** The GitHub App installation id. */
  installationId: number | string;
  appSlug: string;
  accountLogin: string;
  /** `Organization` / `User` (GitHub's wording) or `organization` / `user`. */
  accountType: string;
  /** `workspaces.id` (ws_…), ADR SEC-011: what the master index stores. */
  workspaceId: string;
  /** The member who installed the App. */
  userId: string;
  keyring: EncryptionKeyring;
  scopes?: string[] | null;
  /** Default `active`. */
  status?: Extract<MergeConnectionStatus, 'active' | 'suspended'>;
  now?: Date;
}

export interface RecordedGithubInstallation {
  connection: MergeConnectionRecord;
  /** What the caller publishes: `merge_connection` `created` or `updated`. */
  action: 'created' | 'updated';
}

const randomHex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

/** `prefix_` + a time-ordered base-36 stamp and random tail, as `generateId` in worker-kit. */
function newId(prefix: string): string {
  const tail = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join('');
  return `${prefix}_${Date.now().toString(36)}${tail}`;
}

/** `Organization` and `organization` are an organisation; everything else is a user. */
export function githubAccountType(accountType: string): 'organization' | 'user' {
  return accountType.toLowerCase().startsWith('org') ? 'organization' : 'user';
}

/** The live GitHub connections of an installation, newest active first. */
export async function findGithubConnections(db: InstallationDb, installationId: number | string): Promise<MergeConnectionRecord[]> {
  const rows = await db
    .select()
    .from(mergeConnections)
    .where(
      and(
        eq(mergeConnections.provider, 'github'),
        eq(mergeConnections.externalAccountId, String(installationId)),
        isNull(mergeConnections.deletedAt),
      ),
    )
    .orderBy(desc(mergeConnections.createdAt), desc(mergeConnections.id));
  return rows;
}

/** An installation whose master index row names another workspace: it is not this workspace's to record. */
export class GithubInstallationTakenError extends Error {
  constructor(readonly installationId: string) {
    super(`GitHub installation ${installationId} belongs to another workspace`);
    this.name = 'GithubInstallationTakenError';
  }
}

/**
 * Writes (or re-points) the master `installation id -> workspace` row. Only for
 * the webhook receiver's lazy backfill, which found the installation's live
 * connection in that workspace's tenant database; a member's install goes
 * through `claimGithubInstallationIndex`, which never re-points.
 */
export async function upsertGithubInstallationIndex(
  masterDb: InstallationDb,
  installationId: number | string,
  workspaceId: string,
  now = new Date(),
): Promise<void> {
  await masterDb
    .insert(mergeProviderIndex)
    .values({
      id: newId('mpi'),
      provider: 'github',
      kind: 'installation',
      externalKey: String(installationId),
      workspaceId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [mergeProviderIndex.provider, mergeProviderIndex.kind, mergeProviderIndex.externalKey],
      set: { workspaceId, updatedAt: now },
    });
}

/**
 * Claims the master index row for `workspaceId`: inserts it, or refreshes it
 * when it already names that workspace. A row naming another workspace is left
 * as it is and the claim throws `GithubInstallationTakenError`.
 */
export async function claimGithubInstallationIndex(
  masterDb: InstallationDb,
  installationId: number | string,
  workspaceId: string,
  now = new Date(),
): Promise<void> {
  const claimed = await masterDb
    .insert(mergeProviderIndex)
    .values({
      id: newId('mpi'),
      provider: 'github',
      kind: 'installation',
      externalKey: String(installationId),
      workspaceId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [mergeProviderIndex.provider, mergeProviderIndex.kind, mergeProviderIndex.externalKey],
      set: { updatedAt: now },
      setWhere: eq(mergeProviderIndex.workspaceId, workspaceId),
    })
    .returning({ id: mergeProviderIndex.id });
  if (claimed.length === 0) throw new GithubInstallationTakenError(String(installationId));
}

/** Drops the master index row of an installation only when it names `workspaceId` (a member's own disconnect). */
export async function releaseGithubInstallationIndex(
  masterDb: InstallationDb,
  installationId: number | string,
  workspaceId: string,
): Promise<void> {
  await masterDb
    .delete(mergeProviderIndex)
    .where(
      and(
        eq(mergeProviderIndex.provider, 'github'),
        eq(mergeProviderIndex.kind, 'installation'),
        eq(mergeProviderIndex.externalKey, String(installationId)),
        eq(mergeProviderIndex.workspaceId, workspaceId),
      ),
    );
}

/**
 * Drops the master index row of an installation (it was uninstalled), whoever
 * it names. Only for an uninstall GitHub signed (the `installation` webhook);
 * anything a member starts uses `releaseGithubInstallationIndex`.
 */
export async function removeGithubInstallationIndex(masterDb: InstallationDb, installationId: number | string): Promise<void> {
  await masterDb
    .delete(mergeProviderIndex)
    .where(
      and(
        eq(mergeProviderIndex.provider, 'github'),
        eq(mergeProviderIndex.kind, 'installation'),
        eq(mergeProviderIndex.externalKey, String(installationId)),
      ),
    );
}

function installationFields(input: RecordGithubInstallationInput, now: Date) {
  return {
    appSlug: input.appSlug,
    accountLogin: input.accountLogin,
    accountType: githubAccountType(input.accountType),
    status: input.status ?? ('active' as const),
    installedAt: now,
    revokedAt: null,
    updatedAt: now,
  };
}

/**
 * Claims the installation's row in the master index, then upserts its
 * connection in the tenant DB. An existing live row is refreshed (and revived
 * when it was revoked or suspended), keeping its id and webhook secret; a new
 * one gets a fresh random webhook secret, sealed under the keyring.
 * Idempotent. Throws `GithubInstallationTakenError`, writing nothing, when the
 * index row names another workspace.
 */
export async function recordGithubInstallation(
  tenantDb: InstallationDb,
  masterDb: InstallationDb,
  input: RecordGithubInstallationInput,
): Promise<RecordedGithubInstallation> {
  const now = input.now ?? new Date();
  const externalAccountId = String(input.installationId);
  await claimGithubInstallationIndex(masterDb, externalAccountId, input.workspaceId, now);

  const refresh = async (existing: MergeConnectionRecord): Promise<MergeConnectionRecord> => {
    const [row] = await tenantDb
      .update(mergeConnections)
      .set({
        ...installationFields(input, now),
        ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
        ...(existing.webhookSecret ? {} : { webhookSecret: await encryptField(randomHex(32), input.keyring) }),
      })
      .where(eq(mergeConnections.id, existing.id))
      .returning();
    return row!;
  };

  let connection: MergeConnectionRecord;
  let action: RecordedGithubInstallation['action'];
  const [existing] = await findGithubConnections(tenantDb, externalAccountId);
  if (existing) {
    connection = await refresh(existing);
    action = 'updated';
  } else {
    try {
      const [row] = await tenantDb
        .insert(mergeConnections)
        .values({
          id: newId('mcn'),
          provider: 'github',
          externalAccountId,
          ...installationFields(input, now),
          scopes: input.scopes ?? null,
          webhookSecret: await encryptField(randomHex(32), input.keyring),
          createdByUserId: input.userId,
          createdAt: now,
        })
        .returning();
      connection = row!;
      action = 'created';
    } catch (err) {
      // Two installs recorded at once: the other insert won, refresh its row.
      const [winner] = await findGithubConnections(tenantDb, externalAccountId);
      if (!winner) throw err;
      connection = await refresh(winner);
      action = 'updated';
    }
  }

  return { connection, action };
}

/**
 * Moves every live connection of an installation to `status` (GitHub's
 * `installation` events: `suspend` -> suspended, `unsuspend` -> active,
 * `deleted` -> revoked). Returns the rows as they are now, so the caller
 * publishes `merge_connection` updated for each.
 */
export async function setGithubInstallationStatus(
  tenantDb: InstallationDb,
  installationId: number | string,
  status: Extract<MergeConnectionStatus, 'active' | 'suspended' | 'revoked'>,
  now = new Date(),
): Promise<MergeConnectionRecord[]> {
  return tenantDb
    .update(mergeConnections)
    .set({ status, revokedAt: status === 'revoked' ? now : null, updatedAt: now })
    .where(
      and(
        eq(mergeConnections.provider, 'github'),
        eq(mergeConnections.externalAccountId, String(installationId)),
        isNull(mergeConnections.deletedAt),
      ),
    )
    .returning();
}
