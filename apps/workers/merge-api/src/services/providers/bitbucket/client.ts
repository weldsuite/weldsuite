/**
 * Bitbucket Cloud REST 2.0 access. The token is on the context (`memberToken`,
 * put there by `adapterContext`). Repositories are addressed by their
 * `workspace/repo-slug` full name; the list endpoints page through absolute
 * `next` URLs.
 */

import { bearerAuth, createApiClient, type ApiClient } from '../provider-http';
import type { AdapterContext, RepositoryRef } from '../types';

export const BITBUCKET_API = 'https://api.bitbucket.org/2.0';
export const BITBUCKET_PAGE = 50;
export const BITBUCKET_PAGES = 6;
export const BACKFILL_DAYS = 30;
export const BACKFILL_CAP = 300;

export function bitbucketClient(ctx: AdapterContext): ApiClient {
  return createApiClient('bitbucket', BITBUCKET_API, bearerAuth('bitbucket', ctx));
}

export const repoPath = (repository: Pick<RepositoryRef, 'fullName'>): string => `/repositories/${repository.fullName}`;

export interface BitbucketPage<T> {
  values?: T[];
  next?: string;
}

export interface BitbucketRepository {
  uuid: string;
  full_name: string;
  is_private?: boolean;
  mainbranch?: { name?: string | null } | null;
  links?: { html?: { href?: string | null } | null } | null;
  workspace?: { slug?: string | null } | null;
}

/**
 * Walks a paginated list: the first path, then each page's `next`, at most
 * `maxPages` pages; `stop` ends the walk early (a row older than the window).
 */
export async function walkPages<T>(
  client: ApiClient,
  firstPath: string,
  maxPages: number,
  cap: number,
  stop?: (row: T) => boolean,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = firstPath;
  for (let page = 0; next && page < maxPages && out.length < cap; page++) {
    const body: BitbucketPage<T> | null = await client.get<BitbucketPage<T>>(next);
    for (const row of body?.values ?? []) {
      if (stop?.(row)) return out;
      out.push(row);
      if (out.length >= cap) return out;
    }
    next = body?.next;
  }
  return out;
}
