/**
 * GitHub's `ConnectionAdapter`: the existing `github-client.ts` functions behind
 * the provider seam. Installation tokens are minted per call (the GitHub App),
 * so the connection's `credentials` stays null; webhooks are the App's, not
 * registered per repository, so there is no `registerWebhook` here.
 */

import {
  combineCheckSuites,
  mapGithubPullRequest,
  reviewDecisionFromReviews,
  type GithubPullRequest,
} from '@weldsuite/merge-domain/github';
import {
  createGithubClient,
  getRepositoryById,
  listCheckSuites,
  listInstallationRepositories,
  listPullRequestReviews,
  listPullRequestsForBackfill,
  type GithubRepository,
} from '../../github-client';
import type { AdapterContext, ConnectionAdapter, RemoteRepository } from '../types';

const clientFor = (ctx: AdapterContext) => createGithubClient(ctx.env, ctx.connection.externalAccountId);

function remoteRepository(repo: GithubRepository): RemoteRepository {
  return {
    externalId: String(repo.id),
    fullName: repo.full_name,
    private: repo.private,
    defaultBranch: repo.default_branch ?? null,
    url: repo.html_url ?? null,
    externalProject: null,
  };
}

export const githubConnection: ConnectionAdapter = {
  async listAvailableRepositories(ctx) {
    return (await listInstallationRepositories(clientFor(ctx))).map(remoteRepository);
  },

  async getRepository(ctx, externalId) {
    const repo = await getRepositoryById(clientFor(ctx), externalId);
    return repo ? remoteRepository(repo) : null;
  },

  async listPullRequestsForBackfill(ctx, repository, now) {
    const pulls = await listPullRequestsForBackfill(clientFor(ctx), repository.fullName, now);
    return pulls.map(mapGithubPullRequest);
  },

  async getPullRequest(ctx, repository, number) {
    const pull = await clientFor(ctx).get<GithubPullRequest>(`/repos/${repository.fullName}/pulls/${number}`);
    return pull ? mapGithubPullRequest(pull) : null;
  },

  async reviewDecision(ctx, repository, number) {
    const client = clientFor(ctx);
    const pull = await client.get<GithubPullRequest>(`/repos/${repository.fullName}/pulls/${number}`);
    if (!pull) return null;
    const reviews = await listPullRequestReviews(client, repository.fullName, number);
    return reviewDecisionFromReviews(reviews, mapGithubPullRequest(pull).requestedReviewers.length);
  },

  async checksStatus(ctx, repository, headSha) {
    return combineCheckSuites(await listCheckSuites(clientFor(ctx), repository.fullName, headSha));
  },
};
