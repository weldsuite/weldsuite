/**
 * Bitbucket Cloud payload mappers: pure functions from the 2.0 REST and
 * webhook shapes to `MirrorFields`, plus the review and check rules and the
 * `X-Hub-Signature` check. No I/O, no Hono, no database.
 *
 * Bitbucket identifies a person by `nickname` (their handle) in every payload;
 * the login WeldMerge stores is that nickname, lower-case, falling back to the
 * account id when a payload has none.
 */

import type {
  MergeChecksStatus,
  MergePullRequestState,
  MergeRequestedReviewer,
  MergeReviewDecision,
} from '@weldsuite/db/schema';
import {
  constantTimeEqual,
  header,
  hmacSha256Hex,
  idString,
  lowerLogin,
  obj,
  parseProviderDate,
  str,
  type Json,
  type MirrorFields,
  type NormalizedWebhookEvent,
} from './shared';

export interface BitbucketUser {
  uuid?: string;
  nickname?: string | null;
  username?: string | null;
  account_id?: string | null;
  display_name?: string | null;
  links?: { avatar?: { href?: string | null } | null } | null;
}

export interface BitbucketParticipant {
  user?: BitbucketUser | null;
  role?: 'PARTICIPANT' | 'REVIEWER' | string;
  approved?: boolean;
  state?: 'approved' | 'changes_requested' | null | string;
}

export interface BitbucketPullRequest {
  id: number;
  title: string;
  description?: string | null;
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED' | string;
  draft?: boolean;
  created_on: string;
  updated_on: string;
  author?: BitbucketUser | null;
  source?: { branch?: { name?: string | null } | null; commit?: { hash?: string | null } | null } | null;
  destination?: { branch?: { name?: string | null } | null } | null;
  links?: { html?: { href?: string | null } | null } | null;
  reviewers?: BitbucketUser[] | null;
  participants?: BitbucketParticipant[] | null;
}

export interface BitbucketCommitStatus {
  state: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS' | 'STOPPED' | string;
}

/** The handle WeldMerge stores as the login. */
export function bitbucketLogin(user: BitbucketUser | null | undefined): string | null {
  return lowerLogin(user?.nickname) ?? lowerLogin(user?.username) ?? lowerLogin(user?.account_id);
}

const avatarOf = (user: BitbucketUser | null | undefined): string | null => user?.links?.avatar?.href ?? null;

function mergeRequestState(state: string): MergePullRequestState {
  if (state === 'MERGED') return 'merged';
  if (state === 'OPEN') return 'open';
  return 'closed';
}

/** Reviewers who have not yet voted (a vote removes the request, as on GitHub). */
function pendingReviewers(pr: BitbucketPullRequest): MergeRequestedReviewer[] {
  const voted = new Set(
    (pr.participants ?? [])
      .filter((p) => p.approved === true || p.state === 'approved' || p.state === 'changes_requested')
      .map((p) => bitbucketLogin(p.user))
      .filter((login): login is string => login !== null),
  );
  return (pr.reviewers ?? []).flatMap((user) => {
    const login = bitbucketLogin(user);
    if (!login || voted.has(login)) return [];
    return [{ kind: 'user' as const, login, avatarUrl: avatarOf(user) }];
  });
}

/**
 * A pull request from REST or a webhook. Bitbucket has no merged/closed
 * timestamps, so `updated_on` stands in for both. Size numbers are left null
 * (the diffstat is a separate call WeldMerge does not make).
 */
export function mapBitbucketPullRequest(pr: BitbucketPullRequest): MirrorFields {
  const state = mergeRequestState(pr.state);
  const updatedAt = parseProviderDate(pr.updated_on);
  return {
    externalId: String(pr.id),
    number: pr.id,
    title: pr.title,
    body: str(pr.description),
    state,
    draft: pr.draft === true,
    url: pr.links?.html?.href ?? '',
    authorLogin: bitbucketLogin(pr.author),
    authorAvatarUrl: avatarOf(pr.author),
    headRef: pr.source?.branch?.name ?? null,
    baseRef: pr.destination?.branch?.name ?? null,
    headSha: pr.source?.commit?.hash ?? null,
    additions: null,
    deletions: null,
    changedFiles: null,
    requestedReviewers: pendingReviewers(pr),
    labels: [],
    providerCreatedAt: parseProviderDate(pr.created_on),
    providerUpdatedAt: updatedAt,
    mergedAt: state === 'merged' ? updatedAt : null,
    closedAt: state === 'open' ? null : updatedAt,
  };
}

