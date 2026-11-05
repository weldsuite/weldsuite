/**
 * Azure DevOps' `ReviewAdapter` (phase 4). `connection.host` is the
 * organisation URL (`https://dev.azure.com/<org>`), `repository.externalProject`
 * the project, `repository.externalId` the repository id. The token is an Entra
 * ID bearer token. Azure DevOps has no per-file patch endpoint, so `patch` is
 * null and additions/deletions are 0; a "request changes" is the reviewer vote
 * "waiting for the author" (-5).
 */

import type {
  MergeFileStatus,
  MergePullRequestFile,
  MergeReviewThread,
  MergeThreadComment,
} from '@weldsuite/app-api-client/schemas/weldmerge-review';
import { bearer, diffSide, MAX_COMMENTS, MAX_FILES, providerJson, REVIEW_PAGE, requireToken, trimTrailingSlashes } from '../review-http';
import { ProviderApiError, type AdapterContext, type RepositoryRef, type ReviewAdapter } from '../types';

const API_VERSION = 'api-version=7.1';

interface AzureIteration {
  id: number;
}

interface AzureChange {
  changeType: string;
  item?: { path?: string };
  originalPath?: string;
}

interface AzureComment {
  id: number;
  content?: string;
  commentType?: string;
  parentCommentId?: number;
  author?: { displayName?: string; uniqueName?: string; imageUrl?: string } | null;
  publishedDate: string;
}

interface AzureThread {
  id: number;
  status?: string;
  comments?: AzureComment[];
  threadContext?: {
    filePath?: string;
    rightFileStart?: { line: number } | null;
    leftFileStart?: { line: number } | null;
  } | null;
}

interface AzurePullRequest {
  status?: string;
  mergeStatus?: string;
  mergeFailureMessage?: string;
  lastMergeSourceCommit?: { commitId: string };
}

const orgOf = (ctx: AdapterContext) => trimTrailingSlashes(ctx.connection.host ?? '');

const repoUrl = (ctx: AdapterContext, repository: RepositoryRef) =>
  `${orgOf(ctx)}/${encodeURIComponent(repository.externalProject ?? '')}/_apis/git/repositories/${encodeURIComponent(repository.externalId)}`;

const prUrl = (ctx: AdapterContext, repository: RepositoryRef, number: number) => `${repoUrl(ctx, repository)}/pullrequests/${number}`;

function call<T>(ctx: AdapterContext, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown): Promise<T | null> {
  return providerJson<T>('azure_devops', { method, url, headers: bearer(requireToken('azure_devops', ctx.memberToken)), body });
}

const CHANGE_TYPES: Record<string, MergeFileStatus> = {
  add: 'added',
  edit: 'modified',
  delete: 'removed',
  rename: 'renamed',
  'edit, rename': 'renamed',
};

