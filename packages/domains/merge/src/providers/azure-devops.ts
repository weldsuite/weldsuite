/**
 * Azure DevOps payload mappers: pure functions from the Git REST (`7.1`) and
 * service-hook shapes to `MirrorFields`, plus the vote, status and policy rules
 * and the service hook's basic-auth check. No I/O, no Hono, no database.
 *
 * Azure DevOps pull requests carry no "updated" timestamp. The caller passes
 * `updatedAt`: the read time for a REST read (so Refresh always applies), the
 * event's `createdDate` for a service hook (so an older delivery is dropped).
 *
 * A person's login is their `uniqueName` (the sign-in address), lower-case.
 */

import type {
  MergeChecksStatus,
  MergePullRequestState,
  MergeRequestedReviewer,
  MergeReviewDecision,
} from '@weldsuite/db/schema';
import {
  arr,
  constantTimeEqual,
  header,
  idString,
  lowerLogin,
  nullableDate,
  obj,
  parseProviderDate,
  str,
  trimTrailingSlashes,
  type Json,
  type MirrorFields,
  type NormalizedWebhookEvent,
} from './shared';

export interface AzureIdentity {
  id?: string;
  displayName?: string | null;
  uniqueName?: string | null;
  imageUrl?: string | null;
}

export interface AzureReviewer extends AzureIdentity {
  /** 10 approved, 5 approved with suggestions, 0 no vote, -5 waiting for the author, -10 rejected. */
  vote?: number;
  isContainer?: boolean;
  isRequired?: boolean;
}

export interface AzurePullRequest {
  pullRequestId: number;
  codeReviewId?: number;
  status: 'active' | 'abandoned' | 'completed' | 'notSet' | string;
  createdBy?: AzureIdentity | null;
  creationDate: string;
  closedDate?: string | null;
  title: string;
  description?: string | null;
  sourceRefName?: string | null;
  targetRefName?: string | null;
  isDraft?: boolean;
  reviewers?: AzureReviewer[] | null;
  labels?: Array<{ name?: string | null }> | null;
  lastMergeSourceCommit?: { commitId?: string | null } | null;
  repository?: { id?: string; name?: string; project?: { id?: string; name?: string } | null } | null;
  _links?: { web?: { href?: string | null } | null } | null;
}

export interface AzureStatus {
  state?: 'succeeded' | 'failed' | 'error' | 'pending' | 'notApplicable' | 'notSet' | string;
}

export interface AzurePolicyEvaluation {
  status?: 'approved' | 'rejected' | 'queued' | 'running' | 'notApplicable' | 'broken' | string;
  configuration?: { isBlocking?: boolean; isEnabled?: boolean } | null;
}

