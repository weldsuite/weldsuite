import { useMemo } from 'react';
import { useMailLabelThreads } from '@/hooks/queries/use-mail-queries';
import type { ThreadSummary } from '../lib/thread-utils';
import { topUpThreadList } from '../lib/optimistic-thread-list';

type ApiThread = {
  threadId: string;
  subject: string;
  participants: string[];
  latestMessageId: string;
  latestSender: string;
  latestSenderEmail: string;
  latestSenderAvatarUrl?: string | null;
  latestDate?: string | Date | null;
  preview: string;
  messageCount: number;
  unreadCount: number;
  hasAttachments: boolean;
  isStarred: boolean;
  labels: string[];
  scheduledFor?: string | Date | null;
  sendStatus?: string | null;
  messages: ThreadSummary['messages'];
  accountId?: string;
};

function mapApiThreads(apiThreads: ApiThread[]): ThreadSummary[] {
  return apiThreads.map(
    (th): ThreadSummary => ({
      threadId: th.threadId,
      subject: th.subject,
      participants: th.participants,
      latestMessageId: th.latestMessageId,
      latestSender: th.latestSender,
      latestSenderEmail: th.latestSenderEmail,
      latestSenderAvatarUrl: th.latestSenderAvatarUrl,
      latestDate: th.latestDate ? new Date(th.latestDate) : new Date(0),
      preview: th.preview,
      messageCount: th.messageCount,
      unreadCount: th.unreadCount,
      hasAttachments: th.hasAttachments,
      isStarred: th.isStarred,
      labels: th.labels,
      scheduledFor: th.scheduledFor,
      sendStatus: th.sendStatus,
      messages: th.messages,
      accountId: th.accountId,
    }),
  );
}

/**
 * Prefetches the next page whenever more threads exist past the current
 * page. Used to refill the list after optimistic archive hides rows.
 */
export function useMailNextPageThreads(options: {
  accountId?: string;
  labelSlug: string;
  page: number;
  pageSize: number;
  serverTotalCount: number;
  enabled?: boolean;
}): { nextPageThreads: ThreadSummary[]; nextPageThreadIds: ReadonlySet<string> } {
  const {
    accountId,
    labelSlug,
    page,
    pageSize,
    serverTotalCount,
    enabled = true,
  } = options;

  const hasNextPage = page * pageSize < serverTotalCount;
  const nextPageQuery = useMailLabelThreads(
    { accountId, labelSlug, page: page + 1, pageSize },
    enabled && hasNextPage,
  );

  const nextPageThreads = useMemo(
    () => mapApiThreads(nextPageQuery.data?.data?.threads ?? []),
    [nextPageQuery.data],
  );

  const nextPageThreadIds = useMemo(
    () => new Set(nextPageThreads.map((t) => t.threadId)),
    [nextPageThreads],
  );

  return { nextPageThreads, nextPageThreadIds };
}

export function useToppedUpThreadList(
  visibleThreads: ThreadSummary[],
  nextPageThreads: ThreadSummary[],
  pageSize: number,
  hiddenIds?: { has(id: string): boolean },
): ThreadSummary[] {
  return useMemo(
    () => topUpThreadList(visibleThreads, nextPageThreads, pageSize, hiddenIds),
    [visibleThreads, nextPageThreads, pageSize, hiddenIds],
  );
}
