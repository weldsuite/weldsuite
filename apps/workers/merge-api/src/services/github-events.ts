/**
 * GitHub event intake: what integration-webhook-worker forwards after it has
 * verified the App's HMAC and resolved the workspace. Pure of Hono: the route
 * and the `MergeInternal` entrypoint call it, and so do the tests.
 *
 * A repository WeldMerge doesn't track, or tracks with `pr_sync` off, is
 * ignored. A copy older than the stored one is ignored (`isNotOlder`).
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  combineCheckSuites,
  reviewDecisionFromReviews,
  type GithubPullRequest,
} from '@weldsuite/merge-domain/github';
import type { MergeGithubEventEnvelope } from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  mergeConnections,
  mergePullRequests,
  mergeRepositories,
  type Db,
  type MergePullRequestRow,
  type MergeRepositoryRow,
} from './db';
import type { PendingEvent } from './events';
import { listCheckSuites, listPullRequestReviews, type GithubClient } from './github-client';
import { afterPullRequestSynced, type HookContext } from './hooks';
import { handleGithubIssueSyncEvent } from './issue-sync/hooks';
import { pullRequestEventData, upsertPullRequest } from './pr-sync';
import { linkedIssuesByPullRequest } from './pull-requests';
import { repositoryEventData } from './repositories';

export interface GithubEventResult {
  /** What happened: `applied`, or why the event was dropped. */
  outcome: 'applied' | 'ignored';
  /** Why the event was dropped (`untracked_repository`, `pr_sync_off`, `stale`, `unknown_pull_request`, `no_installation`, `no_payload`, …). */
  reason?: string;
  events: PendingEvent[];
}

const ignored = (reason: string): GithubEventResult => ({
  outcome: 'ignored',
  reason,
  events: [],
});

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);

/** The installation a payload came from, as the string `merge_connections.external_account_id` holds. */
function installationOf(payload: Json): string | null {
  const id = obj(payload.installation)?.id;
  return typeof id === 'number' || typeof id === 'string' ? String(id) : null;
}

/** A tracked repository by the provider's id (live, on a live connection). */
async function trackedRepository(db: Db, payload: Json): Promise<MergeRepositoryRow | null> {
  const repoId = obj(payload.repository)?.id;
  if (typeof repoId !== 'number' && typeof repoId !== 'string') return null;
  const [row] = await db
    .select({ repo: mergeRepositories })
    .from(mergeRepositories)
    .innerJoin(mergeConnections, eq(mergeConnections.id, mergeRepositories.connectionId))
    .where(
      and(
        eq(mergeRepositories.provider, 'github'),
        eq(mergeRepositories.externalId, String(repoId)),
        isNull(mergeRepositories.deletedAt),
        isNull(mergeConnections.deletedAt),
      ),
    )
    .limit(1);
  return row?.repo ?? null;
}

async function installationRepositoriesEvent(db: Db, payload: Json): Promise<GithubEventResult> {
  const installation = installationOf(payload);
  if (!installation) return ignored('no_installation');
  const removed = Array.isArray(payload.repositories_removed) ? payload.repositories_removed : [];
  const ids = removed.map((r) => obj(r)?.id).filter((id): id is number | string => typeof id === 'number' || typeof id === 'string').map(String);
  if (ids.length === 0) return { outcome: 'applied', events: [] };

  const connections = await db
    .select({ id: mergeConnections.id })
    .from(mergeConnections)
    .where(
      and(
        eq(mergeConnections.provider, 'github'),
        eq(mergeConnections.externalAccountId, installation),
        isNull(mergeConnections.deletedAt),
      ),
    );
  if (connections.length === 0) return ignored('untracked_repository');

  const now = new Date();
  const rows = await db
    .update(mergeRepositories)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        inArray(
          mergeRepositories.connectionId,
          connections.map((c) => c.id),
        ),
        inArray(mergeRepositories.externalId, ids),
        isNull(mergeRepositories.deletedAt),
      ),
    )
    .returning();
  return {
    outcome: 'applied',
    events: rows.map((row) => ({
      entityType: 'merge_repository' as const,
      action: 'deleted' as const,
      entityId: row.id,
      data: repositoryEventData(row),
    })),
  };
}

async function pullRequestEvent(db: Db, payload: Json, hooks?: HookContext): Promise<GithubEventResult> {
  const pull = obj(payload.pull_request);
  if (!pull) return ignored('no_payload');
  const repository = await trackedRepository(db, payload);
  if (!repository) return ignored('untracked_repository');
  if (!repository.prSync) return ignored('pr_sync_off');

  const outcome = await upsertPullRequest(db, repository, pull as unknown as GithubPullRequest, { automate: true, hooks });
  if (outcome.status === 'stale') return ignored('stale');
  return { outcome: 'applied', events: outcome.events };
}

