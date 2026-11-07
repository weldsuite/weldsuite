/** Azure DevOps payload builders for merge-api's tests (Git REST 7.1 and service hooks), on top of `fake-http.ts`. */

export const AZURE_ORG = 'dev.azure.com/acme';
export const AZURE_ORG_URL = 'https://dev.azure.com/acme';

export const AZURE_REPO = {
  id: 'repo-guid-1',
  name: 'web',
  isDisabled: false,
  defaultBranch: 'refs/heads/main',
  webUrl: 'https://dev.azure.com/acme/Platform/_git/web',
  project: { id: 'proj-guid-1', name: 'Platform', visibility: 'private' },
};

export interface AzurePrFixture {
  id: number;
  title?: string;
  status?: 'active' | 'completed' | 'abandoned';
  author?: string;
  closedDate?: string | null;
  /** `[uniqueName, vote]` pairs. */
  reviewers?: Array<[string, number]>;
  sha?: string;
  source?: string;
}

export function azurePr(f: AzurePrFixture) {
  const branch = f.source ?? `feature/${f.id}`;
  return {
    pullRequestId: f.id,
    codeReviewId: f.id,
    status: f.status ?? 'active',
    createdBy: { displayName: 'Octo Dev', uniqueName: f.author ?? 'Octo-Dev@acme.com', imageUrl: 'https://az.example/octo' },
    creationDate: '2026-10-30T09:00:00Z',
    closedDate: f.closedDate ?? null,
    title: f.title ?? `Pull request ${f.id}`,
    description: '',
    sourceRefName: `refs/heads/${branch}`,
    targetRefName: 'refs/heads/main',
    isDraft: false,
    lastMergeSourceCommit: { commitId: f.sha ?? `sha${f.id}` },
    repository: { id: AZURE_REPO.id, name: 'web', project: { id: 'proj-guid-1', name: 'Platform' } },
    reviewers: (f.reviewers ?? []).map(([uniqueName, vote]) => ({ displayName: uniqueName, uniqueName, vote, imageUrl: null })),
    labels: [],
  };
}

/** A service hook delivery for a pull request event. */
export function azurePrHook(f: AzurePrFixture, eventType = 'git.pullrequest.updated', createdDate = '2026-11-01T10:00:00.000Z') {
  return {
    eventType,
    createdDate,
    resource: { ...azurePr(f), url: `https://dev.azure.com/acme/proj-guid-1/_apis/git/repositories/repo-guid-1/pullRequests/${f.id}` },
    resourceContainers: { collection: { baseUrl: 'https://dev.azure.com/acme/' } },
  };
}
