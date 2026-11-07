/**
 * GitHub's `IssueSyncAdapter` (two-way issue sync, phase 2): issues and their
 * comments over the REST API with the App's installation token. One `fetch` per
 * call, no retries, so the same input makes the same outbound calls on every
 * backend. A refusal from GitHub is a `ProviderApiError` carrying its own
 * message; the sync engine (services/issue-sync) turns it into a 502
 * `provider_error` for the explicit routes and logs it for automatic pushes.
 *
 * Pull requests are not issues: GitHub lists and serves them on the issues
 * endpoints too (they carry a `pull_request` key), and every read here leaves
 * them out.
 */

import { getGithubInstallationToken } from '@weldsuite/connect-domain/github/app-auth';
import { GITHUB_API, GithubNotConfiguredError } from '../../github-client';
import {
  ProviderApiError,
  type AdapterContext,
  type IssueSyncAdapter,
  type IssueSyncListOptions,
  type IssueWriteInput,
  type NormalizedIssue,
  type NormalizedIssueComment,
  type RepositoryRef,
} from '../types';

const PAGE = 100;
/** Pages of issues read at most (the import takes up to 500 issues; pull requests share the pages). */
const MAX_PAGES = 30;
/** Comments read for one issue, at most. */
const COMMENT_CAP = 500;

// ---------------------------------------------------------------------------
// Payload shapes (REST answers and webhook bodies share them)
// ---------------------------------------------------------------------------

interface GithubUserRef {
  login?: string | null;
  avatar_url?: string | null;
}

export interface GithubIssuePayload {
  id: number;
  number: number;
  html_url?: string | null;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  state_reason?: string | null;
  labels?: Array<{ name?: string | null } | string> | null;
  assignee?: GithubUserRef | null;
  assignees?: GithubUserRef[] | null;
  user?: GithubUserRef | null;
  updated_at?: string | null;
  created_at?: string | null;
  /** Present on pull requests. */
  pull_request?: unknown;
}

export interface GithubCommentPayload {
  id: number;
  body?: string | null;
  user?: GithubUserRef | null;
  created_at?: string | null;
  updated_at?: string | null;
  /** The issue the comment is on, as `…/issues/<number>`. */
  issue_url?: string | null;
}

export function isGithubPullRequest(issue: GithubIssuePayload): boolean {
  return issue.pull_request !== undefined && issue.pull_request !== null;
}

/** `completed` unless GitHub says `not_planned`; null while open. */
function closedReason(issue: GithubIssuePayload, closed: boolean): 'completed' | 'not_planned' | null {
  if (!closed) return null;
  return issue.state_reason === 'not_planned' ? 'not_planned' : 'completed';
}

/** GitHub's issue as WeldMerge's neutral shape. `completed` is a closed issue's default reason. */
export function normalizeGithubIssue(issue: GithubIssuePayload): NormalizedIssue {
  const closed = issue.state === 'closed';
  const labels = (issue.labels ?? [])
    .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
    .filter((name) => name !== '');
  return {
    externalId: String(issue.id),
    number: issue.number,
    url: issue.html_url ?? '',
    title: issue.title ?? '',
    body: issue.body ?? '',
    state: closed ? 'closed' : 'open',
    stateReason: closedReason(issue, closed),
    labels,
    assigneeLogin: issue.assignee?.login ?? issue.assignees?.[0]?.login ?? null,
    authorLogin: issue.user?.login ?? null,
    authorAvatarUrl: issue.user?.avatar_url ?? null,
    updatedAt: new Date(issue.updated_at ?? issue.created_at ?? 0),
  };
}

