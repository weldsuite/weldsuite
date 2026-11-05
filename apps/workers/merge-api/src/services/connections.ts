/**
 * Git-provider connections (ADR MERGE-002). A GitHub connection is the
 * workspace's GitHub App installation, recorded by the install flow (merge-api's
 * setup route or connect-api's callback, both through
 * `@weldsuite/merge-domain/installations`); nothing secret is stored for the
 * App itself: installation tokens are minted per call.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
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
  | { status: 'connected'; connection: MergeConnectionRow };

/**
 * The workspace's live GitHub connection, newest active first: the answer of
 * `POST /connections/github`. Installing the App goes through the install
 * flow (`@weldsuite/merge-domain/installations`), which writes the row; with
 * none (or only revoked or suspended ones) the member has to install first.
 */
export async function connectGithub(db: Db): Promise<ConnectGithubResult> {
  const [connection] = await db
    .select()
    .from(mergeConnections)
    .where(
      and(
        eq(mergeConnections.provider, 'github'),
        eq(mergeConnections.status, 'active'),
        isNull(mergeConnections.deletedAt),
      ),
    )
    .orderBy(desc(mergeConnections.createdAt), desc(mergeConnections.id))
    .limit(1);
  return connection ? { status: 'connected', connection } : { status: 'needs_install' };
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
