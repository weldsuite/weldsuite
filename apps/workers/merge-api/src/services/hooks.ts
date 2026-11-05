/**
 * Hook points: what happens in other WeldSuite surfaces when a WeldMerge row
 * changes. Services and routes call these after the write; each fans out to the
 * area-owned modules:
 *
 *   issue-sync/hooks.ts  (area A) pushes issue and comment changes to GitHub / GitLab
 *   chat/hooks.ts        (area D) posts to subscribed WeldChat channels
 *
 * Both start as no-ops. A hook runs inside the request or webhook that caused
 * it (so conformance sees its outbound calls) and must never fail the write
 * that triggered it: a throwing area is logged and the caller carries on.
 *
 * No executionCtx in here: the context carries plain values, so the same hooks
 * serve routes, the `MergeInternal` entrypoint and tests.
 */

import type { Env } from '../types';
import type { MergeReleaseShippedEventData } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import * as chat from './chat/hooks';
import type { Db, MergeCommentRow, MergeIssueRow, MergePullRequestRow, MergeReleaseRow } from './db';
import type { PendingEvent } from './events';
import * as issueSync from './issue-sync/hooks';

/** What a hook needs to act: the tenant DB, the worker env, and who/where the change happened. */
export interface HookContext {
  db: Db;
  env: Env;
  /** The member who made the change; `system` for sync and automation. */
  userId: string;
  /** `workspaces.id` (ws_…). */
  workspaceId: string;
  /** The Clerk org id, for the stores still keyed by it. */
  clerkOrgId: string;
}

export type CommentChange = 'created' | 'updated' | 'deleted';

async function run(name: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error(`[merge-api] hook ${name} failed:`, err);
  }
}

export async function afterIssueCreated(ctx: HookContext, issue: MergeIssueRow, teamKey: string): Promise<void> {
  await run('issueSync.afterIssueCreated', () => issueSync.afterIssueCreated(ctx, issue, teamKey));
  await run('chat.afterIssueCreated', () => chat.afterIssueCreated(ctx, issue, teamKey));
}

/** `before` and `after` are the rows around the change (a member's edit, or a pull request moving the issue). */
export async function afterIssueUpdated(
  ctx: HookContext,
  before: MergeIssueRow,
  after: MergeIssueRow,
  teamKey: string,
): Promise<void> {
  await run('issueSync.afterIssueUpdated', () => issueSync.afterIssueUpdated(ctx, before, after, teamKey));
  await run('chat.afterIssueUpdated', () => chat.afterIssueUpdated(ctx, before, after, teamKey));
}

export async function afterCommentChanged(
  ctx: HookContext,
  change: CommentChange,
  comment: MergeCommentRow,
  issue: MergeIssueRow,
  teamKey: string,
): Promise<void> {
  await run('issueSync.afterCommentChanged', () => issueSync.afterCommentChanged(ctx, change, comment, issue, teamKey));
}

/**
 * After sync wrote a pull request (a webhook, never a backfill). `before` is
 * null for a new pull request; `events` are the entity events the write produced.
 */
export async function afterPullRequestSynced(
  ctx: HookContext,
  before: MergePullRequestRow | null,
  after: MergePullRequestRow,
  events: PendingEvent[],
): Promise<void> {
  await run('chat.afterPullRequestSynced', () => chat.afterPullRequestSynced(ctx, before, after, events));
}

/** After a release is shipped; `shipped` is the payload of the `merge_release.shipped` event. */
export async function afterReleaseShipped(
  ctx: HookContext,
  release: MergeReleaseRow,
  shipped: MergeReleaseShippedEventData,
): Promise<void> {
  await run('chat.afterReleaseShipped', () => chat.afterReleaseShipped(ctx, release, shipped));
}
