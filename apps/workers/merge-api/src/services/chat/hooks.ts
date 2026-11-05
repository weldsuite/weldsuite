/**
 * WeldChat posting (area D). Foundation stubs: every function is a no-op until
 * chat subscriptions are built. Called from `../hooks.ts`; keep the signatures.
 *
 * Posts go through `postSystemChatMessage` (`@weldsuite/chat-domain`, author
 * `app:weldmerge`) with `metadata.weldmerge`, inside the request or webhook
 * that caused them. The daily digest is `runDigestSweep` (src/cron/digest-sweep.ts).
 */

import type { MergeReleaseShippedEventData } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import type { MergeIssueRow, MergePullRequestRow, MergeReleaseRow } from '../db';
import type { PendingEvent } from '../events';
import type { HookContext } from '../hooks';

export async function afterIssueCreated(_ctx: HookContext, _issue: MergeIssueRow, _teamKey: string): Promise<void> {}

/** `issue_done` when the status turned done. */
export async function afterIssueUpdated(
  _ctx: HookContext,
  _before: MergeIssueRow,
  _after: MergeIssueRow,
  _teamKey: string,
): Promise<void> {}

/** `review_requested`, `checks_failed`, `pull_request_merged`. */
export async function afterPullRequestSynced(
  _ctx: HookContext,
  _before: MergePullRequestRow | null,
  _after: MergePullRequestRow,
  _events: PendingEvent[],
): Promise<void> {}

export async function afterReleaseShipped(
  _ctx: HookContext,
  _release: MergeReleaseRow,
  _shipped: MergeReleaseShippedEventData,
): Promise<void> {}
