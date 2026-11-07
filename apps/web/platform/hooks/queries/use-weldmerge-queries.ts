/**
 * WeldMerge hooks: teams, labels, cycles, issues and comments, the pull request
 * mirror, the inbox, git provider connections, repositories and the member's
 * provider accounts.
 *
 * Every key sits under `weldmergeKeys.all`, the root the realtime sync map
 * invalidates for the `merge_*` entity events (lib/realtime/sync-map.ts), so any
 * change made elsewhere refetches whatever is mounted.
 *
 * Moving an issue on the board is optimistic: the cached issue lists change at
 * once and roll back if the write fails.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type {
  AddMergeRepositoryInput,
  CreateMergeCommentInput,
  CreateMergeCycleInput,
  CreateMergeIssueInput,
  CreateMergeLabelInput,
  CreateMergeTeamInput,
  LinkMergePullRequestInput,
  ListMergeIssuesQuery,
  ListMergePullRequestsQuery,
  MergeIssueDto,
  UpdateMergeCommentInput,
  UpdateMergeCycleInput,
  UpdateMergeIssueInput,
  UpdateMergeLabelInput,
  UpdateMergeRepositoryInput,
  UpdateMergeTeamInput,
  UpdateMyMergeAccountsInput,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import type { BoardMove } from '@/app/weldmerge/lib/board';

export const weldmergeKeys = {
  all: ['weldmerge'] as const,
  teams: () => [...weldmergeKeys.all, 'teams'] as const,
  labels: (teamId?: string) => [...weldmergeKeys.all, 'labels', teamId ?? 'all'] as const,
  cycles: (teamId?: string) => [...weldmergeKeys.all, 'cycles', teamId ?? 'all'] as const,
  issues: () => [...weldmergeKeys.all, 'issues'] as const,
  issueLists: () => [...weldmergeKeys.issues(), 'list'] as const,
  issueList: (params: ListMergeIssuesQuery) => [...weldmergeKeys.issueLists(), params] as const,
  issueDetails: () => [...weldmergeKeys.issues(), 'detail'] as const,
  issue: (idOrKey: string) => [...weldmergeKeys.issueDetails(), idOrKey] as const,
  comments: (issueId: string) => [...weldmergeKeys.issues(), 'comments', issueId] as const,
  pullRequests: () => [...weldmergeKeys.all, 'pull-requests'] as const,
  pullRequestList: (params: ListMergePullRequestsQuery) => [...weldmergeKeys.pullRequests(), 'list', params] as const,
  pullRequest: (id: string) => [...weldmergeKeys.pullRequests(), 'detail', id] as const,
  inbox: () => [...weldmergeKeys.all, 'inbox'] as const,
  connections: () => [...weldmergeKeys.all, 'connections'] as const,
  availableRepositories: (connectionId: string) => [...weldmergeKeys.connections(), connectionId, 'available'] as const,
  repositories: () => [...weldmergeKeys.all, 'repositories'] as const,
  accountsMe: () => [...weldmergeKeys.all, 'accounts', 'me'] as const,
};

/** Pages of 200 issues, at most this many (a board shows one team's issues). */
const MAX_ISSUE_PAGES = 10;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function useMergeTeams() {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: weldmergeKeys.teams(),
    queryFn: () => weldmerge.teams.list(),
    select: (res) => res.data,
  });
}

export function useMergeLabels(teamId?: string) {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: weldmergeKeys.labels(teamId),
    queryFn: () => weldmerge.labels.list(teamId),
    select: (res) => res.data,
  });
}

export function useMergeCycles(teamId?: string) {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: weldmergeKeys.cycles(teamId),
    queryFn: () => weldmerge.cycles.list(teamId),
    select: (res) => res.data,
  });
}

/** Every issue matching the filters, following cursor pages (a board needs them all). */
export function useMergeIssues(params: ListMergeIssuesQuery, enabled = true) {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: weldmergeKeys.issueList(params),
    enabled,
    queryFn: async (): Promise<MergeIssueDto[]> => {
      const all: MergeIssueDto[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_ISSUE_PAGES; page += 1) {
        const res = await weldmerge.issues.list({ ...params, limit: 200, cursor });
        all.push(...res.data);
        if (!res.pagination.hasMore || !res.pagination.cursor) break;
        cursor = res.pagination.cursor;
      }
      return all;
    },
  });
}

