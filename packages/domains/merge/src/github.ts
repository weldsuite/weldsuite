/**
 * GitHub → WeldMerge mirror mapping. Pure functions over GitHub's REST and
 * webhook shapes; the HTTP calls live in merge-api (and rust/modules/merge).
 *
 * The same mapper serves the webhook body (`pull_request` event) and the REST
 * list (`GET /repos/{owner}/{repo}/pulls`). The list leaves out additions,
 * deletions and changed files, so those map to null and an upsert keeps the
 * stored numbers (`mergeMirrorUpdate`).
 */

import type {
  MergeChecksStatus,
  MergePullRequestLabel,
  MergePullRequestState,
  MergeRequestedReviewer,
  MergeReviewDecision,
} from '@weldsuite/db/schema';

export interface GithubUser {
  login: string;
  id?: number;
  avatar_url?: string | null;
}

export interface GithubPullRequest {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  user?: GithubUser | null;
  head?: { ref?: string | null; sha?: string | null } | null;
  base?: { ref?: string | null; repo?: { id: number; full_name: string } | null } | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  requested_reviewers?: GithubUser[] | null;
  requested_teams?: Array<{ slug: string; name?: string }> | null;
  labels?: Array<{ name: string; color?: string | null }> | null;
}

export interface MirrorFields {
  externalId: string;
  number: number;
  title: string;
  body: string | null;
  state: MergePullRequestState;
  draft: boolean;
  url: string;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  headRef: string | null;
  baseRef: string | null;
  headSha: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  requestedReviewers: MergeRequestedReviewer[];
  labels: MergePullRequestLabel[];
  providerCreatedAt: Date;
  providerUpdatedAt: Date;
  mergedAt: Date | null;
  closedAt: Date | null;
}

const date = (v: string | null | undefined): Date | null => (v ? new Date(v) : null);

const unmergedState = (pr: GithubPullRequest): MergePullRequestState => (pr.state === 'closed' ? 'closed' : 'open');

export function mapGithubPullRequest(pr: GithubPullRequest): MirrorFields {
  const merged = pr.merged === true || Boolean(pr.merged_at);
  const state: MergePullRequestState = merged ? 'merged' : unmergedState(pr);
  const reviewers: MergeRequestedReviewer[] = [
    ...(pr.requested_reviewers ?? []).map((u) => ({
      kind: 'user' as const,
      login: u.login.toLowerCase(),
      avatarUrl: u.avatar_url ?? null,
    })),
    ...(pr.requested_teams ?? []).map((t) => ({ kind: 'team' as const, login: t.slug })),
  ];
  return {
    externalId: String(pr.id),
    number: pr.number,
    title: pr.title,
    body: pr.body ?? null,
    state,
    draft: pr.draft === true,
    url: pr.html_url,
    authorLogin: pr.user?.login?.toLowerCase() ?? null,
    authorAvatarUrl: pr.user?.avatar_url ?? null,
    headRef: pr.head?.ref ?? null,
    baseRef: pr.base?.ref ?? null,
    headSha: pr.head?.sha ?? null,
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    changedFiles: pr.changed_files ?? null,
    requestedReviewers: reviewers,
    labels: (pr.labels ?? []).map((l) => ({ name: l.name, color: l.color ? `#${l.color.replace(/^#/, '')}` : null })),
    providerCreatedAt: new Date(pr.created_at),
    providerUpdatedAt: new Date(pr.updated_at),
    mergedAt: merged ? date(pr.merged_at) : null,
    closedAt: date(pr.closed_at),
  };
}

/**
 * Whether an incoming copy may overwrite the stored mirror: only when it is
 * not older. Equal timestamps are applied (a review or check event carries
 * the same `updated_at` as the pull request it changes).
 */
export function isNotOlder(incomingUpdatedAt: Date, storedUpdatedAt: Date | null | undefined): boolean {
  return !storedUpdatedAt || incomingUpdatedAt.getTime() >= storedUpdatedAt.getTime();
}

/** Fields for an update: keeps stored size numbers when the copy (a REST list row) doesn't carry them. */
export function mergeMirrorUpdate(
  fields: MirrorFields,
  stored: { additions: number | null; deletions: number | null; changedFiles: number | null } | null,
): MirrorFields {
  if (!stored) return fields;
  return {
    ...fields,
    additions: fields.additions ?? stored.additions,
    deletions: fields.deletions ?? stored.deletions,
    changedFiles: fields.changedFiles ?? stored.changedFiles,
  };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export interface GithubCheckSuite {
  status: 'queued' | 'in_progress' | 'completed' | 'requested' | 'waiting' | 'pending' | string;
  conclusion: string | null;
  app?: { slug?: string } | null;
  /** GitHub creates an empty suite for every installed app; it never runs. */
  latest_check_runs_count?: number;
}

/** One status for a commit's check suites: any failure wins, then anything still running. */
export function combineCheckSuites(suites: GithubCheckSuite[]): MergeChecksStatus | null {
  const real = suites.filter((s) => s.latest_check_runs_count === undefined || s.latest_check_runs_count > 0);
  if (real.length === 0) return null;
  let pending = false;
  let success = false;
  for (const suite of real) {
    if (suite.status !== 'completed' || suite.conclusion === null) {
      pending = true;
      continue;
    }
    switch (suite.conclusion) {
      case 'failure':
      case 'timed_out':
      case 'action_required':
      case 'startup_failure':
        return 'failure';
      case 'success':
        success = true;
        break;
      default:
        // neutral, skipped, cancelled, stale
        break;
    }
  }
  if (pending) return 'pending';
  return success ? 'success' : 'neutral';
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export interface GithubReview {
  user?: GithubUser | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING' | string;
  submitted_at?: string | null;
}

/**
 * The review decision GitHub's GraphQL API would report, from the REST review
 * list: each reviewer's latest approving, rejecting or dismissed review counts.
 * Changes requested by anyone wins; then any approval; then `review_required`
 * while reviewers are still requested. (Branch protection's required count is
 * not known here, so one approval counts as approved.)
 */
export function reviewDecisionFromReviews(
  reviews: GithubReview[],
  requestedReviewerCount: number,
): MergeReviewDecision | null {
  const latest = new Map<string, string>();
  const ordered = [...reviews].sort(
    (a, b) => new Date(a.submitted_at ?? 0).getTime() - new Date(b.submitted_at ?? 0).getTime(),
  );
  for (const review of ordered) {
    const login = review.user?.login?.toLowerCase();
    if (!login) continue;
    if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED' || review.state === 'DISMISSED') {
      latest.set(login, review.state);
    }
  }
  const states = [...latest.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (states.includes('APPROVED')) return 'approved';
  return requestedReviewerCount > 0 ? 'review_required' : null;
}
