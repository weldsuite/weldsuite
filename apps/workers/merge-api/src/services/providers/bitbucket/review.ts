/**
 * Bitbucket Cloud's `ReviewAdapter` (phase 4). `repository.fullName` is
 * `workspace/slug`; a thread is a root comment and its replies. A merge the
 * provider refuses (400, 555) is raised as a 409 so the service answers
 * `not_mergeable`.
 */

import type {
  MergeFileStatus,
  MergePullRequestFile,
  MergeReviewThread,
  MergeThreadComment,
} from '@weldsuite/app-api-client/schemas/weldmerge-review';
import {
  bearer,
  diffSide,
  MAX_COMMENTS,
  MAX_FILES,
  providerJson,
  providerText,
  REVIEW_PAGE,
  requireToken,
  splitUnifiedDiff,
} from '../review-http';
import { ProviderApiError, type AdapterContext, type RepositoryRef, type ReviewAdapter } from '../types';

const API = 'https://api.bitbucket.org/2.0';

interface Page<T> {
  values?: T[];
  next?: string;
}

interface BitbucketDiffstat {
  status: string;
  lines_added: number;
  lines_removed: number;
  old?: { path: string } | null;
  new?: { path: string } | null;
}

interface BitbucketComment {
  id: number;
  content?: { raw?: string };
  user?: { nickname?: string; display_name?: string; links?: { avatar?: { href?: string } } } | null;
  created_on: string;
  deleted?: boolean;
  parent?: { id: number } | null;
  inline?: { path: string; from?: number | null; to?: number | null } | null;
  resolution?: unknown;
  links?: { html?: { href?: string } };
}

const prUrl = (repository: RepositoryRef, number: number) => `${API}/repositories/${repository.fullName}/pullrequests/${number}`;

function call<T>(ctx: AdapterContext, method: 'GET' | 'POST', url: string, body?: unknown): Promise<T | null> {
  return providerJson<T>('bitbucket', { method, url, headers: bearer(requireToken('bitbucket', ctx.memberToken)), body });
}

/** Follows `next` links until the pages run out or `cap` rows are read. */
async function collect<T>(ctx: AdapterContext, firstUrl: string, cap: number): Promise<T[]> {
  const out: T[] = [];
  let url: string | undefined = firstUrl;
  while (url && out.length < cap) {
    const page: Page<T> | null = await call<Page<T>>(ctx, 'GET', url);
    out.push(...(page?.values ?? []));
    url = page?.next;
  }
  return out.slice(0, cap);
}

const STATUSES: Record<string, MergeFileStatus> = { added: 'added', removed: 'removed', modified: 'modified', renamed: 'renamed' };

function threadComment(row: BitbucketComment): MergeThreadComment {
  const user = row.user;
  return {
    id: String(row.id),
    body: row.content?.raw ?? '',
    author: user ? { login: user.nickname ?? user.display_name ?? 'unknown', avatarUrl: user.links?.avatar?.href ?? null } : null,
    createdAt: row.created_on,
    url: row.links?.html?.href ?? null,
  };
}

function buildThreads(rows: BitbucketComment[]): MergeReviewThread[] {
  const live = rows.filter((r) => !r.deleted).sort((a, b) => a.created_on.localeCompare(b.created_on) || a.id - b.id);
  const threads = new Map<number, MergeReviewThread>();
  for (const row of live) {
    const root = row.parent?.id ?? row.id;
    const thread = threads.get(root);
    if (thread) {
      thread.comments.push(threadComment(row));
      continue;
    }
    const line = row.inline ? (row.inline.to ?? row.inline.from ?? null) : null;
    threads.set(root, {
      id: String(root),
      path: row.inline?.path ?? null,
      line,
      side: diffSide(row.inline?.to, row.inline?.from),
      resolved: Boolean(row.resolution),
      comments: [threadComment(row)],
    });
  }
  return [...threads.values()];
}

function postComment(ctx: AdapterContext, repository: RepositoryRef, number: number, body: Record<string, unknown>) {
  return call<BitbucketComment>(ctx, 'POST', `${prUrl(repository, number)}/comments`, body);
}

const MERGE_STRATEGIES = { merge: 'merge_commit', squash: 'squash', rebase: 'rebase_fast_forward' } as const;

type SubmitInput = Parameters<ReviewAdapter['submitReview']>[3];

export const bitbucketReview: ReviewAdapter = {
  async listFiles(ctx, repository, number) {
    const [stats, diff] = await Promise.all([
      collect<BitbucketDiffstat>(ctx, `${prUrl(repository, number)}/diffstat?pagelen=${REVIEW_PAGE}`, MAX_FILES),
      providerText('bitbucket', { method: 'GET', url: `${prUrl(repository, number)}/diff`, headers: bearer(requireToken('bitbucket', ctx.memberToken)) }),
    ]);
    const patches = splitUnifiedDiff(diff);
    return stats.map((s): MergePullRequestFile => {
      const path = s.new?.path ?? s.old?.path ?? '';
      return {
        path,
        previousPath: s.status === 'renamed' ? (s.old?.path ?? null) : null,
        status: STATUSES[s.status] ?? 'changed',
        additions: s.lines_added,
        deletions: s.lines_removed,
        patch: patches.get(path) ?? null,
      };
    });
  },

  async listThreads(ctx, repository, number) {
    return buildThreads(await collect<BitbucketComment>(ctx, `${prUrl(repository, number)}/comments?pagelen=${REVIEW_PAGE}`, MAX_COMMENTS));
  },

  async submitReview(ctx, repository, number, input: SubmitInput) {
    if (input.body) await postComment(ctx, repository, number, { content: { raw: input.body } });
    for (const c of input.comments ?? []) {
      await postComment(ctx, repository, number, {
        content: { raw: c.body },
        inline: { path: c.path, ...(c.side === 'LEFT' ? { from: c.line } : { to: c.line }) },
      });
    }
    if (input.event === 'approve') await call(ctx, 'POST', `${prUrl(repository, number)}/approve`);
    if (input.event === 'request_changes') await call(ctx, 'POST', `${prUrl(repository, number)}/request-changes`);
  },

  async comment(ctx, repository, number, input) {
    const body: Record<string, unknown> = { content: { raw: input.body } };
    if (input.inReplyToId) body.parent = { id: Number(input.inReplyToId) };
    else if (input.path && input.line) body.inline = { path: input.path, ...(input.side === 'LEFT' ? { from: input.line } : { to: input.line }) };
    const row = (await postComment(ctx, repository, number, body))!;
    return { comment: threadComment(row), threadId: String(row.parent?.id ?? row.id) };
  },

  async merge(ctx, repository, number, input) {
    const message = [input.commitTitle, input.commitMessage].filter(Boolean).join('\n\n');
    try {
      await call(ctx, 'POST', `${prUrl(repository, number)}/merge`, {
        type: 'pullrequest',
        merge_strategy: MERGE_STRATEGIES[input.method],
        ...(message ? { message } : {}),
      });
    } catch (err) {
      if (err instanceof ProviderApiError && (err.status === 400 || err.status === 555)) {
        throw new ProviderApiError('bitbucket', 409, err.message);
      }
      throw err;
    }
  },
};
