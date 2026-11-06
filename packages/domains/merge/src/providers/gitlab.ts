/**
 * GitLab payload mappers: pure functions from GitLab's REST (`/api/v4`) and
 * webhook shapes to `MirrorFields` (`../github.ts`) and the normalized issue
 * and event shapes (`./shared.ts`), plus the review and check rules and the
 * webhook token check. No I/O, no Hono, no database. Works for gitlab.com and
 * self-managed hosts alike.
 *
 * Review decision (kept simple on purpose): GitLab has no per-reviewer "request
 * changes" verdict on every edition, so a merge request is `approved` when it
 * has an approval and none is still missing, `changes_requested` when it is not
 * approved and has unresolved blocking discussions, `review_required` while
 * reviewers are still requested, else null.
 */

import type {
  MergePullRequestLabel,
  MergePullRequestState,
  MergeRequestedReviewer,
  MergeChecksStatus,
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
  type Json,
  type MirrorFields,
  type NormalizedIssue,
  type NormalizedIssueComment,
  type NormalizedWebhookEvent,
} from './shared';

export interface GitlabUser {
  id?: number;
  username?: string | null;
  name?: string | null;
  avatar_url?: string | null;
}

export interface GitlabMergeRequest {
  id: number;
  iid: number;
  title: string;
  description?: string | null;
  state: 'opened' | 'closed' | 'merged' | 'locked' | string;
  draft?: boolean;
  work_in_progress?: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
  created_at: string;
  updated_at: string;
  web_url: string;
  author?: GitlabUser | null;
  source_branch?: string | null;
  target_branch?: string | null;
  sha?: string | null;
  diff_refs?: { head_sha?: string | null } | null;
  reviewers?: GitlabUser[] | null;
  labels?: Array<string | { title?: string; name?: string; color?: string | null }> | null;
  changes_count?: string | number | null;
  blocking_discussions_resolved?: boolean | null;
}

export interface GitlabApprovals {
  approved?: boolean;
  approved_by?: Array<{ user?: GitlabUser | null }> | null;
  approvals_left?: number | null;
}

export interface GitlabIssue {
  id: number;
  iid: number;
  title: string;
  description?: string | null;
  state: 'opened' | 'closed' | string;
  labels?: string[] | null;
  assignees?: GitlabUser[] | null;
  assignee?: GitlabUser | null;
  author?: GitlabUser | null;
  web_url: string;
  updated_at: string;
}

export interface GitlabNote {
  id: number;
  body: string;
  author?: GitlabUser | null;
  created_at: string;
  updated_at?: string | null;
  system?: boolean;
}

const mergeRequestState = (state: string): MergePullRequestState => {
  if (state === 'merged') return 'merged';
  if (state === 'closed') return 'closed';
  return 'open';
};

function labelsOf(labels: GitlabMergeRequest['labels']): MergePullRequestLabel[] {
  return (labels ?? []).flatMap((label) => {
    if (typeof label === 'string') return [{ name: label, color: null }];
    const name = label.title ?? label.name;
    return name ? [{ name, color: label.color ?? null }] : [];
  });
}

function reviewersOf(users: GitlabUser[] | null | undefined): MergeRequestedReviewer[] {
  return (users ?? []).flatMap((user) => {
    const login = lowerLogin(user.username);
    return login ? [{ kind: 'user' as const, login, avatarUrl: user.avatar_url ?? null }] : [];
  });
}

/** A merge request from the REST API (list or single). The list leaves out the size numbers. */
export function mapGitlabMergeRequest(mr: GitlabMergeRequest): MirrorFields {
  const state = mergeRequestState(mr.state);
  const changes = mr.changes_count === null || mr.changes_count === undefined ? Number.NaN : Number(mr.changes_count);
  return {
    externalId: String(mr.id),
    number: mr.iid,
    title: mr.title,
    body: mr.description ?? null,
    state,
    draft: mr.draft === true || mr.work_in_progress === true,
    url: mr.web_url,
    authorLogin: lowerLogin(mr.author?.username),
    authorAvatarUrl: mr.author?.avatar_url ?? null,
    headRef: mr.source_branch ?? null,
    baseRef: mr.target_branch ?? null,
    headSha: mr.diff_refs?.head_sha ?? mr.sha ?? null,
    additions: null,
    deletions: null,
    changedFiles: Number.isFinite(changes) ? changes : null,
    requestedReviewers: reviewersOf(mr.reviewers),
    labels: labelsOf(mr.labels),
    providerCreatedAt: parseProviderDate(mr.created_at),
    providerUpdatedAt: parseProviderDate(mr.updated_at),
    mergedAt: state === 'merged' ? (nullableDate(mr.merged_at) ?? parseProviderDate(mr.updated_at)) : null,
    closedAt: state === 'open' ? null : (nullableDate(mr.closed_at) ?? parseProviderDate(mr.updated_at)),
  };
}

