/**
 * WeldMerge across WeldSuite (phase 5): releases, record links, time on an issue,
 * chat subscriptions, and what the desk and chat surfaces read.
 *
 * Every key sits under `weldmergeKeys.all`, so the realtime sync map that
 * invalidates `merge_*` entity events refetches whatever is mounted.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi, useAppApiClient } from '@/lib/api/use-app-api';
import type {
  CreateMergeIssueInput,
  CreateMergeRecordLinkInput,
  MergeRecordType,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import type {
  CreateMergeChatSubscriptionInput,
  CreateMergeReleaseInput,
  ListMergeReleasesQuery,
  PublishMergeReleaseInput,
  UpdateMergeChatSubscriptionInput,
  UpdateMergeReleaseInput,
} from '@weldsuite/app-api-client/schemas/weldmerge-across';
import type { SubmitMergeReviewInput } from '@weldsuite/app-api-client/schemas/weldmerge-review';
import { weldmergeKeys } from './use-weldmerge-queries';

export const weldmergeAcrossKeys = {
  releases: () => [...weldmergeKeys.all, 'releases'] as const,
  releaseList: (params: ListMergeReleasesQuery) => [...weldmergeAcrossKeys.releases(), 'list', params] as const,
  release: (id: string) => [...weldmergeAcrossKeys.releases(), 'detail', id] as const,
  recordLinks: (recordType: MergeRecordType, recordId: string) =>
    [...weldmergeKeys.all, 'record-links', recordType, recordId] as const,
  issueTime: (issueId: string) => [...weldmergeKeys.all, 'issue-time', issueId] as const,
  chatSubscriptions: () => [...weldmergeKeys.all, 'chat-subscriptions'] as const,
  share: (query: string) => [...weldmergeKeys.all, 'share-search', query] as const,
};

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

export function useMergeReleases(params: ListMergeReleasesQuery = {}, enabled = true) {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: weldmergeAcrossKeys.releaseList(params),
    queryFn: () => weldmerge.releases.list({ limit: 100, ...params }),
    select: (res) => res.data,
    enabled,
  });
}

export function useMergeRelease(id: string) {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: weldmergeAcrossKeys.release(id),
    queryFn: () => weldmerge.releases.get(id),
    select: (res) => res.data,
    enabled: id !== '',
  });
}

function useInvalidateReleases() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: weldmergeAcrossKeys.releases() });
    // Shipping and refreshing change what a ticket shows as "shipped in".
    void queryClient.invalidateQueries({ queryKey: [...weldmergeKeys.all, 'record-links'] });
  };
}

export function useCreateMergeRelease() {
  const { weldmerge } = useAppApi();
  const invalidate = useInvalidateReleases();
  return useMutation({
    mutationFn: (input: CreateMergeReleaseInput) => weldmerge.releases.create(input).then((res) => res.data),
    onSuccess: invalidate,
  });
}

export function useUpdateMergeRelease() {
  const { weldmerge } = useAppApi();
  const invalidate = useInvalidateReleases();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateMergeReleaseInput }) =>
      weldmerge.releases.update(id, input).then((res) => res.data),
    onSuccess: invalidate,
  });
}

export function useDeleteMergeRelease() {
  const { weldmerge } = useAppApi();
  const invalidate = useInvalidateReleases();
  return useMutation({
    mutationFn: (id: string) => weldmerge.releases.remove(id),
    onSuccess: invalidate,
  });
}

export function useRefreshMergeRelease() {
  const { weldmerge } = useAppApi();
  const invalidate = useInvalidateReleases();
  return useMutation({
    mutationFn: (id: string) => weldmerge.releases.refresh(id).then((res) => res.data),
    onSuccess: invalidate,
  });
}

export function useGenerateMergeReleaseNotes() {
  const { weldmerge } = useAppApi();
  const invalidate = useInvalidateReleases();
  return useMutation({
    mutationFn: (id: string) => weldmerge.releases.generateNotes(id).then((res) => res.data),
    onSuccess: invalidate,
  });
}

export function useShipMergeRelease() {
  const { weldmerge } = useAppApi();
  const invalidate = useInvalidateReleases();
  return useMutation({
    mutationFn: (id: string) => weldmerge.releases.ship(id).then((res) => res.data),
    onSuccess: invalidate,
  });
}

export function usePublishMergeRelease() {
  const { weldmerge } = useAppApi();
  const invalidate = useInvalidateReleases();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: PublishMergeReleaseInput }) =>
      weldmerge.releases.publish(id, input).then((res) => res.data),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Record links
// ---------------------------------------------------------------------------

/** The issues linked to a ticket, company or chat channel (what the desk sidebar shows). */
export function useMergeRecordLinks(recordType: MergeRecordType, recordId: string, enabled = true) {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: weldmergeAcrossKeys.recordLinks(recordType, recordId),
    queryFn: () => weldmerge.recordLinks.list({ recordType, recordId }),
    select: (res) => res.data,
    enabled: enabled && recordId !== '',
  });
}

/** Everything a link change can alter on the issue and on the records that show the link. */
function useInvalidateLinks() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: weldmergeKeys.issues() });
    void queryClient.invalidateQueries({ queryKey: [...weldmergeKeys.all, 'record-links'] });
  };
}

