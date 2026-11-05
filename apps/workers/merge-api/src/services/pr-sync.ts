/**
 * The pull request mirror: one function every sync path uses (a webhook, adding
 * a repository, Refresh). It upserts the row, finds issue keys, creates the
 * `auto` links and, when asked, runs the automation rules. The rules
 * themselves are in @weldsuite/merge-domain.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import type { MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import { findIssueKeyMentions } from '@weldsuite/merge-domain/keys';
import {
  issueStatusForPullRequest,
  pullRequestPhase,
  shouldEvaluateLink,
  type PullRequestPhase,
} from '@weldsuite/merge-domain/automation';
import {
  isNotOlder,
  mapGithubPullRequest,
  mergeMirrorUpdate,
  type GithubPullRequest,
  type MirrorFields,
} from '@weldsuite/merge-domain/github';
import {
  mergeIssuePullRequests,
  mergeIssues,
  mergeProviderAccounts,
  mergePullRequests,
  mergeTeams,
  type Db,
  type MergeIssuePullRequestRow,
  type MergeIssueRow,
  type MergePullRequestRow,
  type MergeRepositoryRow,
} from './db';
import type { PendingEvent } from './events';
import { afterIssueUpdated, afterPullRequestSynced, type HookContext } from './hooks';
import { moveIssueStatus } from './issues';
import { issueEventData } from './mappers';

export interface LinkedIssue {
  linkId: string;
  closes: boolean;
  source: 'auto' | 'manual';
  isNew: boolean;
  issue: MergeIssueRow;
  teamKey: string;
}

/** Links for a pull request: the existing ones, plus new `auto` links for the issue keys it mentions. */
export async function syncAutoLinks(db: Db, pr: MergePullRequestRow): Promise<{ links: LinkedIssue[]; created: number }> {
  const mentions = findIssueKeyMentions({ headRef: pr.headRef, title: pr.title, body: pr.body });

  const existingRows = await db
    .select()
    .from(mergeIssuePullRequests)
    .where(eq(mergeIssuePullRequests.pullRequestId, pr.id));
  const byIssue = new Map(existingRows.map((l) => [l.issueId, l]));
  const newlyCreated = new Set<string>();

  if (mentions.length > 0) {
    const candidates = await db
      .select({ issue: mergeIssues, teamKey: mergeTeams.key })
      .from(mergeIssues)
      .innerJoin(mergeTeams, eq(mergeTeams.id, mergeIssues.teamId))
      .where(
        and(
          inArray(mergeTeams.key, [...new Set(mentions.map((m) => m.teamKey))]),
          inArray(mergeIssues.number, [...new Set(mentions.map((m) => m.number))]),
          isNull(mergeTeams.deletedAt),
          isNull(mergeIssues.deletedAt),
        ),
      );
    for (const mention of mentions) {
      const hit = candidates.find((c) => c.teamKey === mention.teamKey && c.issue.number === mention.number);
      if (!hit) continue;
      await applyMention(db, pr, hit.issue.id, mention.closes, byIssue, newlyCreated);
    }
  }

  const links = await loadLinks(db, pr.id, newlyCreated);
  return { links, created: newlyCreated.size };
}

/** One issue key the pull request mentions: a new `auto` link, or the existing one's `closes` brought up to date. */
async function applyMention(
  db: Db,
  pr: MergePullRequestRow,
  issueId: string,
  closes: boolean,
  byIssue: Map<string, MergeIssuePullRequestRow>,
  newlyCreated: Set<string>,
): Promise<void> {
  const existing = byIssue.get(issueId);
  // A removed automatic link stays removed: the pair is not linked again.
  if (existing?.dismissedAt) return;
  if (existing) {
    if (existing.source !== 'auto' || existing.closes === closes) return;
    const [updated] = await db
      .update(mergeIssuePullRequests)
      .set({ closes })
      .where(eq(mergeIssuePullRequests.id, existing.id))
      .returning();
    byIssue.set(issueId, updated!);
    return;
  }
  const [inserted] = await db
    .insert(mergeIssuePullRequests)
    .values({ id: generateId('mip'), issueId, pullRequestId: pr.id, source: 'auto', closes })
    .onConflictDoNothing()
    .returning();
  if (inserted) {
    byIssue.set(issueId, inserted);
    newlyCreated.add(inserted.id);
  }
}

async function loadLinks(db: Db, pullRequestId: string, newIds: ReadonlySet<string>): Promise<LinkedIssue[]> {
  const rows = await db
    .select({ link: mergeIssuePullRequests, issue: mergeIssues, teamKey: mergeTeams.key })
    .from(mergeIssuePullRequests)
    .innerJoin(mergeIssues, eq(mergeIssues.id, mergeIssuePullRequests.issueId))
    .innerJoin(mergeTeams, eq(mergeTeams.id, mergeIssues.teamId))
    .where(
      and(
        eq(mergeIssuePullRequests.pullRequestId, pullRequestId),
        isNull(mergeIssuePullRequests.dismissedAt),
        isNull(mergeIssues.deletedAt),
      ),
    );
  return rows.map((r) => ({
    linkId: r.link.id,
    closes: r.link.closes,
    source: r.link.source,
    isNew: newIds.has(r.link.id),
    issue: r.issue,
    teamKey: r.teamKey,
  }));
}

