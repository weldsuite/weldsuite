/**
 * How a linked pull request moves an issue (design/modules/weldmerge.md,
 * "A pull request changes on GitHub").
 *
 * Rules run only when something changed for the link: the pull request moved
 * to another phase, or the link is new. A member who moves an issue back while
 * the pull request stays open is not overridden by the next push.
 *
 * - draft opened                → `in_progress` from `backlog` or `todo`
 * - ready for review            → `in_review` from `backlog`, `todo` or `in_progress`
 * - merged, and the link closes → `done`
 * - closed without merging      → no change
 *
 * An issue in `done` or `canceled` never moves. The Rust twin is
 * rust/modules/merge/src/automation.rs.
 */

import type { MergeIssueStatus, MergePullRequestState } from '@weldsuite/db/schema';

export type PullRequestPhase = 'draft' | 'ready' | 'merged' | 'closed';

export function pullRequestPhase(pr: { state: MergePullRequestState; draft: boolean }): PullRequestPhase {
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed';
  return pr.draft ? 'draft' : 'ready';
}

/** Whether the rules should run for one link after a sync. */
export function shouldEvaluateLink(previous: PullRequestPhase | null, next: PullRequestPhase, linkIsNew: boolean): boolean {
  return linkIsNew || previous !== next;
}

const RANK: Record<MergeIssueStatus, number> = {
  backlog: 0,
  todo: 1,
  in_progress: 2,
  in_review: 3,
  done: 4,
  canceled: 4,
};

/** The status the issue moves to, or null to leave it. */
export function issueStatusForPullRequest(
  current: MergeIssueStatus,
  phase: PullRequestPhase,
  closes: boolean,
): MergeIssueStatus | null {
  if (current === 'done' || current === 'canceled') return null;
  switch (phase) {
    case 'draft':
      return RANK[current] < RANK.in_progress ? 'in_progress' : null;
    case 'ready':
      return RANK[current] < RANK.in_review ? 'in_review' : null;
    case 'merged':
      return closes ? 'done' : null;
    case 'closed':
      return null;
  }
}

export interface IssueStatusTimestamps {
  startedAt: Date | null;
  completedAt: Date | null;
  canceledAt: Date | null;
}

/**
 * Timestamps after a status change, for manual and automatic moves alike:
 * `started_at` is set the first time work starts and kept; `completed_at` and
 * `canceled_at` hold only while the issue is in that status.
 */
export function statusTimestamps(
  next: MergeIssueStatus,
  existing: IssueStatusTimestamps,
  now: Date,
): IssueStatusTimestamps {
  const started = RANK[next] >= RANK.in_progress && next !== 'canceled';
  return {
    startedAt: existing.startedAt ?? (started ? now : null),
    completedAt: next === 'done' ? (existing.completedAt ?? now) : null,
    canceledAt: next === 'canceled' ? (existing.canceledAt ?? now) : null,
  };
}

/** Whether a status counts as open (lists, counts, cycle progress). */
export function isOpenIssueStatus(status: MergeIssueStatus): boolean {
  return status !== 'done' && status !== 'canceled';
}
