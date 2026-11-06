/**
 * WeldMerge phases 2 and 3 hooks: the GitHub install flow and OAuth connections,
 * the member's linked accounts, issue sync (import, create on the provider,
 * unlink) and the member's inbox state (read, snooze, archive).
 *
 * Keys sit under `weldmergeKeys` (use-weldmerge-queries.ts) so the realtime
 * sync map and the other hooks' invalidations reach them.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type {
  CreateMergeExternalIssueInput,
  UpdateMergeInboxItemInput,
} from '@weldsuite/app-api-client/schemas/weldmerge-sync';
import type {
  MergeAuthorizeUrlQuery,
  MergeAzureOrganizationInput,
  MergeGitlabTokenInput,
  MergeOauthAccountProvider,
  MergeOauthCallbackInput,
  MergeOauthConnectionProvider,
} from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import { weldmergeKeys } from './use-weldmerge-queries';

export type MergeInboxView = 'active' | 'snoozed' | 'archived';

const inboxViewKey = (view: MergeInboxView) => [...weldmergeKeys.inbox(), view] as const;

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

/**
 * The member's inbox: the live items, the snoozed ones, or the archived ones.
 * `?include=` adds to the live list rather than replacing it, and archived
 * items carry no flag, so the archived view is what `include=archived` adds,
 * and the snoozed view is the items that still have a wake-up time.
 */
export function useMergeInboxView(view: MergeInboxView = 'active') {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: inboxViewKey(view),
    queryFn: async () => {
      if (view === 'active') return (await weldmerge.inbox.list({})).data;
      if (view === 'snoozed') {
        return (await weldmerge.inbox.list({ include: 'snoozed' })).data.filter((item) => item.snoozedUntil !== null);
      }
      const [withArchived, live] = await Promise.all([weldmerge.inbox.list({ include: 'archived' }), weldmerge.inbox.list({})]);
      const liveIds = new Set(live.data.map((item) => item.id));
      return withArchived.data.filter((item) => !liveIds.has(item.id));
    },
  });
}

export function useUpdateMergeInboxItem() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ itemKey, input }: { itemKey: string; input: UpdateMergeInboxItemInput }) =>
      weldmerge.inbox.updateItem(itemKey, input).then((res) => res.data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldmergeKeys.inbox() }),
  });
}

export function useMarkAllMergeInboxRead() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => weldmerge.inbox.readAll().then((res) => res.data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldmergeKeys.inbox() }),
  });
}

// ---------------------------------------------------------------------------
// Connections (workspace)
// ---------------------------------------------------------------------------

function invalidateConnectionViews(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: weldmergeKeys.connections() });
  void queryClient.invalidateQueries({ queryKey: weldmergeKeys.repositories() });
}

/** The GitHub App install page. `returnTo` is a same-app relative path. */
export function useMergeGithubInstallUrl() {
  const { weldmerge } = useAppApi();
  return useMutation({
    mutationFn: (returnTo?: string) => weldmerge.connections.githubInstallUrl(returnTo).then((res) => res.data),
  });
}

/** The OAuth consent page of GitLab.com, Bitbucket or Azure DevOps for a workspace connection. */
export function useMergeConnectionAuthorizeUrl() {
  const { weldmerge } = useAppApi();
  return useMutation({
    mutationFn: ({ provider, returnTo }: { provider: MergeOauthConnectionProvider; returnTo?: string }) =>
      weldmerge.connections.authorizeUrl(provider, returnTo).then((res) => res.data),
  });
}

/** Self-managed GitLab: connect with a host and an access token. */
export function useConnectMergeGitlab() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MergeGitlabTokenInput) => weldmerge.connections.connectGitlab(input).then((res) => res.data),
    onSuccess: () => invalidateConnectionViews(queryClient),
  });
}

/** Azure DevOps with several organisations: choose the one the connection uses. */
export function useSetMergeAzureOrganization() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MergeAzureOrganizationInput) =>
      weldmerge.connections.setAzureOrganization(input).then((res) => res.data),
    onSuccess: () => invalidateConnectionViews(queryClient),
  });
}

/** Completes an OAuth round trip with what the provider redirected back with. */
export function useMergeOauthCallback() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MergeOauthCallbackInput) => weldmerge.oauth.callback(input).then((res) => res.data),
    onSuccess: () => {
      invalidateConnectionViews(queryClient);
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.accountsMe() });
    },
  });
}

// ---------------------------------------------------------------------------
// The member's own accounts
// ---------------------------------------------------------------------------

function invalidateAccountViews(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: weldmergeKeys.accountsMe() });
  // Review requests and authored pull requests are matched by login.
  void queryClient.invalidateQueries({ queryKey: weldmergeKeys.inbox() });
  void queryClient.invalidateQueries({ queryKey: weldmergeKeys.pullRequests() });
}

export function useMergeAccountAuthorizeUrl() {
  const { weldmerge } = useAppApi();
  return useMutation({
    mutationFn: ({ provider, ...params }: { provider: MergeOauthAccountProvider } & MergeAuthorizeUrlQuery) =>
      weldmerge.accounts.authorizeUrl(provider, params).then((res) => res.data),
  });
}

export function useLinkMergeGitlabToken() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MergeGitlabTokenInput) => weldmerge.accounts.linkGitlabToken(input).then((res) => res.data),
    onSuccess: () => invalidateAccountViews(queryClient),
  });
}

export function useUnlinkMergeAccount() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, host }: { provider: MergeOauthAccountProvider; host?: string | null }) =>
      weldmerge.accounts.unlink(provider, host ?? undefined),
    onSuccess: () => invalidateAccountViews(queryClient),
  });
}

// ---------------------------------------------------------------------------
// Issue sync
// ---------------------------------------------------------------------------

/** Imports a repository's open provider issues (up to 500) as WeldMerge issues. */
export function useImportMergeIssues() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (repositoryId: string) => weldmerge.repositories.importIssues(repositoryId).then((res) => res.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.issues() });
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.repositories() });
    },
  });
}

/** Creates the issue on the repository's provider and links it. */
export function useCreateMergeExternalIssue(issueId: string) {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMergeExternalIssueInput) =>
      weldmerge.issues.external.create(issueId, input).then((res) => res.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.issues() });
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.comments(issueId) });
    },
  });
}

/** Stops syncing the issue with the provider; the provider issue stays. */
export function useRemoveMergeExternalIssue(issueId: string) {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => weldmerge.issues.external.remove(issueId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldmergeKeys.issues() }),
  });
}