/** Applies the automation rules to linked issues; returns the issue events (by the system actor). */
export async function runAutomation(
  db: Db,
  pr: MergePullRequestRow,
  previous: PullRequestPhase | null,
  links: LinkedIssue[],
  /** Set by webhook-driven syncs: lets the issue sync push the status the pull request moved the issue to. */
  hooks?: HookContext,
): Promise<PendingEvent[]> {
  const next = pullRequestPhase(pr);
  const events: PendingEvent[] = [];
  for (const link of links) {
    if (!shouldEvaluateLink(previous, next, link.isNew)) continue;
    const target = issueStatusForPullRequest(link.issue.status, next, link.closes);
    if (!target) continue;
    const moved = await moveIssueStatus(db, link.issue, target);
    events.push({
      entityType: 'merge_issue',
      action: 'updated',
      entityId: moved.id,
      data: issueEventData(moved, link.teamKey, pr.id),
      changes: { status: { old: link.issue.status, new: moved.status } },
    });
    if (hooks) await afterIssueUpdated(hooks, link.issue, moved, link.teamKey);
    link.issue = moved;
  }
  return events;
}

export function pullRequestEventData(pr: MergePullRequestRow, issueIds: string[]) {
  return {
    id: pr.id,
    repositoryId: pr.repositoryId,
    provider: pr.provider,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft,
    url: pr.url,
    authorLogin: pr.authorLogin,
    issueIds,
  };
}

/** The `merge_pull_request` events for a write: created or updated, plus merged or closed when the phase turned that way. */
export function pullRequestEvents(
  pr: MergePullRequestRow,
  previous: PullRequestPhase | null,
  issueIds: string[],
  changes?: PendingEvent['changes'],
  /** Publish `merged` and `closed` too: false for a backfill, which reads history rather than news. */
  transitions = true,
): PendingEvent[] {
  const data = pullRequestEventData(pr, issueIds);
  const events: PendingEvent[] = [
    { entityType: 'merge_pull_request', action: previous === null ? 'created' : 'updated', entityId: pr.id, data, changes },
  ];
  const next = pullRequestPhase(pr);
  if (!transitions) return events;
  if (next === 'merged' && previous !== 'merged') {
    events.push({ entityType: 'merge_pull_request', action: 'merged', entityId: pr.id, data });
  } else if (next === 'closed' && previous !== 'closed') {
    events.push({ entityType: 'merge_pull_request', action: 'closed', entityId: pr.id, data });
  }
  return events;
}

export interface UpsertOptions {
  /** Run the automation rules (false for a backfill: loading history must not move issues). */
  automate: boolean;
  /** Skip the row write when the stored copy has the same `updated_at` and state (a backfill re-reading rows). */
  skipUnchanged?: boolean;
  /** Webhook-driven syncs pass it: the area hooks (issue sync, chat posts) run after the write. A backfill leaves it out. */
  hooks?: HookContext;
}

export interface UpsertOutcome {
  status: 'created' | 'updated' | 'unchanged' | 'stale';
  pullRequest: MergePullRequestRow | null;
  linksCreated: number;
  events: PendingEvent[];
}

/** Member columns of a pull request, from the logins members entered. */
async function matchMembers(db: Db, provider: MergeProvider, logins: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(logins.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ login: mergeProviderAccounts.login, userId: mergeProviderAccounts.userId })
    .from(mergeProviderAccounts)
    .where(and(eq(mergeProviderAccounts.provider, provider), inArray(mergeProviderAccounts.login, unique)));
  return new Map(rows.map((r) => [r.login, r.userId]));
}

type Reviewers = MergePullRequestRow['requestedReviewers'];

async function updateMirror(
  db: Db,
  existing: MergePullRequestRow,
  fields: MirrorFields,
  authorUserId: string | null,
  reviewers: Reviewers,
  now: Date,
): Promise<MergePullRequestRow> {
  const merged = mergeMirrorUpdate(fields, existing);
  const [updated] = await db
    .update(mergePullRequests)
    .set({
      title: merged.title,
      body: merged.body,
      state: merged.state,
      draft: merged.draft,
      url: merged.url,
      authorLogin: merged.authorLogin,
      authorAvatarUrl: merged.authorAvatarUrl,
      authorUserId,
      headRef: merged.headRef,
      baseRef: merged.baseRef,
      headSha: merged.headSha,
      additions: merged.additions,
      deletions: merged.deletions,
      changedFiles: merged.changedFiles,
      // A new head commit starts new checks; reviews carry over until the next review event.
      checksStatus: merged.headSha !== existing.headSha ? null : existing.checksStatus,
      requestedReviewers: reviewers,
      labels: merged.labels,
      providerCreatedAt: merged.providerCreatedAt,
      providerUpdatedAt: merged.providerUpdatedAt,
      mergedAt: merged.mergedAt,
      closedAt: merged.closedAt,
      syncedAt: now,
      updatedAt: now,
    })
    .where(eq(mergePullRequests.id, existing.id))
    .returning();
  return updated!;
}