/** Changes requested by anyone wins, then any approval, then reviewers still pending. */
export function bitbucketReviewDecision(pr: BitbucketPullRequest): MergeReviewDecision | null {
  const reviewers = (pr.participants ?? []).filter((p) => p.role === 'REVIEWER');
  if (reviewers.some((p) => p.state === 'changes_requested')) return 'changes_requested';
  if (reviewers.some((p) => p.approved === true || p.state === 'approved')) return 'approved';
  return pendingReviewers(pr).length > 0 ? 'review_required' : null;
}

/** One status for a commit's build statuses: a failure wins, then anything running. */
export function bitbucketChecksStatus(statuses: BitbucketCommitStatus[]): MergeChecksStatus | null {
  if (statuses.length === 0) return null;
  const states = statuses.map((s) => s.state);
  if (states.includes('FAILED')) return 'failure';
  if (states.includes('INPROGRESS')) return 'pending';
  return states.includes('SUCCESSFUL') ? 'success' : 'neutral';
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** `X-Hub-Signature: sha256=<hex HMAC of the raw body>`. */
export async function verifyBitbucketSignature(
  headers: Record<string, string>,
  rawBody: string,
  secret: string,
): Promise<boolean> {
  const value = header(headers, 'x-hub-signature');
  if (!value || !secret) return false;
  const expected = `sha256=${await hmacSha256Hex(secret, rawBody)}`;
  return constantTimeEqual(value.trim().toLowerCase(), expected);
}

const PR_ACTIONS: Record<string, string> = {
  'pullrequest:created': 'opened',
  'pullrequest:updated': 'edited',
  'pullrequest:fulfilled': 'merged',
  'pullrequest:rejected': 'closed',
  'pullrequest:approved': 'approved',
  'pullrequest:unapproved': 'unapproved',
  'pullrequest:changes_request_created': 'changes_requested',
  'pullrequest:changes_request_removed': 'changes_request_removed',
};

const REVIEW_EVENTS = new Set([
  'pullrequest:approved',
  'pullrequest:unapproved',
  'pullrequest:changes_request_created',
  'pullrequest:changes_request_removed',
]);

function pullRequestEvents(eventKey: string, payload: Json, repositoryExternalId: string): NormalizedWebhookEvent[] {
  const raw = obj(payload.pullrequest);
  if (!raw) return [];
  const pullRequest = mapBitbucketPullRequest(raw as unknown as BitbucketPullRequest);
  const events: NormalizedWebhookEvent[] = [
    { kind: 'pull_request', repositoryExternalId, action: PR_ACTIONS[eventKey] ?? 'edited', pullRequest },
  ];
  if (REVIEW_EVENTS.has(eventKey)) {
    // The hook's participant list is not always complete: the receiver re-reads the decision.
    events.push({ kind: 'review', repositoryExternalId, number: pullRequest.number, decision: null });
  }
  return events;
}

function commitStatusEvents(payload: Json, repositoryExternalId: string): NormalizedWebhookEvent[] {
  const status = obj(payload.commit_status);
  const sha = str(obj(status?.commit)?.hash);
  if (!sha) return [];
  // One build's state is not the commit's status: the receiver re-reads all of them.
  return [{ kind: 'checks', repositoryExternalId, headSha: sha, status: null, numbers: [] }];
}

/** One Bitbucket webhook delivery (`X-Event-Key` names it) as normalized events. */
export function parseBitbucketWebhook(headers: Record<string, string>, body: unknown): NormalizedWebhookEvent[] {
  const payload = obj(body);
  const eventKey = header(headers, 'x-event-key');
  if (!payload || !eventKey) return [];
  const repositoryExternalId = idString(obj(payload.repository)?.uuid);
  if (!repositoryExternalId) return [];
  if (eventKey.startsWith('pullrequest:')) {
    if (eventKey.endsWith(':comment_created') || eventKey.endsWith(':comment_updated') || eventKey.endsWith(':comment_deleted')) {
      return [];
    }
    return pullRequestEvents(eventKey, payload, repositoryExternalId);
  }
  if (eventKey === 'repo:commit_status_created' || eventKey === 'repo:commit_status_updated') {
    return commitStatusEvents(payload, repositoryExternalId);
  }
  return [];
}
