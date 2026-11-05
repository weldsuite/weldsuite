/**
 * GitHub Connections Service
 *
 * WeldFlow's and WeldConnect's view of the workspace's GitHub App installation.
 * The installation is a WeldMerge connection: a `merge_connections` row with
 * provider `github` (ADR MERGE-002), recorded by the install flow through
 * `@weldsuite/merge-domain/installations`, the same code merge-api's setup route
 * runs. This module reads those rows and maps them back to the shape this
 * worker's routes have always answered (installationId as a number, owner
 * type `user` / `org`, `createdBy`), so their paths and response shapes did not
 * change with the move off `github_connections`.
 *
 * Reads take the newest active connection first. The tenant database is the
 * workspace, so none of the queries needs a workspace filter.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { getMasterDb, getWorkspaceForOrg, schema } from '@weldsuite/worker-kit/db';
import type { EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import {
  recordGithubInstallation,
  removeGithubInstallationIndex,
  setGithubInstallationStatus,
  type MergeConnectionRecord,
  type RecordedGithubInstallation,
} from '@weldsuite/merge-domain/installations';
import type { Env } from '../../types';

const { mergeConnections } = schema;

export type GithubConnectionStatus = 'active' | 'suspended' | 'revoked';

/** A `merge_connections` GitHub row in the shape connect-api's routes answer. */
export interface GithubConnectionView {
  id: string;
  workspaceId: string;
  installationId: number;
  appSlug: string;
  ownerType: 'user' | 'org';
  ownerLogin: string;
  webhookSecret: string | null;
  createdBy: string | null;
  status: GithubConnectionStatus;
  scopes: string[] | null;
  installedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** `needs_attention` is not a GitHub App state; to this worker's callers the connection is unusable, like a suspended one. */
function viewStatus(status: MergeConnectionRecord['status']): GithubConnectionStatus {
  return status === 'needs_attention' ? 'suspended' : status;
}

export function toGithubConnection(row: MergeConnectionRecord, workspaceId = ''): GithubConnectionView {
  return {
    id: row.id,
    workspaceId,
    installationId: Number(row.externalAccountId),
    appSlug: row.appSlug ?? '',
    ownerType: row.accountType === 'organization' ? 'org' : 'user',
    ownerLogin: row.accountLogin ?? '',
    webhookSecret: row.webhookSecret,
    createdBy: row.createdByUserId,
    status: viewStatus(row.status),
    scopes: row.scopes,
    installedAt: row.installedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

const githubRows = and(eq(mergeConnections.provider, 'github'), isNull(mergeConnections.deletedAt));
/** Active connections before the others, newest first. */
const activeFirst = [sql`(${mergeConnections.status} = 'active') desc`, desc(mergeConnections.createdAt), desc(mergeConnections.id)] as const;

// ============================================================================
// Queries
// ============================================================================

/**
 * The workspace's GitHub connection: the newest active one, else the newest of
 * any state (the settings page still shows a revoked one).
 */
export async function getConnectionByWorkspace(db: Database, workspaceId = ''): Promise<GithubConnectionView | null> {
  const [row] = await db
    .select()
    .from(mergeConnections)
    .where(githubRows)
    .orderBy(...activeFirst)
    .limit(1);
  return row ? toGithubConnection(row, workspaceId) : null;
}

/** The connection of a GitHub installation id (what the webhook receiver resolves). */
export async function getConnectionByInstallationId(db: Database, installationId: number): Promise<GithubConnectionView | null> {
  const [row] = await db
    .select()
    .from(mergeConnections)
    .where(and(githubRows, eq(mergeConnections.externalAccountId, String(installationId))))
    .orderBy(...activeFirst)
    .limit(1);
  return row ? toGithubConnection(row) : null;
}

// ============================================================================
// Writes: the install flow
// ============================================================================

export interface RecordInstallationInput {
  installationId: number;
  appSlug: string;
  accountLogin: string;
  /** `Organization` or `User`, as GitHub says it. */
  accountType: string;
  userId: string;
  keyring: EncryptionKeyring;
}

/**
 * Records the installation as the workspace's connection: the `merge_connections`
 * row and the master installation index, through the shared
 * `recordGithubInstallation`. `workspaceRef` is the workspace's Clerk org id or
 * `workspaces.id`; the index stores `workspaces.id`.
 */
export async function recordInstallation(
  env: Env,
  db: Database,
  workspaceRef: string,
  input: RecordInstallationInput,
): Promise<RecordedGithubInstallation> {
  const workspace = await getWorkspaceForOrg(env, workspaceRef);
  return recordGithubInstallation(db, getMasterDb(env), { ...input, workspaceId: workspace.id });
}

/** Revokes the connection of an installation GitHub says was uninstalled, and drops it from the master index. */
export async function revokeInstallation(env: Env, db: Database, installationId: number): Promise<void> {
  await setGithubInstallationStatus(db, installationId, 'revoked');
  await removeGithubInstallationIndex(getMasterDb(env), installationId);
}

/** Disconnects the workspace: every live GitHub connection is revoked and leaves the master index. */
export async function revokeConnection(env: Env, db: Database): Promise<void> {
  const rows = await db.select({ externalAccountId: mergeConnections.externalAccountId }).from(mergeConnections).where(githubRows);
  for (const row of rows) await revokeInstallation(env, db, Number(row.externalAccountId));
}

/**
 * Update connection status (active / suspended / revoked), by installation id.
 * Not scoped by workspace: called after the installation id resolved it.
 */
export async function updateConnectionStatus(
  db: Database,
  installationId: number,
  status: GithubConnectionStatus,
): Promise<void> {
  await setGithubInstallationStatus(db, installationId, status);
}