async function insertMirror(
  db: Db,
  repository: MergeRepositoryRow,
  fields: MirrorFields,
  authorUserId: string | null,
  reviewers: Reviewers,
  now: Date,
): Promise<MergePullRequestRow> {
  const [inserted] = await db
    .insert(mergePullRequests)
    .values({
      id: generateId('mpr'),
      repositoryId: repository.id,
      provider: repository.provider,
      externalId: fields.externalId,
      number: fields.number,
      title: fields.title,
      body: fields.body,
      state: fields.state,
      draft: fields.draft,
      url: fields.url,
      authorLogin: fields.authorLogin,
      authorAvatarUrl: fields.authorAvatarUrl,
      authorUserId,
      headRef: fields.headRef,
      baseRef: fields.baseRef,
      headSha: fields.headSha,
      additions: fields.additions,
      deletions: fields.deletions,
      changedFiles: fields.changedFiles,
      requestedReviewers: reviewers,
      labels: fields.labels,
      providerCreatedAt: fields.providerCreatedAt,
      providerUpdatedAt: fields.providerUpdatedAt,
      mergedAt: fields.mergedAt,
      closedAt: fields.closedAt,
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return inserted!;
}

/** Matches the author and reviewers to members, then updates the stored mirror or inserts a new one. */
async function writeMirror(
  db: Db,
  repository: MergeRepositoryRow,
  fields: MirrorFields,
  existing: MergePullRequestRow | undefined,
): Promise<MergePullRequestRow> {
  const members = await matchMembers(db, repository.provider, [
    fields.authorLogin ?? '',
    ...fields.requestedReviewers.filter((r) => r.kind === 'user').map((r) => r.login),
  ]);
  const reviewers = fields.requestedReviewers.map((r) =>
    r.kind === 'user' ? { ...r, userId: members.get(r.login) ?? null } : r,
  );
  const authorUserId = fields.authorLogin ? (members.get(fields.authorLogin) ?? null) : null;
  const now = new Date();
  if (existing) return updateMirror(db, existing, fields, authorUserId, reviewers, now);
  return insertMirror(db, repository, fields, authorUserId, reviewers, now);
}

function upsertStatus(unchanged: boolean, existing: MergePullRequestRow | undefined): UpsertOutcome['status'] {
  if (unchanged) return 'unchanged';
  return existing ? 'updated' : 'created';
}

/** A GitHub pull request payload: mapped, then mirrored. */
export function upsertPullRequest(
  db: Db,
  repository: MergeRepositoryRow,
  github: GithubPullRequest,
  options: UpsertOptions,
): Promise<UpsertOutcome> {
  return upsertMirror(db, repository, mapGithubPullRequest(github), options);
}

/** Mirrors a pull request already mapped to `MirrorFields` (every provider's mapper ends here). */
export async function upsertMirror(
  db: Db,
  repository: MergeRepositoryRow,
  fields: MirrorFields,
  options: UpsertOptions,
): Promise<UpsertOutcome> {
  const [existing] = await db
    .select()
    .from(mergePullRequests)
    .where(and(eq(mergePullRequests.repositoryId, repository.id), eq(mergePullRequests.number, fields.number)))
    .limit(1);

  if (existing && !isNotOlder(fields.providerUpdatedAt, existing.providerUpdatedAt)) {
    return { status: 'stale', pullRequest: existing, linksCreated: 0, events: [] };
  }

  const unchanged =
    options.skipUnchanged === true &&
    existing !== undefined &&
    existing.providerUpdatedAt.getTime() === fields.providerUpdatedAt.getTime() &&
    existing.state === fields.state;

  let row: MergePullRequestRow;
  const previous: PullRequestPhase | null = existing ? pullRequestPhase(existing) : null;
  if (unchanged) {
    row = existing!;
  } else {
    row = await writeMirror(db, repository, fields, existing);
  }

  const { links, created } = await syncAutoLinks(db, row);
  const events: PendingEvent[] = [];
  if (options.automate) events.push(...(await runAutomation(db, row, previous, links, options.hooks)));
  if (!unchanged) {
    events.unshift(
      ...pullRequestEvents(
        row,
        previous,
        links.map((l) => l.issue.id),
        existing && existing.state !== row.state ? { state: { old: existing.state, new: row.state } } : null,
        options.automate,
      ),
    );
  }
  if (options.hooks && !unchanged) await afterPullRequestSynced(options.hooks, existing ?? null, row, events);
  return {
    status: upsertStatus(unchanged, existing),
    pullRequest: row,
    linksCreated: created,
    events,
  };
}
