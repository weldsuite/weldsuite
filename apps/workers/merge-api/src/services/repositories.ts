/** Repositories WeldMerge tracks, and the backfill that loads their pull requests. */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import type { AddMergeRepositoryInput, UpdateMergeRepositoryInput } from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  mergeConnections,
  mergePullRequests,
  mergeRepositories,
  type Db,
  type MergeConnectionRow,
  type MergeRepositoryRow,
} from './db';
import type { PendingEvent } from './events';
import { getRepositoryById, listPullRequestsForBackfill, type GithubClient } from './github-client';
import { upsertPullRequest } from './pr-sync';
import { findTeam } from './teams';

export async function openPullRequestCounts(db: Db, repositoryIds: string[]): Promise<Map<string, number>> {
  if (repositoryIds.length === 0) return new Map();
  const rows = await db
    .select({ repositoryId: mergePullRequests.repositoryId, count: sql<number>`count(*)::int` })
    .from(mergePullRequests)
    .where(and(inArray(mergePullRequests.repositoryId, repositoryIds), eq(mergePullRequests.state, 'open')))
    .groupBy(mergePullRequests.repositoryId);
  return new Map(rows.map((r) => [r.repositoryId, r.count]));
}

export async function listRepositories(db: Db): Promise<Array<{ row: MergeRepositoryRow; openPullRequestCount: number }>> {
  const rows = await db
    .select({ repo: mergeRepositories })
    .from(mergeRepositories)
    .innerJoin(mergeConnections, eq(mergeConnections.id, mergeRepositories.connectionId))
    .where(and(isNull(mergeRepositories.deletedAt), isNull(mergeConnections.deletedAt)))
    .orderBy(asc(mergeRepositories.fullName), asc(mergeRepositories.id));
  const counts = await openPullRequestCounts(
    db,
    rows.map((r) => r.repo.id),
  );
  return rows.map((r) => ({ row: r.repo, openPullRequestCount: counts.get(r.repo.id) ?? 0 }));
}

export async function findRepository(db: Db, id: string): Promise<MergeRepositoryRow | null> {
  const [row] = await db
    .select()
    .from(mergeRepositories)
    .where(and(eq(mergeRepositories.id, id), isNull(mergeRepositories.deletedAt)))
    .limit(1);
  return row ?? null;
}

export interface SyncSummary {
  pullRequestsSynced: number;
  linksCreated: number;
  events: PendingEvent[];
}

/**
 * Reads open pull requests and those closed or merged in the last 30 days and
 * mirrors them, with their `auto` links. It never runs the automation rules: a
 * backfill must not move issues.
 */
export async function syncRepository(db: Db, repository: MergeRepositoryRow, client: GithubClient): Promise<SyncSummary> {
  const pulls = await listPullRequestsForBackfill(client, repository.fullName);
  const summary: SyncSummary = { pullRequestsSynced: 0, linksCreated: 0, events: [] };
  for (const pull of pulls) {
    const outcome = await upsertPullRequest(db, repository, pull, { automate: false, skipUnchanged: true });
    if (outcome.status !== 'stale') summary.pullRequestsSynced++;
    summary.linksCreated += outcome.linksCreated;
    summary.events.push(...outcome.events);
  }
  return summary;
}

export async function touchSynced(db: Db, id: string): Promise<MergeRepositoryRow> {
  const now = new Date();
  const [row] = await db
    .update(mergeRepositories)
    .set({ lastSyncedAt: now, updatedAt: now })
    .where(eq(mergeRepositories.id, id))
    .returning();
  return row!;
}

export type AddRepositoryResult =
  | { ok: true; repository: MergeRepositoryRow; sync: SyncSummary }
  | { ok: false; reason: 'connection_not_found' | 'repository_not_found' | 'already_added' | 'team_not_found' };

export async function addRepository(
  db: Db,
  connection: MergeConnectionRow,
  input: AddMergeRepositoryInput,
  userId: string,
  client: GithubClient,
): Promise<AddRepositoryResult> {
  const teamId = input.teamId ?? null;
  if (teamId && !(await findTeam(db, teamId))) return { ok: false, reason: 'team_not_found' };

  const [dupe] = await db
    .select({ id: mergeRepositories.id })
    .from(mergeRepositories)
    .where(
      and(
        eq(mergeRepositories.connectionId, connection.id),
        eq(mergeRepositories.externalId, input.externalId),
        isNull(mergeRepositories.deletedAt),
      ),
    )
    .limit(1);
  if (dupe) return { ok: false, reason: 'already_added' };

  const github = await getRepositoryById(client, input.externalId);
  if (!github) return { ok: false, reason: 'repository_not_found' };

  const now = new Date();
  let repository: MergeRepositoryRow;
  try {
    const [row] = await db
      .insert(mergeRepositories)
      .values({
        id: generateId('mrp'),
        connectionId: connection.id,
        provider: connection.provider,
        externalId: String(github.id),
        fullName: github.full_name,
        defaultBranch: github.default_branch ?? null,
        private: github.private,
        url: github.html_url ?? null,
        teamId,
        issueSync: 'off',
        prSync: input.prSync ?? true,
        createdByUserId: userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    repository = row!;
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'already_added' };
    throw err;
  }

  const sync = await syncRepository(db, repository, client);
  repository = await touchSynced(db, repository.id);
  return { ok: true, repository, sync };
}

export type UpdateRepositoryResult =
  | { ok: true; before: MergeRepositoryRow; repository: MergeRepositoryRow }
  | { ok: false; reason: 'not_found' | 'team_not_found' | 'issue_sync_unsupported' };

export async function updateRepository(db: Db, id: string, input: UpdateMergeRepositoryInput): Promise<UpdateRepositoryResult> {
  const before = await findRepository(db, id);
  if (!before) return { ok: false, reason: 'not_found' };
  if (input.issueSync !== undefined && input.issueSync !== 'off') return { ok: false, reason: 'issue_sync_unsupported' };
  if (input.teamId && !(await findTeam(db, input.teamId))) return { ok: false, reason: 'team_not_found' };

  const patch: Partial<typeof mergeRepositories.$inferInsert> = { updatedAt: new Date() };
  if (input.teamId !== undefined) patch.teamId = input.teamId;
  if (input.prSync !== undefined) patch.prSync = input.prSync;
  if (input.issueSync !== undefined) patch.issueSync = input.issueSync;
  const [repository] = await db.update(mergeRepositories).set(patch).where(eq(mergeRepositories.id, id)).returning();
  return { ok: true, before, repository: repository! };
}

export async function deleteRepository(db: Db, id: string): Promise<MergeRepositoryRow | null> {
  const existing = await findRepository(db, id);
  if (!existing) return null;
  const now = new Date();
  const [row] = await db
    .update(mergeRepositories)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(mergeRepositories.id, id))
    .returning();
  return row!;
}

export function repositoryEventData(row: MergeRepositoryRow) {
  return {
    id: row.id,
    connectionId: row.connectionId,
    provider: row.provider,
    fullName: row.fullName,
    teamId: row.teamId,
  };
}

export function connectionEventData(row: MergeConnectionRow) {
  return { id: row.id, provider: row.provider, accountLogin: row.accountLogin, status: row.status };
}
