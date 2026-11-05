/**
 * Issue sync entry points (area A). Foundation stubs: every function is a
 * no-op until the sync engine is built. Called from `../hooks.ts` and from
 * `../github-events.ts`; keep the signatures.
 *
 * Push (WeldMerge to provider) runs for repositories whose `issue_sync` is
 * `two_way`, inside the request, and stores the new
 * `merge_external_issues.checksum` before the webhook echo arrives. Intake
 * (provider to WeldMerge) is `handleGithubIssueSyncEvent`, for `import` and
 * `two_way`.
 */

import type { MergeGithubEventEnvelope } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { Db, MergeCommentRow, MergeIssueRow } from '../db';
import type { GithubEventResult } from '../github-events';
import type { CommentChange, HookContext } from '../hooks';

export async function afterIssueCreated(_ctx: HookContext, _issue: MergeIssueRow, _teamKey: string): Promise<void> {}

export async function afterIssueUpdated(
  _ctx: HookContext,
  _before: MergeIssueRow,
  _after: MergeIssueRow,
  _teamKey: string,
): Promise<void> {}

export async function afterCommentChanged(
  _ctx: HookContext,
  _change: CommentChange,
  _comment: MergeCommentRow,
  _issue: MergeIssueRow,
  _teamKey: string,
): Promise<void> {}

/** GitHub `issues`, `issue_comment` and `installation` events (integration-webhook-worker forwards them). */
export async function handleGithubIssueSyncEvent(
  _db: Db,
  _envelope: MergeGithubEventEnvelope,
  _hooks?: HookContext,
): Promise<GithubEventResult> {
  return { outcome: 'ignored', reason: 'not_implemented', events: [] };
}