const stripSlash = (path: string) => path.replace(/^\//, '');

async function listChanges(ctx: AdapterContext, repository: RepositoryRef, number: number): Promise<AzureChange[]> {
  const base = prUrl(ctx, repository, number);
  const iterations = (await call<{ value?: AzureIteration[] }>(ctx, 'GET', `${base}/iterations?${API_VERSION}`))?.value ?? [];
  const last = iterations[iterations.length - 1];
  if (!last) return [];
  const out: AzureChange[] = [];
  for (let skip = 0; ; skip += REVIEW_PAGE) {
    if (out.length >= MAX_FILES) break;
    const page = await call<{ changeEntries?: AzureChange[]; nextSkip?: number }>(
      ctx,
      'GET',
      `${base}/iterations/${last.id}/changes?$top=${REVIEW_PAGE}&$skip=${skip}&${API_VERSION}`,
    );
    out.push(...(page?.changeEntries ?? []));
    if (!page?.nextSkip) break;
  }
  return out.slice(0, MAX_FILES);
}

function threadComment(row: AzureComment): MergeThreadComment {
  const author = row.author;
  return {
    id: String(row.id),
    body: row.content ?? '',
    author: author ? { login: author.uniqueName ?? author.displayName ?? 'unknown', avatarUrl: author.imageUrl ?? null } : null,
    createdAt: row.publishedDate,
    url: null,
  };
}

const RESOLVED = new Set(['fixed', 'closed', 'wontFix', 'byDesign']);

function threadOf(thread: AzureThread): MergeReviewThread | null {
  const comments = (thread.comments ?? []).filter((c) => c.commentType !== 'system');
  if (comments.length === 0) return null;
  const context = thread.threadContext;
  const right = context?.rightFileStart?.line ?? null;
  const left = context?.leftFileStart?.line ?? null;
  const line = right ?? left;
  return {
    id: String(thread.id),
    path: context?.filePath ? stripSlash(context.filePath) : null,
    line,
    side: diffSide(right, left),
    resolved: RESOLVED.has(thread.status ?? ''),
    comments: comments.map(threadComment),
  };
}

function threadContext(path: string, line: number, side: 'LEFT' | 'RIGHT') {
  const point = { line, offset: 1 };
  const key = side === 'LEFT' ? 'left' : 'right';
  return { filePath: `/${stripSlash(path)}`, [`${key}FileStart`]: point, [`${key}FileEnd`]: point };
}

async function newThread(
  ctx: AdapterContext,
  repository: RepositoryRef,
  number: number,
  body: string,
  anchor?: { path: string; line: number; side: 'LEFT' | 'RIGHT' },
): Promise<AzureThread> {
  return (await call<AzureThread>(ctx, 'POST', `${prUrl(ctx, repository, number)}/threads?${API_VERSION}`, {
    comments: [{ parentCommentId: 0, content: body, commentType: 1 }],
    status: 1,
    ...(anchor ? { threadContext: threadContext(anchor.path, anchor.line, anchor.side) } : {}),
  }))!;
}

/** The signed-in member's id, which the reviewer vote is addressed to. */
async function currentUserId(ctx: AdapterContext): Promise<string> {
  const data = await call<{ authenticatedUser?: { id?: string } }>(ctx, 'GET', `${orgOf(ctx)}/_apis/connectionData?${API_VERSION}-preview`);
  const id = data?.authenticatedUser?.id;
  if (!id) throw new ProviderApiError('azure_devops', 401, 'Azure DevOps did not say who this token belongs to');
  return id;
}

const VOTES = { approve: 10, request_changes: -5, comment: 0 } as const;
const STRATEGIES = { merge: 'noFastForward', squash: 'squash', rebase: 'rebase' } as const;

type SubmitInput = Parameters<ReviewAdapter['submitReview']>[3];

export const azureDevopsReview: ReviewAdapter = {
  async listFiles(ctx, repository, number) {
    const changes = await listChanges(ctx, repository, number);
    return changes.map((c): MergePullRequestFile => ({
      path: stripSlash(c.item?.path ?? ''),
      previousPath: c.originalPath ? stripSlash(c.originalPath) : null,
      status: CHANGE_TYPES[c.changeType] ?? 'changed',
      additions: 0,
      deletions: 0,
      patch: null,
    }));
  },

  async listThreads(ctx, repository, number) {
    const data = await call<{ value?: AzureThread[] }>(ctx, 'GET', `${prUrl(ctx, repository, number)}/threads?${API_VERSION}`);
    const threads = (data?.value ?? []).flatMap((t) => threadOf(t) ?? []);
    const kept: MergeReviewThread[] = [];
    let seen = 0;
    for (const thread of threads) {
      if (seen >= MAX_COMMENTS) break;
      kept.push(thread);
      seen += thread.comments.length;
    }
    return kept;
  },

  async submitReview(ctx, repository, number, input: SubmitInput) {
    if (input.body) await newThread(ctx, repository, number, input.body);
    for (const c of input.comments ?? []) await newThread(ctx, repository, number, c.body, c);
    if (input.event === 'comment') return;
    const reviewerId = await currentUserId(ctx);
    await call(ctx, 'PUT', `${prUrl(ctx, repository, number)}/reviewers/${reviewerId}?${API_VERSION}`, {
      vote: VOTES[input.event],
    });
  },

  async comment(ctx, repository, number, input) {
    if (input.inReplyToId) {
      const row = (await call<AzureComment>(ctx, 'POST', `${prUrl(ctx, repository, number)}/threads/${input.inReplyToId}/comments?${API_VERSION}`, {
        content: input.body,
        parentCommentId: 1,
        commentType: 1,
      }))!;
      return { comment: threadComment(row), threadId: input.inReplyToId };
    }
    const anchor = input.path && input.line ? { path: input.path, line: input.line, side: input.side ?? 'RIGHT' } : undefined;
    const thread = await newThread(ctx, repository, number, input.body, anchor);
    return { comment: threadComment(thread.comments![0]!), threadId: String(thread.id) };
  },

  async merge(ctx, repository, number, input) {
    const url = `${prUrl(ctx, repository, number)}?${API_VERSION}`;
    const current = await call<AzurePullRequest>(ctx, 'GET', url);
    const message = [input.commitTitle, input.commitMessage].filter(Boolean).join('\n\n');
    const done = await call<AzurePullRequest>(ctx, 'PATCH', url, {
      status: 'completed',
      lastMergeSourceCommit: current?.lastMergeSourceCommit,
      completionOptions: { mergeStrategy: STRATEGIES[input.method], ...(message ? { mergeCommitMessage: message } : {}) },
    });
    if (done?.mergeFailureMessage || done?.mergeStatus === 'conflicts' || done?.mergeStatus === 'failure') {
      throw new ProviderApiError('azure_devops', 409, done.mergeFailureMessage ?? 'The pull request cannot be completed');
    }
  },
};