async function pullRequestFor(db: Db, repository: MergeRepositoryRow, number: number): Promise<MergePullRequestRow | null> {
  const [row] = await db
    .select()
    .from(mergePullRequests)
    .where(and(eq(mergePullRequests.repositoryId, repository.id), eq(mergePullRequests.number, number)))
    .limit(1);
  return row ?? null;
}

async function updateEvent(db: Db, pr: MergePullRequestRow): Promise<PendingEvent> {
  const issues = await linkedIssuesByPullRequest(db, [pr.id]);
  return {
    entityType: 'merge_pull_request',
    action: 'updated',
    entityId: pr.id,
    data: pullRequestEventData(
      pr,
      (issues.get(pr.id) ?? []).map((i) => i.id),
    ),
  };
}

async function reviewEvent(db: Db, payload: Json, client: GithubClient, hooks?: HookContext): Promise<GithubEventResult> {
  const number = obj(payload.pull_request)?.number;
  if (typeof number !== 'number') return ignored('no_payload');
  const repository = await trackedRepository(db, payload);
  if (!repository) return ignored('untracked_repository');
  if (!repository.prSync) return ignored('pr_sync_off');
  const pr = await pullRequestFor(db, repository, number);
  if (!pr) return ignored('unknown_pull_request');

  const reviews = await listPullRequestReviews(client, repository.fullName, number);
  const decision = reviewDecisionFromReviews(reviews, pr.requestedReviewers.length);
  const [updated] = await db
    .update(mergePullRequests)
    .set({ reviewDecision: decision, syncedAt: new Date(), updatedAt: new Date() })
    .where(eq(mergePullRequests.id, pr.id))
    .returning();
  const event = await updateEvent(db, updated!);
  event.changes = { reviewDecision: { old: pr.reviewDecision, new: decision } };
  if (hooks) await afterPullRequestSynced(hooks, pr, updated!, [event]);
  return { outcome: 'applied', events: [event] };
}

async function checkSuiteEvent(db: Db, payload: Json, client: GithubClient, hooks?: HookContext): Promise<GithubEventResult> {
  const sha = obj(payload.check_suite)?.head_sha;
  if (typeof sha !== 'string' || sha === '') return ignored('no_payload');
  const repository = await trackedRepository(db, payload);
  if (!repository) return ignored('untracked_repository');
  if (!repository.prSync) return ignored('pr_sync_off');

  const tracked = await db
    .select()
    .from(mergePullRequests)
    .where(
      and(
        eq(mergePullRequests.repositoryId, repository.id),
        eq(mergePullRequests.headSha, sha),
        eq(mergePullRequests.state, 'open'),
      ),
    );
  if (tracked.length === 0) return ignored('unknown_pull_request');

  const status = combineCheckSuites(await listCheckSuites(client, repository.fullName, sha));
  const events: PendingEvent[] = [];
  for (const pr of tracked) {
    const [updated] = await db
      .update(mergePullRequests)
      .set({ checksStatus: status, syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(mergePullRequests.id, pr.id))
      .returning();
    const event = await updateEvent(db, updated!);
    event.changes = { checksStatus: { old: pr.checksStatus, new: status } };
    events.push(event);
    if (hooks) await afterPullRequestSynced(hooks, pr, updated!, [event]);
  }
  return { outcome: 'applied', events };
}

/**
 * Applies one forwarded GitHub event to the workspace's tenant DB. `client`
 * is made only when an event needs GitHub (reviews, check suites).
 */
export async function handleGithubEvent(
  db: Db,
  envelope: MergeGithubEventEnvelope,
  makeClient: (installationId: string) => GithubClient,
  /** Area hooks (issue sync, chat posts) run with it after a write; the tests leave it out. */
  hooks?: HookContext,
): Promise<GithubEventResult> {
  const payload = envelope.payload as Json;
  const clientFor = () => {
    const installation = installationOf(payload);
    if (!installation) throw new Error('GitHub event without an installation id');
    return makeClient(installation);
  };
  switch (envelope.event) {
    case 'pull_request':
      return pullRequestEvent(db, payload, hooks);
    case 'pull_request_review':
      return installationOf(payload) ? reviewEvent(db, payload, clientFor(), hooks) : ignored('no_installation');
    case 'check_suite':
      return installationOf(payload) ? checkSuiteEvent(db, payload, clientFor(), hooks) : ignored('no_installation');
    case 'installation_repositories':
      return installationRepositoriesEvent(db, payload);
    // Area A: issue sync (issues, issue_comment) and the installation lifecycle.
    case 'issues':
    case 'issue_comment':
    case 'installation':
      return handleGithubIssueSyncEvent(db, envelope, hooks);
  }
}