/** `refs/heads/main` → `main`. */
export const azureBranchName = (ref: string | null | undefined): string | null =>
  ref ? ref.replace(/^refs\/heads\//, '') : null;

/** The web URL of a pull request, built from the organisation URL when the payload carries none. */
export function azurePullRequestUrl(organizationUrl: string, pr: AzurePullRequest): string {
  const web = pr._links?.web?.href;
  if (web) return web;
  const project = encodeURIComponent(pr.repository?.project?.name ?? '');
  const repo = encodeURIComponent(pr.repository?.name ?? '');
  return `${trimTrailingSlashes(organizationUrl)}/${project}/_git/${repo}/pullrequest/${pr.pullRequestId}`;
}

function pullRequestState(status: string): MergePullRequestState {
  if (status === 'completed') return 'merged';
  if (status === 'abandoned') return 'closed';
  return 'open';
}

function pendingReviewers(reviewers: AzureReviewer[] | null | undefined): MergeRequestedReviewer[] {
  return (reviewers ?? []).flatMap((reviewer): MergeRequestedReviewer[] => {
    if ((reviewer.vote ?? 0) !== 0) return [];
    if (reviewer.isContainer) {
      return reviewer.displayName ? [{ kind: 'team' as const, login: reviewer.displayName }] : [];
    }
    const login = lowerLogin(reviewer.uniqueName);
    return login ? [{ kind: 'user' as const, login, avatarUrl: reviewer.imageUrl ?? null }] : [];
  });
}

export interface AzureMapOptions {
  organizationUrl: string;
  /** What to store as `providerUpdatedAt` (see the file comment). */
  updatedAt: Date;
}

export function mapAzurePullRequest(pr: AzurePullRequest, options: AzureMapOptions): MirrorFields {
  const state = pullRequestState(pr.status);
  const closedAt = nullableDate(pr.closedDate) ?? (state === 'open' ? null : options.updatedAt);
  return {
    externalId: String(pr.pullRequestId),
    number: pr.pullRequestId,
    title: pr.title,
    body: str(pr.description),
    state,
    draft: pr.isDraft === true,
    url: azurePullRequestUrl(options.organizationUrl, pr),
    authorLogin: lowerLogin(pr.createdBy?.uniqueName),
    authorAvatarUrl: pr.createdBy?.imageUrl ?? null,
    headRef: azureBranchName(pr.sourceRefName),
    baseRef: azureBranchName(pr.targetRefName),
    headSha: pr.lastMergeSourceCommit?.commitId ?? null,
    additions: null,
    deletions: null,
    changedFiles: null,
    requestedReviewers: pendingReviewers(pr.reviewers),
    labels: (pr.labels ?? []).flatMap((l) => (l.name ? [{ name: l.name, color: null }] : [])),
    providerCreatedAt: parseProviderDate(pr.creationDate),
    providerUpdatedAt: options.updatedAt,
    mergedAt: state === 'merged' ? closedAt : null,
    closedAt: state === 'open' ? null : closedAt,
  };
}

/**
 * Votes: -10 (rejected) and -5 (waiting for the author) request changes; 10
 * and 5 approve; a reviewer who has not voted keeps it `review_required`.
 * Groups (containers) do not vote.
 */
export function azureReviewDecision(reviewers: AzureReviewer[] | null | undefined): MergeReviewDecision | null {
  const people = (reviewers ?? []).filter((r) => !r.isContainer);
  const votes = people.map((r) => r.vote ?? 0);
  if (votes.some((v) => v < 0)) return 'changes_requested';
  if (votes.some((v) => v > 0)) return 'approved';
  return votes.length > 0 ? 'review_required' : null;
}

/** One status for a pull request's statuses and policy evaluations: any failure wins, then anything running. */
export function azureChecksStatus(
  statuses: AzureStatus[],
  evaluations: AzurePolicyEvaluation[],
): MergeChecksStatus | null {
  const states = statuses.filter((s) => s.state && s.state !== 'notSet' && s.state !== 'notApplicable').map((s) => s.state);
  const policies = evaluations
    .filter((e) => e.configuration?.isBlocking !== false && e.status && e.status !== 'notApplicable')
    .map((e) => e.status);
  if (states.length === 0 && policies.length === 0) return null;
  const failed = states.includes('failed') || states.includes('error') || policies.includes('rejected') || policies.includes('broken');
  if (failed) return 'failure';
  if (states.includes('pending') || policies.includes('queued') || policies.includes('running')) return 'pending';
  return states.includes('succeeded') || policies.includes('approved') ? 'success' : 'neutral';
}

// ---------------------------------------------------------------------------
// Webhooks (service hooks)
// ---------------------------------------------------------------------------

/** The service hook's basic-auth password (`Authorization: Basic base64(user:password)`). */
export function verifyAzureBasicAuth(headers: Record<string, string>, secret: string): boolean {
  const value = header(headers, 'authorization');
  if (!value || !secret || !/^basic\s+/i.test(value)) return false;
  let decoded: string;
  try {
    decoded = atob(value.replace(/^basic\s+/i, '').trim());
  } catch {
    return false;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  return constantTimeEqual(decoded.slice(separator + 1), secret);
}

/** The organisation URL a service hook payload came from (`https://dev.azure.com/<org>`). */
export function azureOrganizationUrl(payload: Json): string {
  const base = str(obj(obj(payload.resourceContainers)?.collection)?.baseUrl) ?? str(obj(obj(payload.resourceContainers)?.account)?.baseUrl);
  if (base) return trimTrailingSlashes(base);
  try {
    const url = new URL(str(obj(payload.resource)?.url) ?? '');
    const org = url.pathname.split('/').find(Boolean);
    return org ? `${url.origin}/${org}` : '';
  } catch {
    return '';
  }
}

const ACTIONS: Record<string, string> = {
  'git.pullrequest.created': 'opened',
  'git.pullrequest.updated': 'edited',
  'git.pullrequest.merged': 'merged',
};

/** One service hook delivery as normalized events. */
export function parseAzureWebhook(_headers: Record<string, string>, body: unknown): NormalizedWebhookEvent[] {
  const payload = obj(body);
  const eventType = str(payload?.eventType);
  const resource = obj(payload?.resource);
  if (!payload || !eventType || !resource || !(eventType in ACTIONS)) return [];
  const repositoryExternalId = idString(obj(resource.repository)?.id);
  const raw = resource as unknown as AzurePullRequest;
  if (!repositoryExternalId || typeof raw.pullRequestId !== 'number') return [];

  const updatedAt = parseProviderDate(payload.createdDate);
  const pullRequest = mapAzurePullRequest(raw, { organizationUrl: azureOrganizationUrl(payload), updatedAt });
  const events: NormalizedWebhookEvent[] = [
    { kind: 'pull_request', repositoryExternalId, action: ACTIONS[eventType] ?? 'edited', pullRequest },
  ];
  if (arr(raw.reviewers).length > 0) {
    // Deliveries arrive out of order and the decision is written without a staleness check:
    // the receiver re-reads the votes rather than trust this payload's.
    events.push({ kind: 'review', repositoryExternalId, number: raw.pullRequestId, decision: null });
  }
  if (pullRequest.headSha && pullRequest.state === 'open') {
    // A policy or status change shows up as an update: the receiver re-reads the checks.
    events.push({ kind: 'checks', repositoryExternalId, headSha: pullRequest.headSha, status: null, numbers: [raw.pullRequestId] });
  }
  return events;
}
