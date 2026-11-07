/**
 * WeldMerge review hooks (phase 4): a pull request's changed files and review
 * threads, read live from the provider, and the writes that go back to it as the
 * member's own linked account: review, comment, merge.
 *
 * Keys sit under the pull request's detail key, so the realtime sync map's
 * `weldmerge` root and the invalidations below reach them.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type {
  CreateMergePullRequestCommentInput,
  MergeMergePullRequestInput,
  SubmitMergeReviewInput,
} from '@weldsuite/app-api-client/schemas/weldmerge-review';
import { weldmergeKeys } from './use-weldmerge-queries';

export const weldmergeReviewKeys = {
  files: (pullRequestId: string) => [...weldmergeKeys.pullRequest(pullRequestId), 'files'] as const,
  threads: (pullRequestId: string) => [...weldmergeKeys.pullRequest(pullRequestId), 'threads'] as const,
};

/** The API's error code (`account_not_linked`, `not_mergeable`, `provider_error`, ...), when it sent one. */
export function reviewErrorCode(error: unknown): string | null {
  const body = (error as { body?: { error?: { code?: unknown } } } | null)?.body;
  const code = body?.error?.code;
  return typeof code === 'string' ? code : null;
}

export function useMergePullRequestFiles(pullRequestId: string, enabled = true) {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: weldmergeReviewKeys.files(pullRequestId),
    queryFn: () => weldmerge.pullRequests.files(pullRequestId),
    select: (res) => res.data,
    enabled: enabled && pullRequestId !== '',
    staleTime: 30_000,
  });
}

export function useMergePullRequestThreads(pullRequestId: string, enabled = true) {
  const { weldmerge } = useAppApi();
  return useQuery({
    queryKey: weldmergeReviewKeys.threads(pullRequestId),
    queryFn: () => weldmerge.pullRequests.threads(pullRequestId),
    select: (res) => res.data,
    enabled: enabled && pullRequestId !== '',
  });
}

/** Approve, request changes or comment (`merge_pull_requests:review`), with any pending line comments. */
export function useSubmitMergeReview(pullRequestId: string) {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SubmitMergeReviewInput) => weldmerge.pullRequests.review(pullRequestId, input).then((res) => res.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.pullRequests() });
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.inbox() });
    },
  });
}

/** A general comment, a line comment or a reply (`merge_pull_requests:review`). */
export function useCreateMergePullRequestComment(pullRequestId: string) {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMergePullRequestCommentInput) =>
      weldmerge.pullRequests.comment(pullRequestId, input).then((res) => res.data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldmergeReviewKeys.threads(pullRequestId) }),
  });
}

/** Merge on the provider (`merge_pull_requests:merge`); the answer is the refreshed mirror. */
export function useMergePullRequestOnProvider(pullRequestId: string) {
  const { weldmerge } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MergeMergePullRequestInput) => weldmerge.pullRequests.merge(pullRequestId, input).then((res) => res.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.pullRequests() });
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.issues() });
      void queryClient.invalidateQueries({ queryKey: weldmergeKeys.inbox() });
    },
  });
}
