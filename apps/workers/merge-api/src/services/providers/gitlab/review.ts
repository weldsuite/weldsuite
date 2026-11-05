/**
 * GitLab's `ReviewAdapter` (phase 4). Reads and writes use the token the
 * service puts on the context (the connection's for reads, the member's for
 * writes). `repository.externalId` is the project id, the pull request number
 * the merge request `iid`, a thread a discussion.
 */

import type {
  MergeFileStatus,
  MergePullRequestFile,
  MergeReviewThread,
  MergeThreadComment,
} from '@weldsuite/app-api-client/schemas/weldmerge-review';
import { bearer, diffSide, MAX_COMMENTS, MAX_FILES, patchStats, providerJson, REVIEW_PAGE, requireToken, trimTrailingSlashes } from '../review-http';
import type { AdapterContext, RepositoryRef, ReviewAdapter, ReviewLineComment } from '../types';

interface GitlabNote {
  id: number;
  body: string;
  author?: { username: string; avatar_url?: string | null } | null;
  created_at: string;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  position?: { new_path?: string; old_path?: string; new_line?: number | null; old_line?: number | null } | null;
}

interface GitlabDiscussion {
  id: string;
  notes: GitlabNote[];
}

interface GitlabDiff {
  old_path: string;
  new_path: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  diff?: string;
}

interface GitlabMergeRequest {
  web_url?: string;
  rebase_in_progress?: boolean;
  diff_refs?: { base_sha: string; start_sha: string; head_sha: string } | null;
}

const hostOf = (ctx: AdapterContext) => trimTrailingSlashes(ctx.connection.host ?? 'https://gitlab.com');

const mrPath = (repository: RepositoryRef, number: number) =>
  `/api/v4/projects/${encodeURIComponent(repository.externalId)}/merge_requests/${number}`;

function call<T>(ctx: AdapterContext, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T | null> {
  return providerJson<T>('gitlab', {
    method,
    url: `${hostOf(ctx)}${path}`,
    headers: bearer(requireToken('gitlab', ctx.memberToken)),
    body,
  });
}

async function collect<T>(ctx: AdapterContext, path: string, cap: number): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    if (out.length >= cap) break;
    const rows = (await call<T[]>(ctx, 'GET', `${path}?per_page=${REVIEW_PAGE}&page=${page}`)) ?? [];
    out.push(...rows);
    if (rows.length < REVIEW_PAGE) break;
  }
  return out.slice(0, cap);
}

function diffStatus(d: GitlabDiff): MergeFileStatus {
  if (d.new_file) return 'added';
  if (d.deleted_file) return 'removed';
  if (d.renamed_file) return 'renamed';
  return 'modified';
}

function threadComment(note: GitlabNote, url: string | null): MergeThreadComment {
  return {
    id: String(note.id),
    body: note.body,
    author: note.author ? { login: note.author.username, avatarUrl: note.author.avatar_url ?? null } : null,
    createdAt: note.created_at,
    url,
  };
}

function threadOf(discussion: GitlabDiscussion): MergeReviewThread | null {
  const notes = discussion.notes.filter((n) => !n.system);
  const first = notes[0];
  if (!first) return null;
  const position = first.position;
  const line = position ? (position.new_line ?? position.old_line ?? null) : null;
  return {
    id: discussion.id,
    path: position ? (position.new_path ?? position.old_path ?? null) : null,
    line,
    side: diffSide(position?.new_line, position?.old_line),
    resolved: first.resolvable === true && first.resolved === true,
    comments: notes.map((n) => threadComment(n, null)),
  };
}

/** A new discussion; a line comment carries the diff position of the merge request's current head. */
async function startDiscussion(
  ctx: AdapterContext,
  repository: RepositoryRef,
  number: number,
  body: string,
  anchor?: Pick<ReviewLineComment, 'path' | 'line' | 'side'>,
): Promise<GitlabDiscussion> {
  const payload: Record<string, unknown> = { body };
  if (anchor) {
    const mr = await call<GitlabMergeRequest>(ctx, 'GET', mrPath(repository, number));
    const refs = mr?.diff_refs;
    payload.position = {
      position_type: 'text',
      base_sha: refs?.base_sha,
      start_sha: refs?.start_sha,
      head_sha: refs?.head_sha,
      new_path: anchor.path,
      old_path: anchor.path,
      ...(anchor.side === 'LEFT' ? { old_line: anchor.line } : { new_line: anchor.line }),
    };
  }
  return (await call<GitlabDiscussion>(ctx, 'POST', `${mrPath(repository, number)}/discussions`, payload))!;
}

async function waitForRebase(ctx: AdapterContext, repository: RepositoryRef, number: number): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const mr = await call<GitlabMergeRequest>(ctx, 'GET', `${mrPath(repository, number)}?include_rebase_in_progress=true`);
    if (!mr?.rebase_in_progress) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

type MergeInput = Parameters<ReviewAdapter['merge']>[3];

function mergeBody(input: MergeInput): Record<string, unknown> {
  const message = [input.commitTitle, input.commitMessage].filter(Boolean).join('\n\n');
  if (input.method === 'squash') return { squash: true, ...(message ? { squash_commit_message: message } : {}) };
  if (input.method === 'merge' && message) return { merge_commit_message: message };
  return {};
}

type SubmitInput = Parameters<ReviewAdapter['submitReview']>[3];

export const gitlabReview: ReviewAdapter = {
  async listFiles(ctx, repository, number) {
    const rows = await collect<GitlabDiff>(ctx, `${mrPath(repository, number)}/diffs`, MAX_FILES);
    return rows.map((d): MergePullRequestFile => {
      const patch = d.diff ? d.diff : null;
      return {
        path: d.new_path,
        previousPath: d.renamed_file ? d.old_path : null,
        status: diffStatus(d),
        ...patchStats(patch),
        patch,
      };
    });
  },

  async listThreads(ctx, repository, number) {
    const rows = await collect<GitlabDiscussion>(ctx, `${mrPath(repository, number)}/discussions`, MAX_COMMENTS);
    return rows.flatMap((d) => threadOf(d) ?? []);
  },

  async submitReview(ctx, repository, number, input: SubmitInput) {
    // GitLab has no "changes requested" state: the request is posted as a discussion.
    if (input.event === 'approve') await call(ctx, 'POST', `${mrPath(repository, number)}/approve`);
    if (input.body) await startDiscussion(ctx, repository, number, input.body);
    for (const c of input.comments ?? []) await startDiscussion(ctx, repository, number, c.body, c);
  },

  async comment(ctx, repository, number, input) {
    if (input.inReplyToId) {
      const note = (await call<GitlabNote>(
        ctx,
        'POST',
        `${mrPath(repository, number)}/discussions/${encodeURIComponent(input.inReplyToId)}/notes`,
        { body: input.body },
      ))!;
      return { comment: threadComment(note, null), threadId: input.inReplyToId };
    }
    const anchor = input.path && input.line ? { path: input.path, line: input.line, side: input.side ?? 'RIGHT' } : undefined;
    const discussion = await startDiscussion(ctx, repository, number, input.body, anchor);
    return { comment: threadComment(discussion.notes[0]!, null), threadId: discussion.id };
  },

  async merge(ctx, repository, number, input) {
    if (input.method === 'rebase') {
      await call(ctx, 'PUT', `${mrPath(repository, number)}/rebase`);
      await waitForRebase(ctx, repository, number);
    }
    await call(ctx, 'PUT', `${mrPath(repository, number)}/merge`, mergeBody(input));
  },
};
