/**
 * WeldReach reply inbox hooks: threads, one thread, replying, labelling,
 * handling and the hand-off to WeldCRM.
 *
 * `useReachUnreadCount` is also what the module sidebar reads for its badge.
 * Keys live under the `['reach', …]` prefix shared by every WeldReach hook.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { useIdleAwareRefetchInterval } from '@/hooks/use-user-idle';
import type { ListResponse } from '@weldsuite/app-api-client/types';
import type {
  ReachAddToCrmInput,
  ReachInboxFilter,
  ReachThreadSummary,
  UpdateReachMessageInput,
} from '@weldsuite/app-api-client/schemas/reach';

const PAGE_SIZE = 30;
/** The inbox picks up new replies by polling, but not while the user is idle (see `useIdleAwareRefetchInterval`). */
const INBOX_REFETCH_MS = 30_000;

export type ReachInboxFilters = Omit<ReachInboxFilter, 'cursor' | 'limit'>;

export const reachInboxKeys = {
  all: ['reach', 'inbox'] as const,
  threads: () => [...reachInboxKeys.all, 'threads'] as const,
  threadList: (filters: ReachInboxFilters) => [...reachInboxKeys.threads(), filters] as const,
  thread: (threadKey: string) => [...reachInboxKeys.all, 'thread', threadKey] as const,
  unreadCount: () => [...reachInboxKeys.all, 'unread-count'] as const,
};

function flattenPages<T>(pages: Array<ListResponse<T>> | undefined): T[] {
  return pages?.flatMap((page) => page.data) ?? [];
}

/** Threads with replies, following cursor pages and refreshed every 30 seconds. */
export function useReachThreads(filters: ReachInboxFilters) {
  const { reach } = useAppApi();
  const queryKey = reachInboxKeys.threadList(filters);
  const refetchInterval = useIdleAwareRefetchInterval(queryKey, INBOX_REFETCH_MS);

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => reach.listThreads({ ...filters, cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pagination.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
    refetchInterval,
  });

  return {
    ...query,
    threads: flattenPages<ReachThreadSummary>(query.data?.pages),
  };
}

/** Number of unread replies. Pass `enabled: false` for a viewer without `reach_inbox:read`. */
export function useReachUnreadCount(options: { enabled?: boolean } = {}) {
  const { reach } = useAppApi();
  const refetchInterval = useIdleAwareRefetchInterval(reachInboxKeys.unreadCount(), INBOX_REFETCH_MS);

  return useQuery({
    queryKey: reachInboxKeys.unreadCount(),
    queryFn: () => reach.unreadCount(),
    select: (res) => res.data.count,
    refetchInterval,
    enabled: options.enabled ?? true,
  });
}

export function useReachThread(threadKey: string | undefined) {
  const { reach } = useAppApi();
  const queryKey = reachInboxKeys.thread(threadKey ?? '');
  const refetchInterval = useIdleAwareRefetchInterval(queryKey, INBOX_REFETCH_MS);

  return useQuery({
    queryKey,
    queryFn: () => reach.getThread(threadKey as string),
    select: (res) => res.data,
    enabled: Boolean(threadKey),
    refetchInterval,
  });
}

/** Everything a message or thread write can change. */
function useInvalidateInbox() {
  const qc = useQueryClient();
  return (threadKey?: string) => {
    void qc.invalidateQueries({ queryKey: reachInboxKeys.threads() });
    void qc.invalidateQueries({ queryKey: reachInboxKeys.unreadCount() });
    if (threadKey) void qc.invalidateQueries({ queryKey: reachInboxKeys.thread(threadKey) });
  };
}

/** Sends an answer from the mailbox the prospect replied to. */
export function useReplyToReachThread(threadKey: string) {
  const { reach } = useAppApi();
  const invalidate = useInvalidateInbox();

  return useMutation({
    mutationFn: (body: string) => reach.reply(threadKey, body),
    onSuccess: () => invalidate(threadKey),
  });
}

/** Label, read and handled state of one message. */
export function useUpdateReachMessage(threadKey: string | undefined) {
  const { reach } = useAppApi();
  const invalidate = useInvalidateInbox();

  return useMutation({
    mutationFn: (input: { id: string; changes: UpdateReachMessageInput }) =>
      reach.updateMessage(input.id, input.changes),
    onSuccess: () => invalidate(threadKey),
  });
}

/** Creates (or links) the CRM person and, optionally, an opportunity. */
export function useAddReachThreadToCrm(threadKey: string) {
  const { reach } = useAppApi();
  const invalidate = useInvalidateInbox();

  return useMutation({
    mutationFn: (input: ReachAddToCrmInput) => reach.addToCrm(threadKey, input),
    onSuccess: () => invalidate(threadKey),
  });
}
