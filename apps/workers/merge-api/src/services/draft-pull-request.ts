/**
 * `merge_open_draft_pull_request` (WeldAgent): commits files to a new branch
 * through GitHub's Git Data API and opens a draft pull request. GitHub only.
 *
 * The calls, in order (the Rust port makes the same ones, the conformance suite
 * compares them): read the base branch's sha, read its commit for the tree, one
 * blob per file, a tree on top of the base tree, a commit, the branch ref, the
 * pull request. They go out with the installation token, so GitHub shows the
 * WeldSuite App as the author; the member who asked is named in the commit
 * message by the caller. The mirror row arrives with GitHub's `pull_request`
 * webhook like any other pull request.
 */

import { getGithubInstallationToken } from '@weldsuite/connect-domain/github/app-auth';
import type { MergeDraftPullRequestInput } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import { GITHUB_API, GithubNotConfiguredError, type GithubEnv } from './github-client';
import type { MergeRepositoryRow } from './db';

export class DraftPullRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'DraftPullRequestError';
  }
}

export interface DraftPullRequestResult {
  number: number;
  url: string;
  branch: string;
  baseBranch: string;
  draft: true;
}

/** A conservative subset of what git accepts as a branch name. */
export const BRANCH_NAME = /^(?!\/)(?!.*\.\.)(?!.*\/\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]+$/;

async function github<T>(token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'WeldSuite-WeldMerge',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const detail = ((await res.json().catch(() => null)) as { message?: string } | null)?.message;
    const reason = detail ? `: ${detail}` : '';
    throw new DraftPullRequestError(`GitHub answered ${res.status} for ${method} ${path.split('?')[0]}${reason}`, res.status);
  }
  return (await res.json()) as T;
}

export async function openDraftPullRequest(
  env: GithubEnv,
  installationId: string,
  repository: Pick<MergeRepositoryRow, 'fullName' | 'defaultBranch'>,
  input: MergeDraftPullRequestInput,
): Promise<DraftPullRequestResult> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new GithubNotConfiguredError();
  if (!BRANCH_NAME.test(input.branch)) throw new DraftPullRequestError(`"${input.branch}" is not a usable branch name`);
  const baseBranch = input.baseBranch?.trim() || repository.defaultBranch || 'main';
  const repo = `/repos/${repository.fullName}`;
  const token = await getGithubInstallationToken(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, Number(installationId));

  const ref = await github<{ object: { sha: string } }>(token, 'GET', `${repo}/git/ref/heads/${baseBranch}`);
  const baseSha = ref.object.sha;
  const baseCommit = await github<{ tree: { sha: string } }>(token, 'GET', `${repo}/git/commits/${baseSha}`);

  const entries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = [];
  for (const file of input.files) {
    const blob = await github<{ sha: string }>(token, 'POST', `${repo}/git/blobs`, { content: file.content, encoding: 'utf-8' });
    entries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const tree = await github<{ sha: string }>(token, 'POST', `${repo}/git/trees`, { base_tree: baseCommit.tree.sha, tree: entries });
  const commit = await github<{ sha: string }>(token, 'POST', `${repo}/git/commits`, {
    message: input.commitMessage,
    tree: tree.sha,
    parents: [baseSha],
  });
  await github(token, 'POST', `${repo}/git/refs`, { ref: `refs/heads/${input.branch}`, sha: commit.sha });

  const issueKey = input.issueKey?.trim();
  const text = input.body ?? '';
  const separator = text ? '\n\n' : '';
  const body = issueKey && !text.includes(issueKey) ? `${text}${separator}Refs ${issueKey}` : text;
  const pull = await github<{ number: number; html_url: string }>(token, 'POST', `${repo}/pulls`, {
    title: input.title,
    head: input.branch,
    base: baseBranch,
    body,
    draft: true,
  });
  return { number: pull.number, url: pull.html_url, branch: input.branch, baseBranch, draft: true };
}
