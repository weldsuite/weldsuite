/**
 * App-API WeldMerge domain client — `/api/merge/*` (merge-api; the same routes
 * in rust/modules/merge).
 *
 * Phase 1: teams, labels, cycles, issues and comments; GitHub connections,
 * repositories, the pull request mirror, the inbox and the member's provider
 * accounts.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import type {
  AddMergeRepositoryInput,
  ConnectMergeGithubResult,
  CreateMergeCommentInput,
  CreateMergeCycleInput,
  CreateMergeIssueInput,
  CreateMergeLabelInput,
  CreateMergeTeamInput,
  LinkMergePullRequestInput,
  ListMergeIssuesQuery,
  ListMergePullRequestsQuery,
  MergeAvailableRepository,
  MergeCommentDto,
  MergeConnectionDto,
  MergeCycleDto,
  MergeInboxItem,
  MergeIssueDetailDto,
  MergeIssueDto,
  MergeLabelDto,
  MergeProviderAccountsDto,
  MergePullRequestDetailDto,
  MergePullRequestListItem,
  MergeRepositoryDto,
  MergeRepositorySyncResult,
  MergeTeamDto,
  UpdateMergeCommentInput,
  UpdateMergeCycleInput,
  UpdateMergeIssueInput,
  UpdateMergeLabelInput,
  UpdateMergeRepositoryInput,
  UpdateMergeTeamInput,
  UpdateMyMergeAccountsInput,
} from '../schemas/weldmerge';

const base = '/merge';

function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export function createWeldMergeApi(api: ClientApi) {
  return {
    teams: {
      list(): Promise<ListResponse<MergeTeamDto>> {
        return api.get(`${base}/teams`);
      },
      get(id: string): Promise<DataResponse<MergeTeamDto>> {
        return api.get(`${base}/teams/${id}`);
      },
      create(input: CreateMergeTeamInput): Promise<DataResponse<MergeTeamDto>> {
        return api.post(`${base}/teams`, input);
      },
      update(id: string, input: UpdateMergeTeamInput): Promise<DataResponse<MergeTeamDto>> {
        return api.patch(`${base}/teams/${id}`, input);
      },
      /** Refused (409) while the team still has issues. */
      remove(id: string): Promise<void> {
        return api.delete(`${base}/teams/${id}`);
      },
    },

    labels: {
      list(teamId?: string): Promise<ListResponse<MergeLabelDto>> {
        return api.get(`${base}/labels${query({ teamId })}`);
      },
      create(input: CreateMergeLabelInput): Promise<DataResponse<MergeLabelDto>> {
        return api.post(`${base}/labels`, input);
      },
      update(id: string, input: UpdateMergeLabelInput): Promise<DataResponse<MergeLabelDto>> {
        return api.patch(`${base}/labels/${id}`, input);
      },
      remove(id: string): Promise<void> {
        return api.delete(`${base}/labels/${id}`);
      },
    },

    cycles: {
      list(teamId?: string): Promise<ListResponse<MergeCycleDto>> {
        return api.get(`${base}/cycles${query({ teamId })}`);
      },
      create(input: CreateMergeCycleInput): Promise<DataResponse<MergeCycleDto>> {
        return api.post(`${base}/cycles`, input);
      },
      update(id: string, input: UpdateMergeCycleInput): Promise<DataResponse<MergeCycleDto>> {
        return api.patch(`${base}/cycles/${id}`, input);
      },
      /** Issues in the cycle keep their other fields and lose the cycle. */
      remove(id: string): Promise<void> {
        return api.delete(`${base}/cycles/${id}`);
      },
    },

    issues: {
      list(params: ListMergeIssuesQuery = {}): Promise<ListResponse<MergeIssueDto>> {
        return api.get(
          `${base}/issues${query({
            teamId: params.teamId,
            status: Array.isArray(params.status) ? params.status.join(',') : params.status,
            assignee: params.assignee,
            cycleId: params.cycleId,
            labelId: params.labelId,
            parentIssueId: params.parentIssueId,
            q: params.q,
            limit: params.limit,
            cursor: params.cursor,
          })}`,
        );
      },
      /** By id (`mis_…`) or key (`PLAT-209`). */
      get(idOrKey: string): Promise<DataResponse<MergeIssueDetailDto>> {
        return api.get(`${base}/issues/${encodeURIComponent(idOrKey)}`);
      },
      create(input: CreateMergeIssueInput): Promise<DataResponse<MergeIssueDto>> {
        return api.post(`${base}/issues`, input);
      },
      update(id: string, input: UpdateMergeIssueInput): Promise<DataResponse<MergeIssueDto>> {
        return api.patch(`${base}/issues/${id}`, input);
      },
      remove(id: string): Promise<void> {
        return api.delete(`${base}/issues/${id}`);
      },
      comments: {
        list(issueId: string): Promise<ListResponse<MergeCommentDto>> {
          return api.get(`${base}/issues/${issueId}/comments`);
        },
        create(issueId: string, input: CreateMergeCommentInput): Promise<DataResponse<MergeCommentDto>> {
          return api.post(`${base}/issues/${issueId}/comments`, input);
        },
      },
      linkPullRequest(issueId: string, input: LinkMergePullRequestInput): Promise<DataResponse<MergeIssueDetailDto>> {
        return api.post(`${base}/issues/${issueId}/pull-requests`, input);
      },
      unlinkPullRequest(issueId: string, pullRequestId: string): Promise<void> {
        return api.delete(`${base}/issues/${issueId}/pull-requests/${pullRequestId}`);
      },
    },

    comments: {
      update(id: string, input: UpdateMergeCommentInput): Promise<DataResponse<MergeCommentDto>> {
        return api.patch(`${base}/comments/${id}`, input);
      },
      remove(id: string): Promise<void> {
        return api.delete(`${base}/comments/${id}`);
      },
    },

    pullRequests: {
      list(params: ListMergePullRequestsQuery = {}): Promise<ListResponse<MergePullRequestListItem>> {
        return api.get(
          `${base}/pull-requests${query({
            view: params.view,
            repositoryId: params.repositoryId,
            teamId: params.teamId,
            q: params.q,
            limit: params.limit,
            cursor: params.cursor,
          })}`,
        );
      },
      get(id: string): Promise<DataResponse<MergePullRequestDetailDto>> {
        return api.get(`${base}/pull-requests/${id}`);
      },
    },

    inbox: {
      list(): Promise<ListResponse<MergeInboxItem>> {
        return api.get(`${base}/inbox`);
      },
    },

    connections: {
      list(): Promise<ListResponse<MergeConnectionDto>> {
        return api.get(`${base}/connections`);
      },
      /** Adopts the workspace's GitHub App installation, or says it needs installing first. */
      connectGithub(): Promise<DataResponse<ConnectMergeGithubResult>> {
        return api.post(`${base}/connections/github`, {});
      },
      /** Stops tracking the connection and its repositories; the GitHub App stays installed. */
      remove(id: string): Promise<void> {
        return api.delete(`${base}/connections/${id}`);
      },
      availableRepositories(id: string): Promise<ListResponse<MergeAvailableRepository>> {
        return api.get(`${base}/connections/${id}/available-repositories`);
      },
    },

    repositories: {
      list(): Promise<ListResponse<MergeRepositoryDto>> {
        return api.get(`${base}/repositories`);
      },
      /** Adds the repository and loads its open and recently merged pull requests. */
      add(input: AddMergeRepositoryInput): Promise<DataResponse<MergeRepositorySyncResult>> {
        return api.post(`${base}/repositories`, input);
      },
      update(id: string, input: UpdateMergeRepositoryInput): Promise<DataResponse<MergeRepositoryDto>> {
        return api.patch(`${base}/repositories/${id}`, input);
      },
      remove(id: string): Promise<void> {
        return api.delete(`${base}/repositories/${id}`);
      },
      /** Re-reads open and recently merged pull requests from the provider. */
      sync(id: string): Promise<DataResponse<MergeRepositorySyncResult>> {
        return api.post(`${base}/repositories/${id}/sync`, {});
      },
    },

    accounts: {
      me(): Promise<DataResponse<MergeProviderAccountsDto>> {
        return api.get(`${base}/accounts/me`);
      },
      updateMe(input: UpdateMyMergeAccountsInput): Promise<DataResponse<MergeProviderAccountsDto>> {
        return api.put(`${base}/accounts/me`, input);
      },
    },
  };
}

export type WeldMergeApi = ReturnType<typeof createWeldMergeApi>;
