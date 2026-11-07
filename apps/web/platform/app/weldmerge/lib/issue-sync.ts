import type { MergeIssueSyncMode, MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';

/** The issue sync modes a provider supports (mirrors merge-api's `ISSUE_SYNC_MODES_BY_PROVIDER`). */
export const ISSUE_SYNC_MODES_BY_PROVIDER: Record<MergeProvider, readonly MergeIssueSyncMode[]> = {
  github: ['off', 'import', 'two_way'],
  gitlab: ['off', 'import', 'two_way'],
  bitbucket: ['off'],
  azure_devops: ['off'],
};

/** True when the provider can sync issues at all (GitHub and GitLab). */
export function supportsIssueSync(provider: MergeProvider): boolean {
  return ISSUE_SYNC_MODES_BY_PROVIDER[provider].length > 1;
}

/** `Bitbucket workspace`, `Azure project` and GitLab namespace come back as `externalProject`. */
export function repositoryProjectLabel(repo: { externalProject: string | null; provider: MergeProvider }): string | null {
  if (repo.provider !== 'bitbucket' && repo.provider !== 'azure_devops') return null;
  return repo.externalProject;
}
