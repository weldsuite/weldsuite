/**
 * GitLab, Bitbucket and Azure DevOps event intake: what integration-webhook-worker
 * forwards after it resolved the workspace from the master provider index. Pure
 * of Hono: the internal route and the tests call it.
 *
 * The repository is found by the `webhook_key` in the URL, the delivery is
 * verified with the repository's own stored secret (`bad_signature` otherwise),
 * parsed by the provider's adapter into normalized events and applied through
 * the same code as GitHub's: `upsertMirror` for pull requests (with the
 * automation rules and area hooks), the review and checks columns, and the issue
 * sync engine for GitLab issues. A hook that says only "something changed"
 * (an approval, a build) is completed by a read from the provider.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { MergeReviewDecision } from '@weldsuite/db/schema';
import type { MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { MergeProviderEventEnvelope } from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import type { Env } from '../types';
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
import { afterPullRequestSynced, type HookContext } from './hooks';
import { applyInboundComment, applyInboundIssue, type InboundContext, type InboundResult } from './issue-sync/inbound';
import { ProviderCredentialsError } from './providers/errors';
import { adapterContextFor } from './providers/context';
import { adapterFor } from './providers/registry';
import {
  ProviderApiError,
  type AdapterContext,
  type ConnectionAdapter,
  type NormalizedWebhookEvent,
  type RepositoryRef,
} from './providers/types';
import { pullRequestEventData, upsertMirror } from './pr-sync';
import { linkedIssuesByPullRequest } from './pull-requests';
import { repositoryEventData, repositoryRef } from './repositories';
import { deleteWebhookIndex } from './webhook-index';
import { webhookSecretOf } from './webhook-registration';

export interface ProviderEventResult {
  outcome: 'applied' | 'ignored';
  /** Why the event was dropped (`unknown_repository`, `bad_signature`, `pr_sync_off`, `stale`, `unknown_pull_request`, …). */
  reason?: string;
  events: PendingEvent[];
}

const ignored = (reason: string): ProviderEventResult => ({ outcome: 'ignored', reason, events: [] });
const applied = (events: PendingEvent[]): ProviderEventResult => ({ outcome: 'applied', events });

/** What one delivery's events act on. */
interface Scope {
  db: Db;
  env: Env;
  repository: MergeRepositoryRow;
  connection: MergeConnectionRow;
  adapter: ConnectionAdapter;
  ref: RepositoryRef;
  hooks?: HookContext;
  context: () => Promise<AdapterContext>;
}

/** A provider answering badly, or a connection with no usable token: the delivery is kept, the re-read skipped. */
const isReadFailure = (err: unknown): boolean => err instanceof ProviderApiError || err instanceof ProviderCredentialsError;