/** The issue number a comment belongs to, from its payload's `issue_url` (or the given fallback). */
export function normalizeGithubComment(comment: GithubCommentPayload, issueNumber?: number): NormalizedIssueComment {
  const fromUrl = /\/issues\/(\d+)$/.exec(comment.issue_url ?? '')?.[1];
  return {
    externalId: String(comment.id),
    issueNumber: issueNumber ?? Number(fromUrl ?? 0),
    body: comment.body ?? '',
    authorLogin: comment.user?.login ?? null,
    authorAvatarUrl: comment.user?.avatar_url ?? null,
    createdAt: new Date(comment.created_at ?? 0),
    updatedAt: new Date(comment.updated_at ?? comment.created_at ?? 0),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function request<T>(
  ctx: AdapterContext,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T | null> {
  const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: privateKey } = ctx.env;
  if (!appId || !privateKey) throw new GithubNotConfiguredError();
  const token = await getGithubInstallationToken(appId, privateKey, Number(ctx.connection.externalAccountId));
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'WeldSuite-WeldMerge',
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${GITHUB_API}${path}`, init);
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) throw new ProviderApiError('github', res.status, await refusal(res));
  return (await res.json()) as T;
}

/** GitHub's own `message` for a refusal. */
async function refusal(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const message = (JSON.parse(text) as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  } catch {
    // Not JSON: fall through to the status.
  }
  return `GitHub answered ${res.status}`;
}

const issuesPath = (repository: RepositoryRef) => `/repos/${repository.fullName}/issues`;

function issueBody(input: IssueWriteInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body.title = input.title;
  if (input.body !== undefined) body.body = input.body;
  if (input.labels !== undefined) body.labels = input.labels;
  if (input.assigneeLogin !== undefined) body.assignees = input.assigneeLogin === null ? [] : [input.assigneeLogin];
  if (input.state !== undefined) {
    body.state = input.state;
    if (input.state === 'closed' && input.stateReason) body.state_reason = input.stateReason;
  }
  return body;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

async function listIssues(ctx: AdapterContext, repository: RepositoryRef, options: IssueSyncListOptions = {}): Promise<NormalizedIssue[]> {
  const limit = options.limit ?? 500;
  const out: NormalizedIssue[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      state: options.state ?? 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: String(PAGE),
      page: String(page),
    });
    if (options.since) params.set('since', options.since.toISOString());
    const rows = (await request<GithubIssuePayload[]>(ctx, 'GET', `${issuesPath(repository)}?${params}`)) ?? [];
    for (const row of rows) {
      if (!isGithubPullRequest(row)) out.push(normalizeGithubIssue(row));
      if (out.length >= limit) break;
    }
    if (rows.length < PAGE || out.length >= limit) break;
  }
  return out;
}

async function getIssue(ctx: AdapterContext, repository: RepositoryRef, number: number): Promise<NormalizedIssue | null> {
  const row = await request<GithubIssuePayload>(ctx, 'GET', `${issuesPath(repository)}/${number}`);
  return row && !isGithubPullRequest(row) ? normalizeGithubIssue(row) : null;
}

async function updateIssue(
  ctx: AdapterContext,
  repository: RepositoryRef,
  number: number,
  input: IssueWriteInput,
): Promise<NormalizedIssue> {
  const row = await request<GithubIssuePayload>(ctx, 'PATCH', `${issuesPath(repository)}/${number}`, issueBody(input));
  return normalizeGithubIssue(row!);
}

/** GitHub creates issues open: a closed one is closed with a second call. */
async function createIssue(
  ctx: AdapterContext,
  repository: RepositoryRef,
  input: IssueWriteInput & { title: string },
): Promise<NormalizedIssue> {
  const { state, stateReason, ...open } = input;
  const row = await request<GithubIssuePayload>(ctx, 'POST', issuesPath(repository), issueBody(open));
  const created = normalizeGithubIssue(row!);
  return state === 'closed' ? updateIssue(ctx, repository, created.number, { state, stateReason }) : created;
}

async function listComments(ctx: AdapterContext, repository: RepositoryRef, number: number): Promise<NormalizedIssueComment[]> {
  const out: NormalizedIssueComment[] = [];
  for (let page = 1; page <= COMMENT_CAP / PAGE; page++) {
    const rows =
      (await request<GithubCommentPayload[]>(ctx, 'GET', `${issuesPath(repository)}/${number}/comments?per_page=${PAGE}&page=${page}`)) ?? [];
    out.push(...rows.map((row) => normalizeGithubComment(row, number)));
    if (rows.length < PAGE) break;
  }
  return out;
}

async function createComment(ctx: AdapterContext, repository: RepositoryRef, number: number, body: string): Promise<NormalizedIssueComment> {
  const row = await request<GithubCommentPayload>(ctx, 'POST', `${issuesPath(repository)}/${number}/comments`, { body });
  return normalizeGithubComment(row!, number);
}

export const githubIssues: IssueSyncAdapter = { listIssues, getIssue, createIssue, updateIssue, listComments, createComment };