/** By key (`PLAT-209`) or id. */
export function useMergeIssue(idOrKey: string) {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: weldmergeKeys.issue(idOrKey),
    queryFn: () => weldmerge.issues.get(idOrKey),
    select: (res) => res.data,
    enabled: idOrKey !== '',
  });
}

export function useMergeComments(issueId: string | undefined) {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: weldmergeKeys.comments(issueId ?? ''),
    queryFn: () => weldmerge.issues.comments.list(issueId as string),
    select: (res) => res.data,
    enabled: !!issueId,
  });
}

/** Pull request rows, a page at a time. */
export function useMergePullRequests(params: ListMergePullRequestsQuery) {
  const { weldmerge } = useAppApi();
  return useInfiniteQuery({
    queryKey: weldmergeKeys.pullRequestList(params),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => weldmerge.pullRequests.list({ ...params, cursor: pageParam }),
    getNextPageParam: (last) => (last.pagination.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
    select: (data) => data.pages.flatMap((page) => page.data),
  });
}

export function useMergePullRequest(id: string) {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: weldmergeKeys.pullRequest(id),
    queryFn: () => weldmerge.pullRequests.get(id),
    select: (res) => res.data,
    enabled: id !== '',
  });
}

export function useMergeInbox() {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: weldmergeKeys.inbox(),
    queryFn: () => weldmerge.inbox.list(),
    select: (res) => res.data,
  });
}

export function useMergeConnections(enabled = true) {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: weldmergeKeys.connections(),
    queryFn: () => weldmerge.connections.list(),
    select: (res) => res.data,
    enabled,
  });
}

export function useMergeAvailableRepositories(connectionId: string | undefined, enabled = true) {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: weldmergeKeys.availableRepositories(connectionId ?? ''),
    queryFn: () => weldmerge.connections.availableRepositories(connectionId as string),
    select: (res) => res.data,
    enabled: enabled && !!connectionId,
    // Read from the provider each time the dialog opens.
    staleTime: 0,
    meta: { persist: false },
  });
}

export function useMergeRepositories(enabled = true) {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: weldmergeKeys.repositories(),
    queryFn: () => weldmerge.repositories.list(),
    select: (res) => res.data,
    enabled,
  });
}

export function useMyMergeAccounts() {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: weldmergeKeys.accountsMe(),
    queryFn: () => weldmerge.accounts.me(),
    select: (res) => res.data,
  });
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/** Cached issue lists and issue details, as they were before an optimistic change. */
type IssueListSnapshot = Array<[readonly unknown[], unknown]>;

/** An issue detail as `useMergeIssue` caches it: the raw response. */
type CachedIssueDetail = { data: MergeIssueDto };

/** The fields of an issue an update can change, applied to a cached row. */
export function applyIssueUpdate<T extends MergeIssueDto>(issue: T, input: UpdateMergeIssueInput): T {
  return { ...issue, ...stripUndefined(input) } as T;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Patches issues in every cached issue list and issue detail; returns what to restore on failure.
 * The detail matters as much as the lists: the issue page's pickers read it, so a second change
 * made before the first one's refetch lands builds on the first (two quick label picks keep both).
 */
function patchCachedIssues(
  queryClient: QueryClient,
  patches: ReadonlyArray<{ id: string; input: UpdateMergeIssueInput }>,
): IssueListSnapshot {
  const snapshot: IssueListSnapshot = [
    ...queryClient.getQueriesData<MergeIssueDto[]>({ queryKey: weldmergeKeys.issueLists() }),
    ...queryClient.getQueriesData<CachedIssueDetail>({ queryKey: weldmergeKeys.issueDetails() }),
  ];
  const byId = new Map(patches.map((patch) => [patch.id, patch.input]));
  queryClient.setQueriesData<MergeIssueDto[]>({ queryKey: weldmergeKeys.issueLists() }, (old) =>
    old?.map((issue) => {
      const input = byId.get(issue.id);
      return input ? applyIssueUpdate(issue, input) : issue;
    }),
  );
  queryClient.setQueriesData<CachedIssueDetail>({ queryKey: weldmergeKeys.issueDetails() }, (old) => {
    const input = old?.data ? byId.get(old.data.id) : undefined;
    return old && input ? { ...old, data: applyIssueUpdate(old.data, input) } : old;
  });
  return snapshot;
}

/** Stops issue refetches in flight, so none lands over an optimistic change with older data. */
function cancelIssueQueries(queryClient: QueryClient) {
  return Promise.all([
    queryClient.cancelQueries({ queryKey: weldmergeKeys.issueLists() }),
    queryClient.cancelQueries({ queryKey: weldmergeKeys.issueDetails() }),
  ]);
}

function restoreIssues(queryClient: QueryClient, snapshot: IssueListSnapshot | undefined) {
  for (const [key, data] of snapshot ?? []) queryClient.setQueryData(key, data);
}

/** Everything an issue change can alter: the issue views, the inbox, team and cycle counts, linked pull requests. */
function invalidateIssueViews(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: weldmergeKeys.issues() });
  void queryClient.invalidateQueries({ queryKey: weldmergeKeys.inbox() });
  void queryClient.invalidateQueries({ queryKey: [...weldmergeKeys.all, 'teams'] });
  void queryClient.invalidateQueries({ queryKey: [...weldmergeKeys.all, 'cycles'] });
  void queryClient.invalidateQueries({ queryKey: weldmergeKeys.pullRequests() });
}

