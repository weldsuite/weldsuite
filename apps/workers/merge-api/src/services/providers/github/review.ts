/**
 * GitHub's `ReviewAdapter` (phase 4). Reads use the installation token
 * (`createGithubClient`); writes go out with the member's own user-to-server
 * token (`ctx.memberToken`), so GitHub shows the member as the reviewer.
 */

import type {
  MergeFileStatus,
  MergePullRequestFile,
  MergeReviewThread,
  MergeThreadComment,
} from '@weldsuite/app-api-client/schemas/weldmerge-review';
import { createGithubClient, GITHUB_API } from '../../github-client';
import { bearer, MAX_COMMENTS, MAX_FILES, providerJson, REVIEW_PAGE, requireToken } from '../review-http';
import type { AdapterContext, RepositoryRef, ReviewAdapter } from '../types';

interface GithubUser {
  login: string;
  avatar_url?: string | null;
}

interface GithubFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface GithubComment {
  id: number;
  body: string;
  user: GithubUser | null;
  created_at: string;
  html_url?: string | null;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  side?: 'LEFT' | 'RIGHT' | null;
  in_reply_to_id?: number | null;
}

const FILE_STATUSES: readonly string[] = ['added', 'removed', 'modified', 'renamed', 'copied', 'changed'];

function fileStatus(status: string): MergeFileStatus {
  return (FILE_STATUSES.includes(status) ? status : 'changed') as MergeFileStatus;
}

const author = (user: GithubUser | null) => (user ? { login: user.login, avatarUrl: user.avatar_url ?? null } : null);

function threadComment(row: GithubComment): MergeThreadComment {
  return { id: String(row.id), body: row.body, author: author(row.user), createdAt: row.created_at, url: row.html_url ?? null };
}

/** Pages through a list endpoint until it runs dry or `cap` rows are read. */
async function collect<T>(ctx: AdapterContext, path: string, cap: number): Promise<T[]> {
  const client = createGithubClient(ctx.env, ctx.connection.externalAccountId);
  const out: T[] = [];
  for (let page = 1; ; page++) {
    if (out.length >= cap) break;
    const rows = (await client.get<T[]>(`${path}?per_page=${REVIEW_PAGE}&page=${page}`)) ?? [];
    out.push(...rows);
    if (rows.length < REVIEW_PAGE) break;
  }
  return out.slice(0, cap);
}

const memberHeaders = (ctx: AdapterContext) => ({
  ...bearer(requireToken('github', ctx.memberToken)),
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
});

/** A write as the member. */
function write<T>(ctx: AdapterContext, method: 'POST' | 'PUT', path: string, body: unknown): Promise<T | null> {
  return providerJson<T>('github', { method, url: `${GITHUB_API}${path}`, headers: memberHeaders(ctx), body });
}

function lineThreads(rows: GithubComment[]): MergeReviewThread[] {
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  const threads = new Map<number, MergeReviewThread>();
  for (const row of sorted) {
    const root = row.in_reply_to_id ?? row.id;
    const thread = threads.get(root);
    if (thread) {
      thread.comments.push(threadComment(row));
    } else {
      threads.set(root, {
        id: String(root),
        path: row.path ?? null,
        line: row.line ?? row.original_line ?? null,
        side: row.side ?? null,
        resolved: false,
        comments: [threadComment(row)],
      });
    }
  }
  return [...threads.values()];
}

/** The id prefix of a general (conversation) thread. */
const GENERAL_THREAD = 'issue-';

const generalThread = (row: GithubComment): MergeReviewThread => ({
  id: `${GENERAL_THREAD}${row.id}`,
  path: null,
  line: null,
  side: null,
  resolved: false,
  comments: [threadComment(row)],
});

async function headSha(ctx: AdapterContext, repository: RepositoryRef, number: number): Promise<string> {
  const pull = await providerJson<{ head: { sha: string } }>('github', {
    method: 'GET',
    url: `${GITHUB_API}/repos/${repository.fullName}/pulls/${number}`,
    headers: memberHeaders(ctx),
  });
  return pull?.head.sha ?? '';
}

const REVIEW_EVENTS = { approve: 'APPROVE', request_changes: 'REQUEST_CHANGES', comment: 'COMMENT' } as const;

type CommentInput = Parameters<ReviewAdapter['comment']>[3];

/** A reply, or a new line comment anchored to the head commit. */
async function reviewComment(ctx: AdapterContext, repository: RepositoryRef, number: number, input: CommentInput) {
  const body: Record<string, unknown> = { body: input.body };
  if (input.inReplyToId) {
    body.in_reply_to = Number(input.inReplyToId);
  } else {
    Object.assign(body, {
      commit_id: await headSha(ctx, repository, number),
      path: input.path,
      line: input.line,
      side: input.side ?? 'RIGHT',
    });
  }
  const row = (await write<GithubComment>(ctx, 'POST', `/repos/${repository.fullName}/pulls/${number}/comments`, body))!;
  return { comment: threadComment(row), threadId: String(row.in_reply_to_id ?? row.id) };
}

export const githubReview: ReviewAdapter = {
  async listFiles(ctx, repository, number) {
    const rows = await collect<GithubFile>(ctx, `/repos/${repository.fullName}/pulls/${number}/files`, MAX_FILES);
    return rows.map(
      (f): MergePullRequestFile => ({
        path: f.filename,
        previousPath: f.previous_filename ?? null,
        status: fileStatus(f.status),
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? null,
      }),
    );
  },

  async listThreads(ctx, repository, number) {
    const [review, general] = await Promise.all([
      collect<GithubComment>(ctx, `/repos/${repository.fullName}/pulls/${number}/comments`, MAX_COMMENTS),
      collect<GithubComment>(ctx, `/repos/${repository.fullName}/issues/${number}/comments`, MAX_COMMENTS),
    ]);
    return [...lineThreads(review), ...general.map(generalThread)];
  },

  async submitReview(ctx, repository, number, input) {
    await write(ctx, 'POST', `/repos/${repository.fullName}/pulls/${number}/reviews`, {
      event: REVIEW_EVENTS[input.event],
      ...(input.body ? { body: input.body } : {}),
      ...(input.comments?.length
        ? { comments: input.comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })) }
        : {}),
    });
  },

  async comment(ctx, repository, number, input) {
    // GitHub has no threaded replies on conversation comments: a reply to a
    // general thread (`issue-<id>`) is a new issue comment, shown in that thread.
    const generalReply = input.inReplyToId?.startsWith(GENERAL_THREAD) ? input.inReplyToId : null;
    if (!generalReply && (input.inReplyToId || input.path)) return reviewComment(ctx, repository, number, input);
    const row = (await write<GithubComment>(ctx, 'POST', `/repos/${repository.fullName}/issues/${number}/comments`, { body: input.body }))!;
    return { comment: threadComment(row), threadId: generalReply ?? `${GENERAL_THREAD}${row.id}` };
  },

  async merge(ctx, repository, number, input) {
    await write(ctx, 'PUT', `/repos/${repository.fullName}/pulls/${number}/merge`, {
      merge_method: input.method,
      ...(input.commitTitle ? { commit_title: input.commitTitle } : {}),
      ...(input.commitMessage ? { commit_message: input.commitMessage } : {}),
    });
  },
};
