/**
 * Azure DevOps' `ConnectionAdapter` over the Git REST API (`7.1`). Endpoints
 * (relative to the organisation URL `{org}`, every call carries
 * `api-version=7.1` except the policy one, `7.1-preview.1`):
 *
 *   GET {org}/_apis/git/repositories
 *   GET {org}/_apis/git/repositories/{repoId}
 *   GET {org}/{project}/_apis/git/repositories/{repoId}/pullrequests?searchCriteria.status=active&$top=100&$skip=N
 *   GET {org}/{project}/_apis/git/repositories/{repoId}/pullrequests?searchCriteria.status=completed|abandoned&searchCriteria.queryTimeRangeType=closed&searchCriteria.minTime=ISO&$top=100&$skip=N
 *   GET {org}/{project}/_apis/git/repositories/{repoId}/pullrequests/{id}
 *   GET {org}/{project}/_apis/git/repositories/{repoId}/pullRequests/{id}/statuses
 *   GET {org}/{project}/_apis/policy/evaluations?artifactId=vstfs:///CodeReview/CodeReviewId/{projectId}/{codeReviewId}
 *   GET {org}/{project}/_apis/git/repositories/{repoId}/commits/{sha}/statuses     (no pull request number)
 *   service hooks: webhooks.ts
 *
 * Azure DevOps has no "updated" time on a pull request, so a read is stamped
 * with the time it was made (`providerUpdatedAt`): Refresh always applies.
 */

import {
  azureBranchName,
  azureChecksStatus,
  azureReviewDecision,
  mapAzurePullRequest,
  type AzurePolicyEvaluation,
  type AzurePullRequest,
  type AzureStatus,
} from '@weldsuite/merge-domain/providers/azure-devops';
import type { ApiClient } from '../provider-http';
import type { AdapterContext, ConnectionAdapter, RemoteRepository, RepositoryRef } from '../types';
import {
  API_VERSION,
  AZURE_PAGE,
  AZURE_PAGES,
  BACKFILL_CAP,
  BACKFILL_DAYS,
  azureClient,
  azureOrganizationBase,
  azureRepoPath,
  type AzureList,
  type AzureRepository,
} from './client';
import { azureWebhooks } from './webhooks';

function remoteRepository(repo: AzureRepository): RemoteRepository {
  const project = repo.project?.name ?? '';
  return {
    externalId: repo.id,
    fullName: `${project}/${repo.name}`,
    private: repo.project?.visibility !== 'public',
    defaultBranch: azureBranchName(repo.defaultBranch),
    url: repo.webUrl ?? null,
    externalProject: project || null,
  };
}

const mapOptions = (ctx: AdapterContext) => ({ organizationUrl: azureOrganizationBase(ctx), updatedAt: new Date() });

async function pullRequestPage(
  client: ApiClient,
  repository: RepositoryRef,
  criteria: string,
  skip: number,
): Promise<AzurePullRequest[]> {
  const body = await client.get<AzureList<AzurePullRequest>>(
    `${azureRepoPath(repository)}/pullrequests?${criteria}&$top=${AZURE_PAGE}&$skip=${skip}&${API_VERSION}`,
  );
  return body?.value ?? [];
}

async function pullRequestsFor(client: ApiClient, repository: RepositoryRef, criteria: string, cap: number): Promise<AzurePullRequest[]> {
  const out: AzurePullRequest[] = [];
  for (let page = 0; page < AZURE_PAGES && out.length < cap; page++) {
    const rows = await pullRequestPage(client, repository, criteria, page * AZURE_PAGE);
    out.push(...rows);
    if (rows.length < AZURE_PAGE) break;
  }
  return out.slice(0, cap);
}

async function pullRequestChecks(client: ApiClient, repository: RepositoryRef, number: number) {
  const base = azureRepoPath(repository);
  const pr = await client.get<AzurePullRequest>(`${base}/pullrequests/${number}?${API_VERSION}`);
  if (!pr) return null;
  const statuses = await client.get<AzureList<AzureStatus>>(`${base}/pullRequests/${number}/statuses?${API_VERSION}`);
  const projectId = pr.repository?.project?.id;
  const project = encodeURIComponent(repository.externalProject ?? repository.fullName.split('/')[0] ?? '');
  let evaluations: AzurePolicyEvaluation[] = [];
  if (projectId) {
    const artifact = encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${projectId}/${pr.codeReviewId ?? number}`);
    const body = await client.get<AzureList<AzurePolicyEvaluation>>(
      `/${project}/_apis/policy/evaluations?artifactId=${artifact}&api-version=7.1-preview.1`,
    );
    evaluations = body?.value ?? [];
  }
  return azureChecksStatus(statuses?.value ?? [], evaluations);
}

export const azureConnection: ConnectionAdapter = {
  ...azureWebhooks,

  async listAvailableRepositories(ctx) {
    const body = await azureClient(ctx).get<AzureList<AzureRepository>>(`/_apis/git/repositories?${API_VERSION}`);
    return (body?.value ?? []).filter((repo) => repo.isDisabled !== true).map(remoteRepository);
  },

  async getRepository(ctx, externalId) {
    const repo = await azureClient(ctx).get<AzureRepository>(`/_apis/git/repositories/${encodeURIComponent(externalId)}?${API_VERSION}`);
    return repo ? remoteRepository(repo) : null;
  },

  async listPullRequestsForBackfill(ctx, repository, now = new Date()) {
    const client = azureClient(ctx);
    const since = encodeURIComponent(new Date(now.getTime() - BACKFILL_DAYS * 24 * 60 * 60 * 1000).toISOString());
    const out: AzurePullRequest[] = [];
    const passes = [
      'searchCriteria.status=active',
      `searchCriteria.status=completed&searchCriteria.queryTimeRangeType=closed&searchCriteria.minTime=${since}`,
      `searchCriteria.status=abandoned&searchCriteria.queryTimeRangeType=closed&searchCriteria.minTime=${since}`,
    ];
    for (const criteria of passes) {
      if (out.length >= BACKFILL_CAP) break;
      out.push(...(await pullRequestsFor(client, repository, criteria, BACKFILL_CAP - out.length)));
    }
    const options = { organizationUrl: azureOrganizationBase(ctx), updatedAt: now };
    return out.map((pr) => mapAzurePullRequest(pr, options));
  },

  async getPullRequest(ctx, repository, number) {
    const pr = await azureClient(ctx).get<AzurePullRequest>(`${azureRepoPath(repository)}/pullrequests/${number}?${API_VERSION}`);
    return pr ? mapAzurePullRequest(pr, mapOptions(ctx)) : null;
  },

  async reviewDecision(ctx, repository, number) {
    const pr = await azureClient(ctx).get<AzurePullRequest>(`${azureRepoPath(repository)}/pullrequests/${number}?${API_VERSION}`);
    return pr ? azureReviewDecision(pr.reviewers) : null;
  },

  async checksStatus(ctx, repository, headSha, pullRequestNumber) {
    const client = azureClient(ctx);
    if (pullRequestNumber !== undefined) return pullRequestChecks(client, repository, pullRequestNumber);
    const body = await client.get<AzureList<AzureStatus>>(
      `${azureRepoPath(repository)}/commits/${encodeURIComponent(headSha)}/statuses?${API_VERSION}`,
    );
    return azureChecksStatus(body?.value ?? [], []);
  },
};
