/**
 * Review and merge (phase 4): the orchestration between the routes and a
 * provider's `ReviewAdapter`. Reads act with the connection's token (GitHub: an
 * installation token), writes act as the member (their linked, verified
 * account). A refusal comes back as a `ReviewFailure` the route turns into a
 * response; after a merge or review the mirror is re-fetched and saved the way
 * a webhook would, so automations and hooks run.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { MergePullRequestDetailDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import type {
  CreateMergePullRequestCommentInput,
  MergeMergePullRequestInput,
  MergePullRequestCommentResult,
  MergePullRequestFile,
  MergeReviewThread,
  SubmitMergeReviewInput,
} from '@weldsuite/app-api-client/schemas/weldmerge-review';
import { getConnectionToken, getMemberToken } from './credentials';
import {
  mergeConnections,
  mergePullRequests,
  mergeRepositories,
  type Db,
  type MergeConnectionRow,
  type MergePullRequestRow,
  type MergeRepositoryRow,
} from './db';
import type { PendingEvent } from './events';
import { GithubApiError } from './github-client';
import type { HookContext } from './hooks';
import { pullRequestEventData, upsertMirror } from './pr-sync';
import { getPullRequestDetail, linkedIssuesByPullRequest } from './pull-requests';
import { adapterFor, reviewAdapterFor } from './providers/registry';
import {
  ProviderApiError,
  ProviderUnsupportedError,
  type AdapterContext,
  type RepositoryRef,
} from './providers/types';

/** Why a review call did not go through; the route maps each to its status and code. */
export type ReviewFailure =
  | { code: 'not_found' }
  | { code: 'account_not_linked'; message: string }
  | { code: 'not_mergeable'; message: string }
  | { code: 'unsupported'; message: string }
  | { code: 'provider_error'; message: string };

export type ReviewResult<T> = { ok: true; value: T; events: PendingEvent[] } | { ok: false; failure: ReviewFailure };

const done = <T>(value: T, events: PendingEvent[] = []): ReviewResult<T> => ({ ok: true, value, events });
const fail = (failure: ReviewFailure): ReviewResult<never> => ({ ok: false, failure });

interface Target {
  pr: MergePullRequestRow;
  repository: MergeRepositoryRow;
  connection: MergeConnectionRow;
}

async function loadTarget(db: Db, id: string): Promise<Target | null> {
  const [row] = await db
    .select({ pr: mergePullRequests, repository: mergeRepositories, connection: mergeConnections })
    .from(mergePullRequests)
    .innerJoin(mergeRepositories, eq(mergeRepositories.id, mergePullRequests.repositoryId))
    .innerJoin(mergeConnections, eq(mergeConnections.id, mergeRepositories.connectionId))
    .where(and(eq(mergePullRequests.id, id), isNull(mergeRepositories.deletedAt), isNull(mergeConnections.deletedAt)))
    .limit(1);
  return row ?? null;
}

const repositoryRef = (r: MergeRepositoryRow): RepositoryRef => ({
  externalId: r.externalId,
  fullName: r.fullName,
  externalProject: r.externalProject,
  defaultBranch: r.defaultBranch,
});

/** GitHub mints its own installation token; the other providers act with the connection's stored one. */
async function readContext(db: Db, env: HookContext['env'], target: Target): Promise<AdapterContext | null> {
  const base: AdapterContext = { env, connection: target.connection };
  if (target.connection.provider === 'github') return base;
  const token = await getConnectionToken(db, env, target.connection);
  return token ? { ...base, memberToken: token.accessToken } : null;
}

type Operation = 'read' | 'write' | 'merge';

/** A merge a provider refuses on its merits: GitHub 405/409, GitLab 405/406/409, and the 409 the adapters raise. */
const NOT_MERGEABLE_STATUSES = new Set([405, 406, 409]);

function failureOf(err: unknown, operation: Operation): ReviewFailure {
  if (err instanceof ProviderUnsupportedError) return { code: 'unsupported', message: err.message };
  if (err instanceof ProviderApiError) {
    if (operation === 'merge' && NOT_MERGEABLE_STATUSES.has(err.status)) return { code: 'not_mergeable', message: err.message };
    return { code: 'provider_error', message: err.message };
  }
  if (err instanceof GithubApiError) return { code: 'provider_error', message: err.message };
  throw err;
}

async function guarded<T>(operation: Operation, work: () => Promise<ReviewResult<T>>): Promise<ReviewResult<T>> {
  try {
    return await work();
  } catch (err) {
    return fail(failureOf(err, operation));
  }
}

const NO_ACCOUNT = (provider: string): ReviewResult<never> =>
  fail({ code: 'account_not_linked', message: `Link your ${provider} account to do this from WeldMerge` });

