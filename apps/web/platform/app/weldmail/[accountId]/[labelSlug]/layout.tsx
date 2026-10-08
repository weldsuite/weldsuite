import { useCallback, useMemo } from 'react';
import { useParams } from '@/lib/router';
import { useMailThreadSearch } from '../../hooks/use-mail-thread-search';
import { LabelRealtimeWrapper } from './label-realtime-wrapper';
import {
  useInfiniteMailLabelThreads,
  useMailDrafts,
  mailKeys,
} from '@/hooks/queries/use-mail-queries';
import { getLabelDisplayName } from '../../lib/label-config';
import type { ThreadSummary } from '../../lib/thread-utils';
import { MailDetailWrapper } from '../../components/mail-detail-wrapper';
import { MobileMailLayout } from '../../components/mobile-mail-layout';
import { MailThreadListProvider } from '../../contexts/mail-thread-list-context';
import { useOptimisticThreadList } from '../../hooks/use-optimistic-thread-list';
import { mailThreadListKey } from '../../lib/optimistic-thread-list';
import { useI18n } from '@/lib/i18n/provider';
import { useQueryClient } from '@tanstack/react-query';
import { stripTags } from '@/lib/utils';

const PAGE_SIZE = 25;

function mapApiThreads(
  apiThreads: Array<{
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
  }>,
): ThreadSummary[] {
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

export default function LabelLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { t } = useI18n();
  const params = useParams<{ accountId: string; labelSlug: string }>();
  const accountId = params.accountId;
  const labelSlug = decodeURIComponent(params.labelSlug);
  const queryClient = useQueryClient();

  const isDraftsView = labelSlug === 'drafts';

  // The list's search box and Filter panel run on the server.
  const { search: threadSearch, setSearch } = useMailThreadSearch();

  // Thread list for all labels except drafts — infinite scroll appends pages.
  const threadsQuery = useInfiniteMailLabelThreads(
    { accountId, labelSlug, pageSize: PAGE_SIZE, ...threadSearch },
    !isDraftsView,
  );

  // Drafts are stored separately — use dedicated hook when in drafts view
  const draftsQuery = useMailDrafts(accountId, isDraftsView);

  // Compute thread list from whichever source is active
  const threads = useMemo<ThreadSummary[]>(() => {
    if (isDraftsView) {
      const drafts = draftsQuery.data?.data ?? [];
      return drafts.map(
        (d) =>
          ({
            threadId: d.id,
            subject: d.subject ?? '(No subject)',
            participants: d.to ?? [],
            latestMessageId: d.id,
            latestSender: 'Me',
            latestSenderEmail: '',
            latestDate: new Date(d.updatedAt || d.createdAt),
            preview: stripTags(d.body ?? '').slice(0, 200),
            messageCount: 1,
            unreadCount: 0,
            hasAttachments: d.hasAttachments ?? false,
            isStarred: false,
            labels: d.labels ?? ['DRAFTS'],
            messages: [],
            isDraft: true,
            draftId: d.id,
          }) as ThreadSummary & { isDraft: boolean; draftId: string },
      );
    }

    const apiThreads = threadsQuery.data?.pages.flatMap((page) => page.data?.threads ?? []) ?? [];
    return mapApiThreads(apiThreads);
  }, [isDraftsView, draftsQuery.data, threadsQuery.data]);

  const serverTotalCount = isDraftsView
    ? 0
    : (threadsQuery.data?.pages[0]?.data?.totalCount ?? 0);

  const {
    threads: listThreads,
    hiddenCount,
    hideThread,
    unhideThread,
  } = useOptimisticThreadList(
    threads,
    mailThreadListKey({ accountId, folder: labelSlug, pageSize: PAGE_SIZE }),
  );

  const totalCount = useMemo<number>(() => {
    if (isDraftsView) return draftsQuery.data?.data?.length ?? 0;
    return Math.max(0, serverTotalCount - hiddenCount);
  }, [isDraftsView, draftsQuery.data, serverTotalCount, hiddenCount]);

  const error = useMemo<string | null>(() => {
    if (isDraftsView) {
      return draftsQuery.isError ? t.mail.shared.failedToLoadDrafts : null;
    }
    return threadsQuery.isError ? t.mail.shared.failedToLoadConversations : null;
  }, [isDraftsView, draftsQuery.isError, threadsQuery.isError, t.mail.shared]);

  // Invalidate the relevant query on a manual refresh event
  const handleRefetch = useCallback(() => {
    if (isDraftsView) {
      queryClient.invalidateQueries({ queryKey: mailKeys.drafts(accountId) });
    } else {
      // Every page and every search of this folder: the prefix matches them all.
      queryClient.invalidateQueries({ queryKey: [...mailKeys.all, 'threads-by-label'] });
    }
  }, [isDraftsView, accountId, queryClient]);

  const handleFetchNextPage = useCallback(() => {
    void threadsQuery.fetchNextPage();
  }, [threadsQuery]);

  const displayName = getLabelDisplayName(labelSlug);

  const listContent = (
    <LabelRealtimeWrapper
      initialThreads={listThreads}
      accountId={accountId}
      labelSlug={labelSlug}
      displayName={displayName}
      error={error}
      totalCount={totalCount}
      hasNextPage={!isDraftsView && Boolean(threadsQuery.hasNextPage)}
      isFetchingNextPage={!isDraftsView && threadsQuery.isFetchingNextPage}
      onFetchNextPage={isDraftsView ? undefined : handleFetchNextPage}
      isLoading={!isDraftsView && threadsQuery.isLoading}
      onRefetch={handleRefetch}
      onServerFilterChange={isDraftsView ? undefined : setSearch}
    />
  );

  const detailContent = <MailDetailWrapper>{children}</MailDetailWrapper>;

  return (
    <MailThreadListProvider
      threads={listThreads}
      isUnified={false}
      folder={labelSlug}
      accountId={accountId}
      hideThread={hideThread}
      unhideThread={unhideThread}
    >
      <MobileMailLayout
        list={listContent}
        detail={detailContent}
        accountId={accountId}
        labelSlug={labelSlug}
      />
    </MailThreadListProvider>
  );
}
