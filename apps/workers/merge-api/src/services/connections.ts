/**
 * Git-provider connections (ADR MERGE-002). For GitHub a connection adopts the
 * workspace's existing GitHub App installation (`github_connections`, written by
 * connect-api's install flow); there is no second consent and nothing secret is
 * stored: installation tokens are minted per call.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import {
  githubConnections,
  mergeConnections,
  mergeRepositories,
  type Db,
  type MergeConnectionRow,
  type MergeRepositoryRow,
} from './db';

export async function listConnections(db: Db): Promise<Array<{ row: MergeConnectionRow; repositoryCount: number }>> {
  const rows = await db
    .select()
    .from(mergeConnections)
    .where(isNull(mergeConnections.deletedAt))
    .orderBy(desc(mergeConnections.createdAt), desc(mergeConnections.id));
  if (rows.length === 0) return [];
  const counts = await db
    .select({ connectionId: mergeRepositories.connectionId, count: sql<number>`count(*)::int` })
    .from(mergeRepositories)
    .where(
      and(
        inArray(
          mergeRepositories.connectionId,
          rows.map((r) => r.id),
        ),
        isNull(mergeRepositories.deletedAt),
      ),
    )
    .groupBy(mergeRepositories.connectionId);
  const byConnection = new Map(counts.map((c) => [c.connectionId, c.count]));
  return rows.map((row) => ({ row, repositoryCount: byConnection.get(row.id) ?? 0 }));
}

export async function findConnection(db: Db, id: string): Promise<MergeConnectionRow | null> {
  const [row] = await db
    .select()
    .from(mergeConnections)
    .where(and(eq(mergeConnections.id, id), isNull(mergeConnections.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function repositoryCount(db: Db, connectionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mergeRepositories)
    .where(and(eq(mergeRepositories.connectionId, connectionId), isNull(mergeRepositories.deletedAt)));
  return row?.count ?? 0;
}

export type ConnectGithubResult =
  | { status: 'needs_install' }
  | { status: 'connected'; connection: MergeConnectionRow; created: boolean };

/** Adopts the workspace's active GitHub App installation; idempotent. */
export async function connectGithub(db: Db, userId: string): Promise<ConnectGithubResult> {
  const [installation] = await db
    .select()
    .from(githubConnections)
    .where(and(eq(githubConnections.status, 'active'), isNull(githubConnections.deletedAt)))
    .orderBy(desc(githubConnections.createdAt), desc(githubConnections.id))
    .limit(1);
  if (!installation) return { status: 'needs_install' };

  const externalAccountId = String(installation.installationId);
  const find = async () => {
    const [row] = await db
      .select()
      .from(mergeConnections)
      .where(
        and(
          eq(mergeConnections.provider, 'github'),
          eq(mergeConnections.externalAccountId, externalAccountId),
          isNull(mergeConnections.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  };

  const existing = await find();
  if (existing) {
    if (existing.status === 'active') return { status: 'connected', connection: existing, created: false };
    const [revived] = await db
      .update(mergeConnections)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(mergeConnections.id, existing.id))
      .returning();
    return { status: 'connected', connection: revived!, created: false };
  }

  const now = new Date();
  try {
    const [row] = await db
      .insert(mergeConnections)
      .values({
        id: generateId('mcn'),
        provider: 'github',
        externalAccountId,
        accountLogin: installation.ownerLogin,
        accountType: installation.ownerType === 'org' ? 'organization' : 'user',
        status: 'active',
        createdByUserId: userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return { status: 'connected', connection: row!, created: true };
  } catch (err) {
    // Two members connected at once: the other insert won.
    if (!isUniqueViolation(err)) throw err;
    const winner = await find();
    if (!winner) throw err;
    return { status: 'connected', connection: winner, created: false };
  }
}

/** Soft-deletes the connection and its repositories. Never uninstalls the GitHub App. */
export async function deleteConnection(
  db: Db,
  id: string,
): Promise<{ connection: MergeConnectionRow; repositories: MergeRepositoryRow[] } | null> {
  const existing = await findConnection(db, id);
  if (!existing) return null;
  const now = new Date();
  const repositories = await db
    .update(mergeRepositories)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(mergeRepositories.connectionId, id), isNull(mergeRepositories.deletedAt)))
    .returning();
  const [connection] = await db
    .update(mergeConnections)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(mergeConnections.id, id))
    .returning();
  return { connection: connection!, repositories };
}