/** The review decision from the approvals and the merge request (see the file comment). */
export function gitlabReviewDecision(input: {
  approvals: GitlabApprovals | null;
  blockingDiscussionsResolved: boolean | null | undefined;
  requestedReviewerCount: number;
}): MergeReviewDecision | null {
  const { approvals } = input;
  const approvedBy = approvals?.approved_by?.length ?? 0;
  const approved = approvals?.approved === true || (approvedBy > 0 && (approvals?.approvals_left ?? 0) === 0);
  if (approved) return 'approved';
  if (input.blockingDiscussionsResolved === false) return 'changes_requested';
  return input.requestedReviewerCount > 0 ? 'review_required' : null;
}

/** One check status for a pipeline status string (GitLab's `status` values). */
export function gitlabPipelineStatus(status: unknown): MergeChecksStatus | null {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
      return 'failure';
    case 'canceled':
    case 'canceling':
    case 'skipped':
    case 'manual':
      return 'neutral';
    case 'created':
    case 'pending':
    case 'running':
    case 'preparing':
    case 'waiting_for_resource':
    case 'scheduled':
    case 'waiting_for_callback':
      return 'pending';
    default:
      return null;
  }
}

/** `success` with warnings is GitLab's `status: success`; a pipeline-less commit has no status. */
export function gitlabChecksStatus(pipelines: Array<{ status?: string | null }>): MergeChecksStatus | null {
  const [latest] = pipelines;
  return latest ? gitlabPipelineStatus(latest.status) : null;
}

export function mapGitlabIssue(issue: GitlabIssue): NormalizedIssue {
  const assignee = issue.assignees?.[0] ?? issue.assignee ?? null;
  return {
    externalId: String(issue.id),
    number: issue.iid,
    url: issue.web_url,
    title: issue.title,
    body: issue.description ?? '',
    state: issue.state === 'closed' ? 'closed' : 'open',
    stateReason: null,
    labels: issue.labels ?? [],
    assigneeLogin: lowerLogin(assignee?.username),
    authorLogin: lowerLogin(issue.author?.username),
    authorAvatarUrl: issue.author?.avatar_url ?? null,
    updatedAt: parseProviderDate(issue.updated_at),
  };
}