// ---------------------------------------------------------------------------
// Teams, labels, cycles
// ---------------------------------------------------------------------------

export function useCreateMergeTeam() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMergeTeamInput) => weldmerge.teams.create(input).then((res) => res.data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldmergeKeys.teams() }),
  });
}

export function useUpdateMergeTeam() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateMergeTeamInput }) =>
      weldmerge.teams.update(id, input).then((res) => res.data),
    onSuccess: () => invalidateIssueViews(queryClient),
  });
}

export function useDeleteMergeTeam() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldmerge.teams.remove(id),
    onSuccess: () => invalidateIssueViews(queryClient),
  });
}

export function useCreateMergeLabel() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMergeLabelInput) => weldmerge.labels.create(input).then((res) => res.data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [...weldmergeKeys.all, 'labels'] }),
  });
}

export function useUpdateMergeLabel() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateMergeLabelInput }) =>
      weldmerge.labels.update(id, input).then((res) => res.data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [...weldmergeKeys.all, 'labels'] }),
  });
}

export function useDeleteMergeLabel() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldmerge.labels.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...weldmergeKeys.all, 'labels'] });
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.issues() });
    },
  });
}

export function useCreateMergeCycle() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMergeCycleInput) => weldmerge.cycles.create(input).then((res) => res.data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [...weldmergeKeys.all, 'cycles'] }),
  });
}

export function useUpdateMergeCycle() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateMergeCycleInput }) =>
      weldmerge.cycles.update(id, input).then((res) => res.data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [...weldmergeKeys.all, 'cycles'] }),
  });
}

export function useDeleteMergeCycle() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldmerge.cycles.remove(id),
    onSuccess: () => invalidateIssueViews(queryClient),
  });
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export function useCreateMergeIssue() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMergeIssueInput) => weldmerge.issues.create(input).then((res) => res.data),
    onSuccess: () => invalidateIssueViews(queryClient),
  });
}

/** Edits one issue; the cached lists change first and roll back if the write fails. */
export function useUpdateMergeIssue() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateMergeIssueInput }) =>
      weldmerge.issues.update(id, input).then((res) => res.data),
    onMutate: async ({ id, input }) => {
      await cancelIssueQueries(queryClient);
      return { snapshot: patchCachedIssues(queryClient, [{ id, input }]) };
    },
    onError: (_error, _vars, context) => restoreIssues(queryClient, context?.snapshot),
    onSettled: () => invalidateIssueViews(queryClient),
  });
}

/**
 * Persists a finished board drag: the moved card's status and place, plus the
 * renumbering of its column when neighbours left no room. Optimistic as a whole;
 * if any write fails the lists roll back and refetch.
 */
