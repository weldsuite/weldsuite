
import { useCallback, useMemo } from 'react';
import { useParams } from '@/lib/router';
import { useMailListPage } from '../../hooks/use-mail-list-page';
import { MAIL_SEARCH_PAGE_SIZE, useMailThreadSearch } from '../../hooks/use-mail-thread-search';
import { LabelRealtimeWrapper } from './label-realtime-wrapper';
import { useMailLabelThreads, useMailDrafts, mailKeys } from '@/hooks/queries/use-mail-queries';
import { getLabelDisplayName } from '../../lib/label-config';
import type { ThreadSummary } from '../../lib/thread-utils';
import { MailDetailWrapper } from '../../components/mail-detail-wrapper';
import { MobileMailLayout } from '../../components/mobile-mail-layout';
import { MailThreadListProvider } from '../../contexts/mail-thread-list-context';
import { useOptimisticThreadList } from '../../hooks/use-optimistic-thread-list';
import {
  useMailNextPageThreads,
  useToppedUpThreadList,
} from '../../hooks/use-mail-thread-list-top-up';
import { mailThreadListKey } from '../../lib/optimistic-thread-list';
import { useI18n } from '@/lib/i18n/provider';
import { useQueryClient } from '@tanstack/react-query';

const PAGE_SIZE = 25;

export default function LabelLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { t } = useI18n();
  const params = useParams<{ accountId: string; labelSlug: string }>();
  const accountId = params.accountId;
  const labelSlug = decodeURIComponent(params.labelSlug);
  const urlPage = useMailListPage();
  const queryClient = useQueryClient();

  const isDraftsView = labelSlug === 'drafts';

  // The list's search box and Filter panel run on the server. A search shows
  // its matches as a single page, whatever page of the folder was open.
  const { search: threadSearch, isSearching, setSearch } = useMailThreadSearch();
  const currentPage = isSearching ? 1 : urlPage;
  const pageSize = isSearching ? MAIL_SEARCH_PAGE_SIZE : PAGE_SIZE;

  // Thread list for all labels except drafts
  const threadsQuery = useMailLabelThreads(
    { accountId, labelSlug, page: currentPage, pageSize, ...threadSearch },
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
            preview: d.body?.replace(/<[^>]*>/g, '').slice(0, 200) ?? '',
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

    const apiThreads = threadsQuery.data?.data?.threads ?? [];
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
  }, [isDraftsView, draftsQuery.data, threadsQuery.data]);

  const serverTotalCount = isDraftsView
    ? 0
    : (threadsQuery.data?.data?.totalCount ?? 0);

  const { nextPageThreads, nextPageThreadIds } = useMailNextPageThreads({
    accountId,
    labelSlug,
    page: currentPage,
    pageSize: PAGE_SIZE,
    serverTotalCount,
    enabled: !isDraftsView && !isSearching,
  });

  const {
    threads: visibleThreads,
    hidden,
    hiddenCount,
    hideThread,
    unhideThread,
  } = useOptimisticThreadList(
    threads,
    mailThreadListKey({ accountId, folder: labelSlug, page: currentPage, pageSize: PAGE_SIZE }),
    nextPageThreadIds,
  );

  const listThreads = useToppedUpThreadList(
    visibleThreads,
    nextPageThreads,
    pageSize,
    hidden,
  );

  const totalCount = useMemo<number>(() => {
    if (isDraftsView) return draftsQuery.data?.data?.length ?? 0;
    if (isSearching) return Math.min(serverTotalCount, MAIL_SEARCH_PAGE_SIZE);
    return Math.max(0, serverTotalCount - hiddenCount);
  }, [isDraftsView, isSearching, draftsQuery.data, serverTotalCount, hiddenCount]);

  const totalPages = Math.ceil(totalCount / pageSize) || 1;

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

  const displayName = getLabelDisplayName(labelSlug);

  const listContent = (
    <LabelRealtimeWrapper
      initialThreads={listThreads}
      accountId={accountId}
      labelSlug={labelSlug}
      displayName={displayName}
      error={error}
      currentPage={currentPage}
      totalPages={totalPages}
      totalCount={totalCount}
      pageSize={pageSize}
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