export function mapGitlabNote(note: GitlabNote, issueNumber: number): NormalizedIssueComment {
  return {
    externalId: String(note.id),
    issueNumber,
    body: note.body,
    authorLogin: lowerLogin(note.author?.username),
    authorAvatarUrl: note.author?.avatar_url ?? null,
    createdAt: parseProviderDate(note.created_at),
    updatedAt: parseProviderDate(note.updated_at ?? note.created_at),
  };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** `X-Gitlab-Token` is the secret itself: compare it in constant time. */
export function verifyGitlabToken(headers: Record<string, string>, secret: string): boolean {
  const token = header(headers, 'x-gitlab-token');
  return token !== null && secret !== '' && constantTimeEqual(token, secret);
}

const MERGE_REQUEST_ACTIONS: Record<string, string> = {
  open: 'opened',
  close: 'closed',
  reopen: 'reopened',
  update: 'edited',
  merge: 'merged',
  approved: 'approved',
  unapproved: 'unapproved',
  approval: 'approved',
  unapproval: 'unapproved',
};

const REVIEW_ACTIONS = new Set(['approved', 'unapproved', 'approval', 'unapproval']);

const ISSUE_ACTIONS: Record<string, string> = { open: 'opened', close: 'closed', reopen: 'reopened', update: 'edited' };

/**
 * A merge request hook as `MirrorFields`. The hook names the author by id only
 * (its `user` is whoever acted), so `authorLogin` is known only when the merge
 * request was just opened; the receiver completes it from the REST API.
 */
export function mapGitlabMergeRequestHook(payload: Json): MirrorFields | null {
  const attrs = obj(payload.object_attributes);
  if (!attrs) return null;
  const id = idString(attrs.id);
  const iid = Number(attrs.iid);
  const url = str(attrs.url);
  if (!id || !Number.isFinite(iid) || !url) return null;
  const state = mergeRequestState(String(attrs.state ?? 'opened'));
  const updatedAt = parseProviderDate(attrs.updated_at);
  const actor = obj(payload.user);
  const opened = attrs.action === 'open';
  const lastCommit = obj(attrs.last_commit);
  return {
    externalId: id,
    number: iid,
    title: str(attrs.title) ?? '',
    body: str(attrs.description),
    state,
    draft: attrs.draft === true || attrs.work_in_progress === true,
    url,
    authorLogin: opened ? lowerLogin(actor?.username) : null,
    authorAvatarUrl: opened ? (str(actor?.avatar_url) ?? null) : null,
    headRef: str(attrs.source_branch),
    baseRef: str(attrs.target_branch),
    headSha: str(lastCommit?.id),
    additions: null,
    deletions: null,
    changedFiles: null,
    requestedReviewers: reviewersOf(arr(payload.reviewers) as GitlabUser[]),
    labels: labelsOf(arr(payload.labels) as GitlabMergeRequest['labels']),
    providerCreatedAt: parseProviderDate(attrs.created_at),
    providerUpdatedAt: updatedAt,
    mergedAt: state === 'merged' ? (nullableDate(attrs.merged_at) ?? updatedAt) : null,
    closedAt: state === 'open' ? null : (nullableDate(attrs.closed_at) ?? updatedAt),
  };
}

function mergeRequestEvents(payload: Json, repositoryExternalId: string): NormalizedWebhookEvent[] {
  const pullRequest = mapGitlabMergeRequestHook(payload);
  if (!pullRequest) return [];
  const rawAction = str(obj(payload.object_attributes)?.action) ?? 'update';
  const events: NormalizedWebhookEvent[] = [
    { kind: 'pull_request', repositoryExternalId, action: MERGE_REQUEST_ACTIONS[rawAction] ?? rawAction, pullRequest },
  ];
  if (REVIEW_ACTIONS.has(rawAction)) {
    // The hook does not carry the approvals: the receiver re-reads them.
    events.push({ kind: 'review', repositoryExternalId, number: pullRequest.number, decision: null });
  }
  return events;
}

function pipelineEvents(payload: Json, repositoryExternalId: string): NormalizedWebhookEvent[] {
  const attrs = obj(payload.object_attributes);
  const sha = str(attrs?.sha);
  if (!sha) return [];
  const iid = Number(obj(payload.merge_request)?.iid);
  return [
    {
      kind: 'checks',
      repositoryExternalId,
      headSha: sha,
      // GitLab does not order its pending, running and success hooks: the receiver re-reads the pipeline.
      status: null,
      numbers: Number.isFinite(iid) ? [iid] : [],
    },
  ];
}

function issueEvents(payload: Json, repositoryExternalId: string): NormalizedWebhookEvent[] {
  const attrs = obj(payload.object_attributes);
  const id = idString(attrs?.id);
  const iid = Number(attrs?.iid);
  const url = str(attrs?.url);
  if (!attrs || !id || !Number.isFinite(iid) || !url) return [];
  const rawAction = str(attrs.action) ?? 'update';
  const actor = obj(payload.user);
  const opened = rawAction === 'open';
  const assignee = obj(arr(payload.assignees)[0]);
  const labels = arr(payload.labels).flatMap((label) => {
    const title = str(obj(label)?.title);
    return title ? [title] : [];
  });
  return [
    {
      kind: 'issue',
      repositoryExternalId,
      action: ISSUE_ACTIONS[rawAction] ?? rawAction,
      issue: {
        externalId: id,
        number: iid,
        url,
        title: str(attrs.title) ?? '',
        body: str(attrs.description) ?? '',
        state: attrs.state === 'closed' ? 'closed' : 'open',
        stateReason: null,
        labels,
        assigneeLogin: lowerLogin(assignee?.username),
        authorLogin: opened ? lowerLogin(actor?.username) : null,
        authorAvatarUrl: opened ? (str(actor?.avatar_url) ?? null) : null,
        updatedAt: parseProviderDate(attrs.updated_at),
      },
    },
  ];
}

function noteEvents(payload: Json, repositoryExternalId: string): NormalizedWebhookEvent[] {
  const attrs = obj(payload.object_attributes);
  if (!attrs || attrs.noteable_type !== 'Issue' || attrs.system === true) return [];
  const id = idString(attrs.id);
  const issueNumber = Number(obj(payload.issue)?.iid);
  if (!id || !Number.isFinite(issueNumber)) return [];
  const actor = obj(payload.user);
  const created = str(attrs.created_at);
  return [
    {
      kind: 'issue_comment',
      repositoryExternalId,
      action: attrs.action === 'update' ? 'edited' : 'created',
      comment: {
        externalId: id,
        issueNumber,
        body: str(attrs.note) ?? '',
        authorLogin: lowerLogin(actor?.username),
        authorAvatarUrl: str(actor?.avatar_url),
        createdAt: parseProviderDate(created),
        updatedAt: parseProviderDate(attrs.updated_at ?? created),
      },
    },
  ];
}

/** One GitLab hook delivery as normalized events (none for a kind WeldMerge does not read). */
export function parseGitlabWebhook(headers: Record<string, string>, body: unknown): NormalizedWebhookEvent[] {
  const payload = obj(body);
  if (!payload) return [];
  const kind = str(payload.object_kind) ?? str(header(headers, 'x-gitlab-event'));
  const projectId = idString(obj(payload.project)?.id) ?? idString(payload.project_id);
  if (!projectId) return [];
  switch (kind) {
    case 'merge_request':
      return mergeRequestEvents(payload, projectId);
    case 'pipeline':
      return pipelineEvents(payload, projectId);
    case 'issue':
      return issueEvents(payload, projectId);
    case 'note':
      return noteEvents(payload, projectId);
    default:
      return [];
  }
}