/** The adapter context for a write as the member; null when they have no verified linked account. */
async function writeContext(db: Db, hooks: HookContext, target: Target): Promise<AdapterContext | null> {
  const token = await getMemberToken(db, hooks.env, hooks.userId, target.connection.provider, target.connection.host);
  return token ? { env: hooks.env, connection: target.connection, memberToken: token.accessToken } : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function readWith<T>(
  hooks: HookContext,
  id: string,
  read: (target: Target, ctx: AdapterContext) => Promise<T>,
): Promise<ReviewResult<T>> {
  const target = await loadTarget(hooks.db, id);
  if (!target) return fail({ code: 'not_found' });
  return guarded('read', async () => {
    const ctx = await readContext(hooks.db, hooks.env, target);
    if (!ctx) return fail({ code: 'provider_error', message: 'The connection has no stored credentials' });
    return done(await read(target, ctx));
  });
}

export function listPullRequestFiles(hooks: HookContext, id: string): Promise<ReviewResult<MergePullRequestFile[]>> {
  return readWith(hooks, id, (t, ctx) => reviewAdapterFor(t.connection.provider).listFiles(ctx, repositoryRef(t.repository), t.pr.number));
}

export function listPullRequestThreads(hooks: HookContext, id: string): Promise<ReviewResult<MergeReviewThread[]>> {
  return readWith(hooks, id, (t, ctx) => reviewAdapterFor(t.connection.provider).listThreads(ctx, repositoryRef(t.repository), t.pr.number));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Re-reads the pull request from the provider and mirrors it as a webhook would
 * (automations and hooks included). A provider that cannot answer leaves the
 * stored mirror as it is: the member's action already happened.
 */
async function refreshMirror(hooks: HookContext, target: Target): Promise<PendingEvent[]> {
  try {
    const ctx = await readContext(hooks.db, hooks.env, target);
    if (!ctx) return [];
    const fields = await adapterFor(target.connection.provider).getPullRequest(ctx, repositoryRef(target.repository), target.pr.number);
    if (!fields) return [];
    const outcome = await upsertMirror(hooks.db, target.repository, fields, { automate: true, hooks });
    return outcome.events;
  } catch (err) {
    console.error('[merge-api] refreshing the pull request mirror after a review action failed:', err);
    return [];
  }
}

/** The provider's review decision after a review, stored when it changed. */
async function refreshDecision(hooks: HookContext, target: Target): Promise<PendingEvent[]> {
  try {
    const ctx = await readContext(hooks.db, hooks.env, target);
    if (!ctx) return [];
    const decision = await adapterFor(target.connection.provider).reviewDecision(ctx, repositoryRef(target.repository), target.pr.number);
    if (!decision || decision === target.pr.reviewDecision) return [];
    const [row] = await hooks.db
      .update(mergePullRequests)
      .set({ reviewDecision: decision, syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(mergePullRequests.id, target.pr.id))
      .returning();
    if (!row) return [];
    const issues = await linkedIssuesByPullRequest(hooks.db, [row.id]);
    return [
      {
        entityType: 'merge_pull_request',
        action: 'updated',
        entityId: row.id,
        data: pullRequestEventData(row, (issues.get(row.id) ?? []).map((i) => i.id)),
        changes: { reviewDecision: { old: target.pr.reviewDecision, new: decision } },
      },
    ];
  } catch (err) {
    console.error('[merge-api] reading the review decision after a review failed:', err);
    return [];
  }
}

async function detailOf(hooks: HookContext, id: string): Promise<MergePullRequestDetailDto> {
  return (await getPullRequestDetail(hooks.db, id))!;
}

async function writeWith<T>(
  hooks: HookContext,
  id: string,
  operation: Operation,
  act: (target: Target, ctx: AdapterContext) => Promise<ReviewResult<T>>,
): Promise<ReviewResult<T>> {
  const target = await loadTarget(hooks.db, id);
  if (!target) return fail({ code: 'not_found' });
  const ctx = await writeContext(hooks.db, hooks, target);
  if (!ctx) return NO_ACCOUNT(target.connection.provider);
  return guarded(operation, () => act(target, ctx));
}

export function submitReview(
  hooks: HookContext,
  id: string,
  input: SubmitMergeReviewInput,
): Promise<ReviewResult<MergePullRequestDetailDto>> {
  return writeWith(hooks, id, 'write', async (target, ctx) => {
    await reviewAdapterFor(target.connection.provider).submitReview(ctx, repositoryRef(target.repository), target.pr.number, {
      event: input.event,
      body: input.body,
      comments: input.comments?.map((c) => ({ path: c.path, line: c.line, side: c.side ?? 'RIGHT', body: c.body })),
    });
    const events = [...(await refreshMirror(hooks, target)), ...(await refreshDecision(hooks, target))];
    return done(await detailOf(hooks, id), events);
  });
}

export function commentOnPullRequest(
  hooks: HookContext,
  id: string,
  input: CreateMergePullRequestCommentInput,
): Promise<ReviewResult<MergePullRequestCommentResult>> {
  return writeWith(hooks, id, 'write', async (target, ctx) => {
    const result = await reviewAdapterFor(target.connection.provider).comment(ctx, repositoryRef(target.repository), target.pr.number, {
      body: input.body,
      path: input.path,
      line: input.line,
      side: input.side,
      inReplyToId: input.inReplyToId,
    });
    return done(result);
  });
}

export function mergePullRequest(
  hooks: HookContext,
  id: string,
  input: MergeMergePullRequestInput,
): Promise<ReviewResult<MergePullRequestDetailDto>> {
  return writeWith(hooks, id, 'merge', async (target, ctx) => {
    if (target.pr.state !== 'open') {
      return fail({ code: 'not_mergeable', message: `This pull request is already ${target.pr.state}` });
    }
    await reviewAdapterFor(target.connection.provider).merge(ctx, repositoryRef(target.repository), target.pr.number, {
      method: input.method ?? 'merge',
      commitTitle: input.commitTitle,
      commitMessage: input.commitMessage,
    });
    const events = await refreshMirror(hooks, target);
    return done(await detailOf(hooks, id), events);
  });
}