export function useMoveMergeIssue() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (move: BoardMove) => {
      const [moved, ...rest] = move.patches;
      if (!moved) return;
      await Promise.all([
        weldmerge.issues.update(move.issueId, { status: move.status, sortOrder: moved.sortOrder }),
        ...rest.map((patch) => weldmerge.issues.update(patch.id, { sortOrder: patch.sortOrder })),
      ]);
    },
    onMutate: async (move) => {
      await cancelIssueQueries(queryClient);
      const patches = move.patches.map((patch, index) => ({
        id: patch.id,
        input: index === 0 ? { status: move.status, sortOrder: patch.sortOrder } : { sortOrder: patch.sortOrder },
      }));
      return { snapshot: patchCachedIssues(queryClient, patches) };
    },
    onError: (_error, _move, context) => restoreIssues(queryClient, context?.snapshot),
    onSettled: () => invalidateIssueViews(queryClient),
  });
}

export function useDeleteMergeIssue() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldmerge.issues.remove(id),
    onSuccess: () => invalidateIssueViews(queryClient),
  });
}

export function useCreateMergeComment(issueId: string) {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMergeCommentInput) => weldmerge.issues.comments.create(issueId, input).then((res) => res.data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldmergeKeys.comments(issueId) }),
  });
}

export function useUpdateMergeComment(issueId: string) {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateMergeCommentInput }) =>
      weldmerge.comments.update(id, input).then((res) => res.data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldmergeKeys.comments(issueId) }),
  });
}

export function useDeleteMergeComment(issueId: string) {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldmerge.comments.remove(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldmergeKeys.comments(issueId) }),
  });
}

/** Links a pull request to an issue by hand (`merge_issues:update`). */
export function useLinkMergePullRequest() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ issueId, input }: { issueId: string; input: LinkMergePullRequestInput }) =>
      weldmerge.issues.linkPullRequest(issueId, input).then((res) => res.data),
    onSuccess: () => invalidateIssueViews(queryClient),
  });
}

export function useUnlinkMergePullRequest() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ issueId, pullRequestId }: { issueId: string; pullRequestId: string }) =>
      weldmerge.issues.unlinkPullRequest(issueId, pullRequestId),
    onSuccess: () => invalidateIssueViews(queryClient),
  });
}

// ---------------------------------------------------------------------------
// Connections, repositories, accounts
// ---------------------------------------------------------------------------

export function useConnectMergeGithub() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => weldmerge.connections.connectGithub().then((res) => res.data),
    onSuccess: (result) => {
      if (result.status === 'connected') void queryClient.invalidateQueries({ queryKey: weldmergeKeys.connections() });
    },
  });
}

export function useRemoveMergeConnection() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldmerge.connections.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.connections() });
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.repositories() });
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.pullRequests() });
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.inbox() });
    },
  });
}

function invalidateRepositoryViews(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: weldmergeKeys.repositories() });
  void queryClient.invalidateQueries({ queryKey: weldmergeKeys.connections() });
  void queryClient.invalidateQueries({ queryKey: weldmergeKeys.pullRequests() });
  void queryClient.invalidateQueries({ queryKey: weldmergeKeys.inbox() });
}

export function useAddMergeRepository() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AddMergeRepositoryInput) => weldmerge.repositories.add(input).then((res) => res.data),
    onSuccess: () => invalidateRepositoryViews(queryClient),
  });
}

export function useUpdateMergeRepository() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateMergeRepositoryInput }) =>
      weldmerge.repositories.update(id, input).then((res) => res.data),
    onSuccess: () => invalidateRepositoryViews(queryClient),
  });
}

export function useRemoveMergeRepository() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldmerge.repositories.remove(id),
    onSuccess: () => invalidateRepositoryViews(queryClient),
  });
}

export function useSyncMergeRepository() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldmerge.repositories.sync(id).then((res) => res.data),
    onSuccess: () => {
      invalidateRepositoryViews(queryClient);
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.issues() });
    },
  });
}

export function useUpdateMyMergeAccounts() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMyMergeAccountsInput) => weldmerge.accounts.updateMe(input).then((res) => res.data),
    onSuccess: (accounts) => {
      queryClient.setQueryData(weldmergeKeys.accountsMe(), { data: accounts });
      // Review requests and authored pull requests are matched by login.
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.inbox() });
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.pullRequests() });
    },
  });
}
