/**
 * WeldChat posting: what a subscribed channel hears when something happens in
 * WeldMerge. Called from `../hooks.ts` (which never lets a failure here fail
 * the write that caused it).
 *
 * Posts go through `postSystemChatMessage` (`@weldsuite/chat-domain`, author
 * `app:weldmerge`) with `metadata.weldmerge`, inside the request or webhook
 * that caused them; the channels are the subscriptions matching the event's
 * team and repository (`./subscriptions`). The daily digest is `runDigestSweep`
 * (src/cron/digest-sweep.ts).
 */

import { eq } from 'drizzle-orm';
import type { MergeReleaseShippedEventData } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import { mergeRepositories, type MergeIssueRow, type MergePullRequestRow, type MergeReleaseRow } from '../db';
import type { PendingEvent } from '../events';
import type { HookContext } from '../hooks';
import { postCardToChannels } from './post';
import { channelsFor } from './subscriptions';

export async function afterIssueCreated(ctx: HookContext, issue: MergeIssueRow, teamKey: string): Promise<void> {
  const channels = await channelsFor(ctx.db, 'issue_created', { teamId: issue.teamId, repositoryId: null });
  if (channels.length === 0) return;
  await postCardToChannels(ctx, channels, `Issue ${teamKey}-${issue.number} created: ${issue.title}`, {
    kind: 'issue_created',
    issueId: issue.id,
  });
}

/** `issue_done` when the status turned done. */
export async function afterIssueUpdated(
  ctx: HookContext,
  before: MergeIssueRow,
  after: MergeIssueRow,
  teamKey: string,
): Promise<void> {
  if (before.status === 'done' || after.status !== 'done') return;
  const channels = await channelsFor(ctx.db, 'issue_done', { teamId: after.teamId, repositoryId: null });
  if (channels.length === 0) return;
  await postCardToChannels(ctx, channels, `Issue ${teamKey}-${after.number} is done: ${after.title}`, {
    kind: 'issue_done',
    issueId: after.id,
  });
}

/** The logins of the user reviewers a pull request asks for. */
function reviewerLogins(pr: MergePullRequestRow | null): string[] {
  return (pr?.requestedReviewers ?? []).filter((r) => r.kind === 'user').map((r) => r.login);
}

/** Reviewers asked since the last copy (all of them once a draft turns ready), for an open, non-draft pull request. */
function newReviewers(before: MergePullRequestRow | null, after: MergePullRequestRow): string[] {
  if (after.state !== 'open' || after.draft) return [];
  const known = before && !before.draft ? new Set(reviewerLogins(before)) : new Set<string>();
  return reviewerLogins(after).filter((login) => !known.has(login));
}

const mergedNow = (events: PendingEvent[]) =>
  events.some((e) => e.entityType === 'merge_pull_request' && e.action === 'merged');

/** `review_requested`, `checks_failed`, `pull_request_merged`. */
export async function afterPullRequestSynced(
  ctx: HookContext,
  before: MergePullRequestRow | null,
  after: MergePullRequestRow,
  events: PendingEvent[],
): Promise<void> {
  const reviewers = newReviewers(before, after);
  const checksFailed = after.state === 'open' && after.checksStatus === 'failure' && before?.checksStatus !== 'failure';
  const merged = mergedNow(events);
  if (reviewers.length === 0 && !checksFailed && !merged) return;

  const [repository] = await ctx.db.select().from(mergeRepositories).where(eq(mergeRepositories.id, after.repositoryId)).limit(1);
  const scope = { teamId: repository?.teamId ?? null, repositoryId: after.repositoryId };
  const label = `${repository?.fullName ?? 'pull request'}#${after.number}`;

  if (reviewers.length > 0) {
    await postCardToChannels(
      ctx,
      await channelsFor(ctx.db, 'review_requested', scope),
      `Review requested from ${reviewers.join(', ')} on ${label}: ${after.title}\n${after.url}`,
      { kind: 'review_requested', pullRequestId: after.id, itemKey: `review_requested:${after.id}` },
    );
  }
  if (checksFailed) {
    await postCardToChannels(ctx, await channelsFor(ctx.db, 'checks_failed', scope), `Checks failed on ${label}: ${after.title}\n${after.url}`, {
      kind: 'checks_failed',
      pullRequestId: after.id,
      itemKey: `checks_failed:${after.id}`,
    });
  }
  if (merged) {
    await postCardToChannels(ctx, await channelsFor(ctx.db, 'pull_request_merged', scope), `Merged ${label}: ${after.title}\n${after.url}`, {
      kind: 'pull_request_merged',
      pullRequestId: after.id,
    });
  }
}

export async function afterReleaseShipped(
  ctx: HookContext,
  release: MergeReleaseRow,
  shipped: MergeReleaseShippedEventData,
): Promise<void> {
  const channels = await channelsFor(ctx.db, 'release_shipped', { teamId: release.teamId, repositoryId: release.repositoryId });
  if (channels.length === 0) return;
  const title = release.version ? `${release.name} ${release.version}` : release.name;
  const count = shipped.pullRequestIds.length;
  await postCardToChannels(ctx, channels, `Shipped ${title}: ${count} pull request${count === 1 ? '' : 's'}`, {
    kind: 'release_shipped',
    releaseId: release.id,
  });
}
