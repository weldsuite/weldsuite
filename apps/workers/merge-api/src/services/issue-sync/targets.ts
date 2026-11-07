/**
 * What a sync call acts on: a tracked repository with its live connection, the
 * link between an issue and its provider issue, and the adapter context.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  mergeConnections,
  mergeExternalIssues,
  mergeRepositories,
  type Db,
  type MergeConnectionRow,
  type MergeExternalIssueRow,
  type MergeRepositoryRow,
} from '../db';
import type { AdapterContext, RepositoryRef } from '../providers/types';
import type { Env } from '../../types';
import { adapterContextFor } from '../providers/context';

export interface SyncTarget {
  repository: MergeRepositoryRow;
  connection: MergeConnectionRow;
}

const liveTarget = [isNull(mergeRepositories.deletedAt), isNull(mergeConnections.deletedAt), eq(mergeConnections.status, 'active')];

/** A live repository on an active connection, by its id. */
export async function loadTarget(db: Db, repositoryId: string): Promise<SyncTarget | null> {
  const [row] = await db
    .select({ repository: mergeRepositories, connection: mergeConnections })
    .from(mergeRepositories)
    .innerJoin(mergeConnections, eq(mergeConnections.id, mergeRepositories.connectionId))
    .where(and(eq(mergeRepositories.id, repositoryId), ...liveTarget))
    .limit(1);
  return row ?? null;
}

/** A live repository on an active connection, by the provider's id. */
export async function loadTargetByExternalId(db: Db, provider: MergeProvider, externalId: string): Promise<SyncTarget | null> {
  const [row] = await db
    .select({ repository: mergeRepositories, connection: mergeConnections })
    .from(mergeRepositories)
    .innerJoin(mergeConnections, eq(mergeConnections.id, mergeRepositories.connectionId))
    .where(and(eq(mergeRepositories.provider, provider), eq(mergeRepositories.externalId, externalId), ...liveTarget))
    .limit(1);
  return row ?? null;
}

export async function findLinkByIssue(db: Db, issueId: string): Promise<MergeExternalIssueRow | null> {
  const [row] = await db.select().from(mergeExternalIssues).where(eq(mergeExternalIssues.issueId, issueId)).limit(1);
  return row ?? null;
}

export async function findLinkByNumber(db: Db, repositoryId: string, number: number): Promise<MergeExternalIssueRow | null> {
  const [row] = await db
    .select()
    .from(mergeExternalIssues)
    .where(and(eq(mergeExternalIssues.repositoryId, repositoryId), eq(mergeExternalIssues.number, number)))
    .limit(1);
  return row ?? null;
}

export function repositoryRef(repository: MergeRepositoryRow): RepositoryRef {
  return {
    externalId: repository.externalId,
    fullName: repository.fullName,
    externalProject: repository.externalProject,
    defaultBranch: repository.defaultBranch,
  };
}

/** The adapter context of a target: the connection's token resolved (and refreshed) for providers that use one. */
export const adapterContext = (db: Db, env: Env, target: SyncTarget): Promise<AdapterContext> =>
  adapterContextFor(db, env, target.connection);
