/**
 * App-API WeldMerge domain client — `/api/merge/*` (merge-api; the same routes
 * in rust/modules/merge).
 *
 * Phase 1: teams, labels, cycles, issues and comments; GitHub connections,
 * repositories, the pull request mirror, the inbox and the member's provider
 * accounts. Phase 2: the GitHub App install flow, issue sync, inbox state.
 * Phase 3: OAuth connections and member accounts for GitLab, Bitbucket and
 * Azure DevOps. Phase 4: review and merge. Phase 5: releases, record links and
 * chat subscriptions.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import type {
  AddMergeRepositoryInput,
  ConnectMergeGithubResult,
  CreateMergeCommentInput,
  CreateMergeCycleInput,
  CreateMergeIssueInput,
  CreateMergeLabelInput,
  CreateMergeRecordLinkInput,
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
  MergeRecordLinkDto,
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
import type {
  CreateMergeExternalIssueInput,
  ListMergeInboxQuery,
  MergeExternalIssueResult,
  MergeImportIssuesResult,
  MergeInboxItemStateDto,
  MergeInboxReadAllResult,
  MergeInstallUrlDto,
  UpdateMergeInboxItemInput,
} from '../schemas/weldmerge-sync';
import type {
  MergeAuthorizeUrlDto,
  MergeAuthorizeUrlQuery,
  MergeAzureOrganizationInput,
  MergeGitlabTokenInput,
  MergeOauthCallbackInput,
  MergeOauthCallbackResult,
  MergeOauthConnectionProvider,
  MergeOauthAccountProvider,
} from '../schemas/weldmerge-providers';
import type {
  CreateMergePullRequestCommentInput,
  MergeMergePullRequestInput,
  MergePullRequestCommentResult,
  MergePullRequestFile,
  MergeReviewResult,
  MergeReviewThread,
  SubmitMergeReviewInput,
} from '../schemas/weldmerge-review';
import type {
  CreateMergeChatSubscriptionInput,
  CreateMergeReleaseInput,
  ListMergeChatSubscriptionsQuery,
  ListMergeRecordLinksQuery,
  ListMergeReleasesQuery,
  MergeChatSubscriptionDto,
  MergeGenerateNotesResult,
  MergePublishReleaseResult,
  MergeRecordLinkedIssue,
  MergeReleaseDetailDto,
  MergeReleaseDto,
  PublishMergeReleaseInput,
  UpdateMergeChatSubscriptionInput,
  UpdateMergeReleaseInput,
} from '../schemas/weldmerge-across';

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
      /** The provider issue this issue syncs with (GitHub, GitLab). */
      external: {
        /** Creates the issue on the repository's provider and links it. */
        create(issueId: string, input: CreateMergeExternalIssueInput): Promise<DataResponse<MergeExternalIssueResult>> {
          return api.post(`${base}/issues/${issueId}/external`, input);
        },
        /** Stops syncing; the provider issue stays. */
        remove(issueId: string): Promise<void> {
          return api.delete(`${base}/issues/${issueId}/external`);
        },
      },
      /** Links to tickets, companies and chat channels. */
      links: {
        list(issueId: string): Promise<ListResponse<MergeRecordLinkDto>> {
          return api.get(`${base}/issues/${issueId}/links`);
        },
        create(issueId: string, input: CreateMergeRecordLinkInput): Promise<DataResponse<MergeRecordLinkDto>> {
          return api.post(`${base}/issues/${issueId}/links`, input);
        },
        remove(issueId: string, linkId: string): Promise<void> {
          return api.delete(`${base}/issues/${issueId}/links/${linkId}`);
        },
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
      /** Changed files with their patches, live from the provider. */
      files(id: string): Promise<ListResponse<MergePullRequestFile>> {
        return api.get(`${base}/pull-requests/${id}/files`);
      },
      /** Review threads and general comments, live from the provider. */
      threads(id: string): Promise<ListResponse<MergeReviewThread>> {
        return api.get(`${base}/pull-requests/${id}/threads`);
      },
      /** Approve, request changes or comment, as the member's own linked account. */
      review(id: string, input: SubmitMergeReviewInput): Promise<DataResponse<MergeReviewResult>> {
        return api.post(`${base}/pull-requests/${id}/reviews`, input);
      },
      /** A general comment, a line comment or a reply, as the member's own linked account. */
      comment(
        id: string,
        input: CreateMergePullRequestCommentInput,
      ): Promise<DataResponse<MergePullRequestCommentResult>> {
        return api.post(`${base}/pull-requests/${id}/comments`, input);
      },
      /** Merges on the provider as the member, then re-reads the mirror. */
      merge(id: string, input: MergeMergePullRequestInput = {}): Promise<DataResponse<MergeReviewResult>> {
        return api.post(`${base}/pull-requests/${id}/merge`, input);
      },
    },

    inbox: {
      list(params: ListMergeInboxQuery = {}): Promise<ListResponse<MergeInboxItem>> {
        return api.get(`${base}/inbox${query({ include: params.include })}`);
      },
      /** Marks one item read or unread, snoozes it, or archives it. The member's own state only. */
      updateItem(itemKey: string, input: UpdateMergeInboxItemInput): Promise<DataResponse<MergeInboxItemStateDto>> {
        return api.patch(`${base}/inbox/items/${encodeURIComponent(itemKey)}`, input);
      },
      readAll(): Promise<DataResponse<MergeInboxReadAllResult>> {
        return api.post(`${base}/inbox/read-all`, {});
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
      /** The GitHub App install page; `returnTo` is a same-app relative path. */
      githubInstallUrl(returnTo?: string): Promise<DataResponse<MergeInstallUrlDto>> {
        return api.get(`${base}/connections/github/install-url${query({ returnTo })}`);
      },
      /** The provider's OAuth consent page for a workspace connection. */
      authorizeUrl(
        provider: MergeOauthConnectionProvider,
        returnTo?: string,
      ): Promise<DataResponse<MergeAuthorizeUrlDto>> {
        return api.get(`${base}/connections/${provider}/authorize-url${query({ returnTo })}`);
      },
      /** Self-managed GitLab: validates the token against `{host}/api/v4/user`. */
      connectGitlab(input: MergeGitlabTokenInput): Promise<DataResponse<MergeConnectionDto>> {
        return api.post(`${base}/connections/gitlab`, input);
      },
      /** Azure DevOps with more than one organisation: pick which one the connection uses. */
      setAzureOrganization(input: MergeAzureOrganizationInput): Promise<DataResponse<MergeConnectionDto>> {
        return api.post(`${base}/connections/azure_devops/organization`, input);
      },
    },

    oauth: {
      /** Called by the SPA page `/weldmerge/oauth/callback` with what the provider redirected back with. */
      callback(input: MergeOauthCallbackInput): Promise<DataResponse<MergeOauthCallbackResult>> {
        return api.post(`${base}/oauth/callback`, input);
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
      /** Imports the repository's open provider issues (up to 500) as WeldMerge issues. */
      importIssues(id: string): Promise<DataResponse<MergeImportIssuesResult>> {
        return api.post(`${base}/repositories/${id}/import-issues`, {});
      },
    },

    accounts: {
      me(): Promise<DataResponse<MergeProviderAccountsDto>> {
        return api.get(`${base}/accounts/me`);
      },
      updateMe(input: UpdateMyMergeAccountsInput): Promise<DataResponse<MergeProviderAccountsDto>> {
        return api.put(`${base}/accounts/me`, input);
      },
      /** The provider's consent page for linking the member's own account (`host`: self-managed GitLab). */
      authorizeUrl(
        provider: MergeOauthAccountProvider,
        params: MergeAuthorizeUrlQuery = {},
      ): Promise<DataResponse<MergeAuthorizeUrlDto>> {
        return api.get(
          `${base}/accounts/${provider}/authorize-url${query({ returnTo: params.returnTo, host: params.host })}`,
        );
      },
      /** Self-managed GitLab: link with a personal access token. */
      linkGitlabToken(input: MergeGitlabTokenInput): Promise<DataResponse<MergeProviderAccountsDto>> {
        return api.post(`${base}/accounts/gitlab-token`, input);
      },
      unlink(provider: MergeOauthAccountProvider, host?: string): Promise<void> {
        return api.delete(`${base}/accounts/${provider}${query({ host })}`);
      },
    },

    releases: {
      list(params: ListMergeReleasesQuery = {}): Promise<ListResponse<MergeReleaseDto>> {
        return api.get(
          `${base}/releases${query({
            teamId: params.teamId,
            repositoryId: params.repositoryId,
            status: params.status,
            limit: params.limit,
            cursor: params.cursor,
          })}`,
        );
      },
      get(id: string): Promise<DataResponse<MergeReleaseDetailDto>> {
        return api.get(`${base}/releases/${id}`);
      },
      create(input: CreateMergeReleaseInput): Promise<DataResponse<MergeReleaseDetailDto>> {
        return api.post(`${base}/releases`, input);
      },
      update(id: string, input: UpdateMergeReleaseInput): Promise<DataResponse<MergeReleaseDetailDto>> {
        return api.patch(`${base}/releases/${id}`, input);
      },
      remove(id: string): Promise<void> {
        return api.delete(`${base}/releases/${id}`);
      },
      /** Re-reads the merged pull requests between `baseRef` and `headRef` from the provider. */
      refresh(id: string): Promise<DataResponse<MergeReleaseDetailDto>> {
        return api.post(`${base}/releases/${id}/refresh`, {});
      },
      generateNotes(id: string): Promise<DataResponse<MergeGenerateNotesResult>> {
        return api.post(`${base}/releases/${id}/generate-notes`, {});
      },
      ship(id: string): Promise<DataResponse<MergeReleaseDetailDto>> {
        return api.post(`${base}/releases/${id}/ship`, {});
      },
      publish(id: string, input: PublishMergeReleaseInput): Promise<DataResponse<MergePublishReleaseResult>> {
        return api.post(`${base}/releases/${id}/publish`, input);
      },
    },

    recordLinks: {
      /** The issues linked to a ticket, company or chat channel. */
      list(params: ListMergeRecordLinksQuery): Promise<ListResponse<MergeRecordLinkedIssue>> {
        return api.get(
          `${base}/record-links${query({ recordType: params.recordType, recordId: params.recordId })}`,
        );
      },
    },

    chatSubscriptions: {
      list(params: ListMergeChatSubscriptionsQuery = {}): Promise<ListResponse<MergeChatSubscriptionDto>> {
        return api.get(
          `${base}/chat-subscriptions${query({ channelId: params.channelId, teamId: params.teamId })}`,
        );
      },
      create(input: CreateMergeChatSubscriptionInput): Promise<DataResponse<MergeChatSubscriptionDto>> {
        return api.post(`${base}/chat-subscriptions`, input);
      },
      update(id: string, input: UpdateMergeChatSubscriptionInput): Promise<DataResponse<MergeChatSubscriptionDto>> {
        return api.patch(`${base}/chat-subscriptions/${id}`, input);
      },
      remove(id: string): Promise<void> {
        return api.delete(`${base}/chat-subscriptions/${id}`);
      },
    },
  };
}

export type WeldMergeApi = ReturnType<typeof createWeldMergeApi>;