export function useCreateMergeIssueLink(issueId: string) {
  const { weldmerge } = useAppApi();
  const invalidate = useInvalidateLinks();
  return useMutation({
    mutationFn: (input: CreateMergeRecordLinkInput) => weldmerge.issues.links.create(issueId, input).then((res) => res.data),
    onSuccess: invalidate,
  });
}

export function useRemoveMergeIssueLink(issueId: string) {
  const { weldmerge } = useAppApi();
  const invalidate = useInvalidateLinks();
  return useMutation({
    mutationFn: (linkId: string) => weldmerge.issues.links.remove(issueId, linkId),
    onSuccess: invalidate,
  });
}

/** Escalates a ticket: one call creates the issue and its links. */
export function useEscalateToMergeIssue() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMergeIssueInput) => weldmerge.issues.create(input).then((res) => res.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.issues() });
      void queryClient.invalidateQueries({ queryKey: [...weldmergeKeys.all, 'record-links'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Time on an issue (flow-api time entries carry `mergeIssueId`)
// ---------------------------------------------------------------------------

export interface MergeIssueTimeEntry {
  id: string;
  date: string;
  /** Minutes. */
  duration: string | number;
  description?: string | null;
  userId?: string;
}

export interface LogIssueTimeInput {
  issueId: string;
  minutes: number;
  /** `YYYY-MM-DD`. */
  date: string;
  description?: string;
}

export function useMergeIssueTime(issueId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldmergeAcrossKeys.issueTime(issueId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: MergeIssueTimeEntry[] }>(
        `/time-entries?mergeIssueId=${encodeURIComponent(issueId)}&limit=200`,
      );
    },
    select: (res) => res.data ?? [],
    enabled: enabled && issueId !== '',
  });
}

export function useLogMergeIssueTime() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ issueId, minutes, date, description }: LogIssueTimeInput) => {
      const client = await getClient();
      return client.post('/time-entries', {
        mergeIssueId: issueId,
        date,
        duration: minutes,
        ...(description ? { description } : {}),
      });
    },
    onSuccess: (_res, vars) =>
      void queryClient.invalidateQueries({ queryKey: weldmergeAcrossKeys.issueTime(vars.issueId) }),
  });
}

/** Total minutes of a list of entries. */
export function sumMinutes(entries: readonly MergeIssueTimeEntry[]): number {
  return entries.reduce((sum, entry) => sum + (Number(entry.duration) || 0), 0);
}

// ---------------------------------------------------------------------------
// Chat subscriptions
// ---------------------------------------------------------------------------

export function useMergeChatSubscriptions(enabled = true) {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: weldmergeAcrossKeys.chatSubscriptions(),
    queryFn: () => weldmerge.chatSubscriptions.list(),
    select: (res) => res.data,
    enabled,
  });
}

export function useCreateMergeChatSubscription() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMergeChatSubscriptionInput) =>
      weldmerge.chatSubscriptions.create(input).then((res) => res.data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldmergeAcrossKeys.chatSubscriptions() }),
  });
}

export function useUpdateMergeChatSubscription() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateMergeChatSubscriptionInput }) =>
      weldmerge.chatSubscriptions.update(id, input).then((res) => res.data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldmergeAcrossKeys.chatSubscriptions() }),
  });
}

export function useRemoveMergeChatSubscription() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldmerge.chatSubscriptions.remove(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldmergeAcrossKeys.chatSubscriptions() }),
  });
}

// ---------------------------------------------------------------------------
// Chat cards and slash commands
// ---------------------------------------------------------------------------

/** One WeldMerge item shared with `/merge`: an issue or a pull request. */
export type MergeShareResult =
  | { type: 'issue'; id: string; key: string; title: string }
  | { type: 'pull_request'; id: string; key: string; title: string };

/** Issues and open pull requests matching `query`, for `/merge <query>`. */
export function useMergeShareSearch(query: string, enabled = true) {
  const { weldmerge } = useAppApi();
  const q = query.trim();
  return useQuery({
    queryKey: weldmergeAcrossKeys.share(q),
    enabled: enabled && q.length > 0,
    staleTime: 15_000,
    queryFn: async (): Promise<MergeShareResult[]> => {
      const [issues, pullRequests] = await Promise.all([
        weldmerge.issues.list({ q, limit: 5 }),
        weldmerge.pullRequests.list({ q, view: 'open', limit: 5 }),
      ]);
      return [
        ...issues.data.map((issue): MergeShareResult => ({ type: 'issue', id: issue.id, key: issue.key, title: issue.title })),
        ...pullRequests.data.map(
          (pr): MergeShareResult => ({
            type: 'pull_request',
            id: pr.id,
            key: `${pr.repositoryFullName} #${pr.number}`,
            title: pr.title,
          }),
        ),
      ];
    },
  });
}

/** Approve a pull request from a chat card. */
export function useApproveMergePullRequest() {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input?: SubmitMergeReviewInput }) =>
      weldmerge.pullRequests.review(id, input ?? { event: 'approve' }).then((res) => res.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.pullRequests() });
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.inbox() });
    },
  });
}

/** Posts a reply from a card's thread as a comment on the pull request itself. */
export function useCommentOnMergePullRequest() {
  const { weldmerge } = useAppApi();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => weldmerge.pullRequests.comment(id, { body }),
  });
}
