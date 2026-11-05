/**
 * GitHub REST access for merge-api. Installation tokens are minted per call
 * through the one shared helper (@weldsuite/connect-domain/github/app-auth, the
 * same GitHub App as connect-api); nothing long-lived is stored.
 */

import { getGithubInstallationToken } from '@weldsuite/connect-domain/github/app-auth';
import type { GithubCheckSuite, GithubPullRequest, GithubReview } from '@weldsuite/merge-domain/github';

export const GITHUB_API = 'https://api.github.com';

export class GithubNotConfiguredError extends Error {
  constructor() {
    super('GitHub App credentials are not configured on this worker');
    this.name = 'GithubNotConfiguredError';
  }
}

export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`GitHub ${path} answered ${status}`);
    this.name = 'GithubApiError';
  }
}

export interface GithubEnv {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
}

export interface GithubRepository {
  id: number;
  full_name: string;
  private: boolean;
  default_branch?: string | null;
  html_url?: string | null;
}

export interface GithubClient {
  /** The parsed JSON body, or null on a 404. */
  get<T>(path: string): Promise<T | null>;
}

/** A client for one installation; the token is minted on first use. */
export function createGithubClient(env: GithubEnv, installationId: string): GithubClient {
  let token: Promise<string> | null = null;
  return {
    async get<T>(path: string): Promise<T | null> {
      if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new GithubNotConfiguredError();
      token ??= getGithubInstallationToken(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, Number(installationId));
      const res = await fetch(`${GITHUB_API}${path}`, {
        headers: {
          Authorization: `Bearer ${await token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'WeldSuite-WeldMerge',
        },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new GithubApiError(res.status, path.split('?')[0] ?? path);
      return (await res.json()) as T;
    },
  };
}

const PAGE = 100;

/** Repositories the installation can see, up to 500. */
export async function listInstallationRepositories(client: GithubClient): Promise<GithubRepository[]> {
  const out: GithubRepository[] = [];
  for (let page = 1; page <= 5; page++) {
    const body = await client.get<{ repositories?: GithubRepository[] }>(`/installation/repositories?per_page=${PAGE}&page=${page}`);
    const repos = body?.repositories ?? [];
    out.push(...repos);
    if (repos.length < PAGE) break;
  }
  return out;
}

/** One repository by its provider id, or null when the installation cannot see it. */
export function getRepositoryById(client: GithubClient, externalId: string): Promise<GithubRepository | null> {
  return client.get<GithubRepository>(`/repositories/${encodeURIComponent(externalId)}`);
}

const BACKFILL_DAYS = 30;
const BACKFILL_CAP = 300;

/**
 * Open pull requests, and those closed or merged in the last 30 days, newest
 * update first, at most ~300 in all. (The list leaves out additions,
 * deletions and changed files; `mergeMirrorUpdate` keeps what is stored.)
 */
export async function listPullRequestsForBackfill(client: GithubClient, fullName: string, now = new Date()): Promise<GithubPullRequest[]> {
  const since = now.getTime() - BACKFILL_DAYS * 24 * 60 * 60 * 1000;
  const out: GithubPullRequest[] = [];
  let taken = 0;

  for (const state of ['open', 'closed'] as const) {
    pages: for (let page = 1; taken < BACKFILL_CAP; page++) {
      const rows =
        (await client.get<GithubPullRequest[]>(
          `/repos/${fullName}/pulls?state=${state}&sort=updated&direction=desc&per_page=${PAGE}&page=${page}`,
        )) ?? [];
      for (const pr of rows) {
        if (state === 'closed' && new Date(pr.updated_at).getTime() < since) break pages;
        out.push(pr);
        if (++taken >= BACKFILL_CAP) break pages;
      }
      if (rows.length < PAGE) break;
    }
  }
  return out;
}

export async function listPullRequestReviews(client: GithubClient, fullName: string, number: number): Promise<GithubReview[]> {
  return (await client.get<GithubReview[]>(`/repos/${fullName}/pulls/${number}/reviews?per_page=${PAGE}`)) ?? [];
}

export async function listCheckSuites(client: GithubClient, fullName: string, sha: string): Promise<GithubCheckSuite[]> {
  const body = await client.get<{ check_suites?: GithubCheckSuite[] }>(
    `/repos/${fullName}/commits/${encodeURIComponent(sha)}/check-suites?per_page=${PAGE}`,
  );
  return body?.check_suites ?? [];
}
