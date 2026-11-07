/**
 * Bitbucket Cloud's `ConnectionAdapter` over REST 2.0 (base
 * `https://api.bitbucket.org/2.0`). A repository's `externalId` is its uuid,
 * `fullName` is `workspace/slug`, `externalProject` the workspace slug.
 *
 *   GET /repositories?role=admin&pagelen=50                       (follows `next`)
 *   GET /repositories/{workspace}/{uuid}
 *   GET /repositories/{workspace}/{repo}/pullrequests?state=OPEN&pagelen=50
 *   GET /repositories/{workspace}/{repo}/pullrequests?state=MERGED&state=DECLINED&state=SUPERSEDED&sort=-updated_on&pagelen=50
 *   GET /repositories/{workspace}/{repo}/pullrequests/{id}
 *   GET /repositories/{workspace}/{repo}/commit/{sha}/statuses?pagelen=50
 *   POST /repositories/{workspace}/{repo}/hooks, DELETE .../hooks/{uuid}   (webhooks.ts)
 */

import {
  bitbucketChecksStatus,
  bitbucketReviewDecision,
  mapBitbucketPullRequest,
  type BitbucketCommitStatus,
  type BitbucketPullRequest,
} from '@weldsuite/merge-domain/providers/bitbucket';
import type { ConnectionAdapter, RemoteRepository } from '../types';
import {
  BACKFILL_CAP,
  BACKFILL_DAYS,
  BITBUCKET_PAGE,
  BITBUCKET_PAGES,
  bitbucketClient,
  repoPath,
  walkPages,
  type BitbucketRepository,
} from './client';
import { bitbucketWebhooks } from './webhooks';

function remoteRepository(repo: BitbucketRepository): RemoteRepository {
  return {
    externalId: repo.uuid,
    fullName: repo.full_name,
    private: repo.is_private !== false,
    defaultBranch: repo.mainbranch?.name ?? null,
    url: repo.links?.html?.href ?? null,
    externalProject: repo.workspace?.slug ?? repo.full_name.split('/')[0] ?? null,
  };
}

export const bitbucketConnection: ConnectionAdapter = {
  ...bitbucketWebhooks,

  async listAvailableRepositories(ctx) {
    const repos = await walkPages<BitbucketRepository>(
      bitbucketClient(ctx),
      `/repositories?role=admin&pagelen=${BITBUCKET_PAGE}`,
      BITBUCKET_PAGES,
      BITBUCKET_PAGE * BITBUCKET_PAGES,
    );
    return repos.map(remoteRepository);
  },

  async getRepository(ctx, externalId, externalProject) {
    if (!externalProject) return null;
    const repo = await bitbucketClient(ctx).get<BitbucketRepository>(
      `/repositories/${encodeURIComponent(externalProject)}/${encodeURIComponent(externalId)}`,
    );
    return repo ? remoteRepository(repo) : null;
  },

  async listPullRequestsForBackfill(ctx, repository, now = new Date()) {
    const client = bitbucketClient(ctx);
    const since = now.getTime() - BACKFILL_DAYS * 24 * 60 * 60 * 1000;
    const open = await walkPages<BitbucketPullRequest>(
      client,
      `${repoPath(repository)}/pullrequests?state=OPEN&pagelen=${BITBUCKET_PAGE}`,
      BITBUCKET_PAGES,
      BACKFILL_CAP,
    );
    const closed = await walkPages<BitbucketPullRequest>(
      client,
      `${repoPath(repository)}/pullrequests?state=MERGED&state=DECLINED&state=SUPERSEDED&sort=-updated_on&pagelen=${BITBUCKET_PAGE}`,
      BITBUCKET_PAGES,
      BACKFILL_CAP - open.length,
      (pr) => new Date(pr.updated_on).getTime() < since,
    );
    return [...open, ...closed].map(mapBitbucketPullRequest);
  },

  async getPullRequest(ctx, repository, number) {
    const pr = await bitbucketClient(ctx).get<BitbucketPullRequest>(`${repoPath(repository)}/pullrequests/${number}`);
    return pr ? mapBitbucketPullRequest(pr) : null;
  },

  async reviewDecision(ctx, repository, number) {
    const pr = await bitbucketClient(ctx).get<BitbucketPullRequest>(`${repoPath(repository)}/pullrequests/${number}`);
    return pr ? bitbucketReviewDecision(pr) : null;
  },

  async checksStatus(ctx, repository, headSha) {
    const statuses = await walkPages<BitbucketCommitStatus>(
      bitbucketClient(ctx),
      `${repoPath(repository)}/commit/${encodeURIComponent(headSha)}/statuses?pagelen=${BITBUCKET_PAGE}`,
      BITBUCKET_PAGES,
      BITBUCKET_PAGE * BITBUCKET_PAGES,
    );
    return bitbucketChecksStatus(statuses);
  },
};