async function findByWebhookKey(
  db: Db,
  provider: MergeProvider,
  key: string,
): Promise<{ repository: MergeRepositoryRow; connection: MergeConnectionRow } | null> {
  const [row] = await db
    .select({ repository: mergeRepositories, connection: mergeConnections })
    .from(mergeRepositories)
    .innerJoin(mergeConnections, eq(mergeConnections.id, mergeRepositories.connectionId))
    .where(
      and(
        eq(mergeRepositories.provider, provider),
        eq(mergeRepositories.webhookKey, key),
        isNull(mergeRepositories.deletedAt),
        isNull(mergeConnections.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Pull requests, reviews, checks
// ---------------------------------------------------------------------------

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

/** The pull request as the provider reads it now, or null when the read fails. */
async function readPullRequest(scope: Scope, number: number) {
  try {
    return await scope.adapter.getPullRequest(await scope.context(), scope.ref, number);
  } catch (err) {
    if (isReadFailure(err)) return null;
    throw err;
  }
}

async function pullRequestEvent(scope: Scope, event: Extract<NormalizedWebhookEvent, { kind: 'pull_request' }>): Promise<ProviderEventResult> {
  if (!scope.repository.prSync) return ignored('pr_sync_off');
  let fields = event.pullRequest;
  // GitLab's hook names the author by id only: complete the mirror from the provider.
  if (fields.authorLogin === null) fields = (await readPullRequest(scope, fields.number)) ?? fields;
  const outcome = await upsertMirror(scope.db, scope.repository, fields, { automate: true, hooks: scope.hooks });
  return outcome.status === 'stale' ? ignored('stale') : applied(outcome.events);
}

async function reviewEvent(scope: Scope, event: Extract<NormalizedWebhookEvent, { kind: 'review' }>): Promise<ProviderEventResult> {
  if (!scope.repository.prSync) return ignored('pr_sync_off');
  const pr = await pullRequestFor(scope.db, scope.repository, event.number);
  if (!pr) return ignored('unknown_pull_request');

  let decision: MergeReviewDecision | null = event.decision;
  if (decision === null) {
    try {
      decision = await scope.adapter.reviewDecision(await scope.context(), scope.ref, event.number);
    } catch (err) {
      if (isReadFailure(err)) return ignored('provider_unavailable');
      throw err;
    }
  }
  const [updated] = await scope.db
    .update(mergePullRequests)
    .set({ reviewDecision: decision, syncedAt: new Date(), updatedAt: new Date() })
    .where(eq(mergePullRequests.id, pr.id))
    .returning();
  const pending = await updateEvent(scope.db, updated!);
  pending.changes = { reviewDecision: { old: pr.reviewDecision, new: decision } };
  if (scope.hooks) await afterPullRequestSynced(scope.hooks, pr, updated!, [pending]);
  return applied([pending]);
}

/** Open pull requests a checks event is about: the ones whose head is that commit. */
async function trackedForChecks(scope: Scope, headSha: string, numbers: number[]): Promise<MergePullRequestRow[]> {
  const rows = await scope.db
    .select()
    .from(mergePullRequests)
    .where(
      and(
        eq(mergePullRequests.repositoryId, scope.repository.id),
        eq(mergePullRequests.headSha, headSha),
        eq(mergePullRequests.state, 'open'),
        numbers.length > 0 ? inArray(mergePullRequests.number, numbers) : undefined,
      ),
    );
  return rows;
}

async function checksEvent(scope: Scope, event: Extract<NormalizedWebhookEvent, { kind: 'checks' }>): Promise<ProviderEventResult> {
  if (!scope.repository.prSync) return ignored('pr_sync_off');
  const tracked = await trackedForChecks(scope, event.headSha, event.numbers);
  if (tracked.length === 0) return ignored('unknown_pull_request');

  const pending: PendingEvent[] = [];
  for (const pr of tracked) {
    let status = event.status;
    if (status === null) {
      try {
        status = await scope.adapter.checksStatus(await scope.context(), scope.ref, event.headSha, pr.number);
      } catch (err) {
        if (isReadFailure(err)) return ignored('provider_unavailable');
        throw err;
      }
    }
    const [updated] = await scope.db
      .update(mergePullRequests)
      .set({ checksStatus: status, syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(mergePullRequests.id, pr.id))
      .returning();
    const change = await updateEvent(scope.db, updated!);
    change.changes = { checksStatus: { old: pr.checksStatus, new: status } };
    pending.push(change);
    if (scope.hooks) await afterPullRequestSynced(scope.hooks, pr, updated!, [change]);
  }
  return applied(pending);
}

// ---------------------------------------------------------------------------
// Issues (GitLab)
// ---------------------------------------------------------------------------

const resultOf = (result: InboundResult): ProviderEventResult =>
  result.outcome === 'ignored' || result.outcome === 'unchanged'
    ? { outcome: 'ignored', reason: result.reason ?? result.outcome, events: result.events }
    : applied(result.events);

const inboundContext = (scope: Scope): InboundContext => ({
  db: scope.db,
  target: { repository: scope.repository, connection: scope.connection },
  userId: scope.hooks?.userId ?? 'system',
  hooks: scope.hooks,
});

const CREATING_ACTIONS = new Set(['opened', 'reopened']);

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function removeRepository(scope: Scope): Promise<ProviderEventResult> {
  const now = new Date();
  const [row] = await scope.db
    .update(mergeRepositories)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(mergeRepositories.id, scope.repository.id))
    .returning();
  if (scope.repository.webhookKey) {
    await deleteWebhookIndex(scope.env, scope.repository.provider, scope.repository.webhookKey).catch((err) => {
      console.error('[merge-api] could not remove a webhook from the master index:', err);
    });
  }
  return applied([{ entityType: 'merge_repository', action: 'deleted', entityId: row!.id, data: repositoryEventData(row!) }]);
}

function applyEvent(scope: Scope, event: NormalizedWebhookEvent): Promise<ProviderEventResult> {
  switch (event.kind) {
    case 'pull_request':
      return pullRequestEvent(scope, event);
    case 'review':
      return reviewEvent(scope, event);
    case 'checks':
      return checksEvent(scope, event);
    case 'issue':
      return scope.repository.provider === 'gitlab'
        ? applyInboundIssue(inboundContext(scope), event.issue, { create: CREATING_ACTIONS.has(event.action) }).then(resultOf)
        : Promise.resolve(ignored('issues_unsupported'));
    case 'issue_comment':
      return scope.repository.provider === 'gitlab'
        ? applyInboundComment(inboundContext(scope), event.action, event.comment).then(resultOf)
        : Promise.resolve(ignored('issues_unsupported'));
    case 'repository_removed':
      return removeRepository(scope);
  }
}

const sameRepository = (event: NormalizedWebhookEvent, repository: MergeRepositoryRow): boolean =>
  event.repositoryExternalId.toLowerCase() === repository.externalId.toLowerCase();

/** Verifies and applies one forwarded delivery. Never throws for a delivery it cannot use: it answers `ignored` with a reason. */
export async function handleProviderEvent(
  db: Db,
  env: Env,
  envelope: MergeProviderEventEnvelope,
  hooks?: HookContext,
): Promise<ProviderEventResult> {
  const found = await findByWebhookKey(db, envelope.provider, envelope.key);
  if (!found) return ignored('unknown_repository');
  const { repository, connection } = found;

  const adapter = adapterFor(envelope.provider);
  const secret = await webhookSecretOf(env, repository);
  if (!secret || !adapter.verifyWebhook || !adapter.parseWebhook) return ignored('bad_signature');
  if (!(await adapter.verifyWebhook(envelope.headers, envelope.body, secret))) return ignored('bad_signature');

  let body: unknown;
  try {
    body = JSON.parse(envelope.body);
  } catch {
    return ignored('invalid_body');
  }
  const events = adapter.parseWebhook(envelope.headers, body).filter((event) => sameRepository(event, repository));
  if (events.length === 0) return ignored('no_event');

  let cached: Promise<AdapterContext> | null = null;
  const scope: Scope = {
    db,
    env,
    repository,
    connection,
    adapter,
    ref: repositoryRef(repository),
    hooks,
    context: () => (cached ??= adapterContextFor(db, env, connection)),
  };

  const pending: PendingEvent[] = [];
  let firstReason: string | undefined;
  let anyApplied = false;
  for (const event of events) {
    const result = await applyEvent(scope, event);
    pending.push(...result.events);
    if (result.outcome === 'applied') anyApplied = true;
    else firstReason ??= result.reason;
  }
  return anyApplied ? applied(pending) : { outcome: 'ignored', reason: firstReason, events: pending };
}
