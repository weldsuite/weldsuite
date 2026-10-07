import { useEffect, useState, useCallback, useMemo } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useParams } from '@/lib/router';
import { useMailThreadSearch } from '../../hooks/use-mail-thread-search';
import { useInfiniteMailLabelThreads } from '@/hooks/queries/use-mail-queries';
import { getSystemLabelConfig } from '../../lib/label-config';
import type { ThreadSummary } from '../../lib/thread-utils';
import { MailDetailWrapper } from '../../components/mail-detail-wrapper';
import { MobileMailLayout } from '../../components/mobile-mail-layout';
import { MessageList } from '../../components/message-list';
import { MailThreadListProvider } from '../../contexts/mail-thread-list-context';
import { useOptimisticThreadList } from '../../hooks/use-optimistic-thread-list';
import { mailThreadListKey } from '../../lib/optimistic-thread-list';
import { useMailRealtime } from '../../hooks/useMailRealtime';
import { UNIFIED_ACCOUNT } from '../../lib/mail-preferences';
import {
  useUserPreferences,
  useUpdateMailLastAccount,
} from '@/hooks/queries/use-settings-queries';

const PAGE_SIZE = 25;

function applyLabelAction(current: string[], labelName: string, action: 'add' | 'remove'): string[] {
  if (action === 'remove') return current.filter((l) => l !== labelName);
  return current.includes(labelName) ? current : [...current, labelName];
}

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

export default function UnifiedLabelLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { t } = useI18n();
  const params = useParams<{ labelSlug: string }>();
  const labelSlug = decodeURIComponent(params.labelSlug);

  // Search box and Filter panel run on the server (see useMailThreadSearch).
  const { search: threadSearch, setSearch } = useMailThreadSearch();

  // Remember that the unified inbox was the last view opened (per-user).
  const { data: preferences } = useUserPreferences();
  const updateLastAccount = useUpdateMailLastAccount();
  const storedLast = preferences?.uiPreferences?.mailLastAccountId;
  useEffect(() => {
    if (!preferences) return;
    if (storedLast === UNIFIED_ACCOUNT) return;
    updateLastAccount.mutate(UNIFIED_ACCOUNT);
    // updateLastAccount is stable from react-query; intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedLast, preferences]);

  // Unified inbox: omit `accountId` so app-api's /mail-labels/threads
  // aggregates threads across every account the caller can read.
  const threadsQuery = useInfiniteMailLabelThreads({
    labelSlug,
    pageSize: PAGE_SIZE,
    ...threadSearch,
  });

  const mappedThreads = useMemo<ThreadSummary[]>(() => {
    const apiThreads = threadsQuery.data?.pages.flatMap((page) => page.data?.threads ?? []) ?? [];
    return mapApiThreads(apiThreads);
  }, [threadsQuery.data]);

  // Local copy so optimistic label updates render immediately; re-seeded
  // whenever the query refetches.
  const [threads, setThreads] = useState<ThreadSummary[]>(mappedThreads);
  useEffect(() => {
    setThreads(mappedThreads);
  }, [mappedThreads]);

  const serverTotalCount = threadsQuery.data?.pages[0]?.data?.totalCount ?? 0;

  // Archive-and-next hides the row immediately so the left list doesn't
  // wait on the background refetch.
  const {
    threads: listThreads,
    hiddenCount,
    hideThread,
    unhideThread,
  } = useOptimisticThreadList(
    threads,
    mailThreadListKey({ accountId: 'unified', folder: labelSlug, pageSize: PAGE_SIZE }),
  );

  const totalCount = Math.max(0, serverTotalCount - hiddenCount);
  const error = threadsQuery.isError ? t.mail.unifiedLayout.failedToLoadConversations : null;

  const refetchThreads = useCallback(() => {
    void threadsQuery.refetch();
  }, [threadsQuery]);

  const handleFetchNextPage = useCallback(() => {
    void threadsQuery.fetchNextPage();
  }, [threadsQuery]);

  useEffect(() => {
    const handler = () => refetchThreads();
    window.addEventListener('mail:refresh', handler);
    return () => window.removeEventListener('mail:refresh', handler);
  }, [refetchThreads]);

  const shouldShowInView = useCallback(
    (): boolean => {
      const config = getSystemLabelConfig(labelSlug);
      if (!config) return false;
      if (config.filterType === 'virtual') return labelSlug === 'all';
      return config.slug === 'inbox';
    },
    [labelSlug],
  );

  const handleNewEmail = useCallback(
    () => {
      if (!shouldShowInView()) return;
      refetchThreads();
    },
    [shouldShowInView, refetchThreads],
  );

  const { connectionStatus } = useMailRealtime({
    onNewEmail: handleNewEmail,
    onReadStatusChange: () => refetchThreads(),
    onEmailDeleted: () => refetchThreads(),
    onEmailArchived: () => refetchThreads(),
    onEmailStarred: () => refetchThreads(),
    showToasts: labelSlug === 'inbox',
  });

  const handleThreadLabelUpdate = useCallback(
    (threadId: string, labelName: string, action: 'add' | 'remove') => {
      setThreads((prev) =>
        prev.map((thread) => {
          if (thread.threadId !== threadId) return thread;
          const current = (thread.labels as string[]) || [];
          const updated = applyLabelAction(current, labelName, action);
          return { ...thread, labels: updated };
        }),
      );
    },
    [],
  );

  const listContent = (
    <div className="relative h-full">
      {connectionStatus === 'connecting' && (
        <div className="absolute top-2 right-2 z-10">
          <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-gray-500 bg-gray-100 rounded-full">
            <div className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
            {t.mail.unifiedLayout.connecting}
          </div>
        </div>
      )}
      <MessageList
        threads={listThreads}
        accountId="unified"
        folder={labelSlug}
        error={error}
        totalCount={totalCount}
        hasNextPage={Boolean(threadsQuery.hasNextPage)}
        isFetchingNextPage={threadsQuery.isFetchingNextPage}
        onFetchNextPage={handleFetchNextPage}
        isLoading={threadsQuery.isLoading}
        isUnified
        onThreadLabelUpdate={handleThreadLabelUpdate}
        onServerFilterChange={setSearch}
      />
    </div>
  );

  const detailContent = <MailDetailWrapper>{children}</MailDetailWrapper>;

  return (
    <MailThreadListProvider
      threads={listThreads}
      isUnified
      folder={labelSlug}
      accountId="unified"
      hideThread={hideThread}
      unhideThread={unhideThread}
    >
      <MobileMailLayout
        list={listContent}
        detail={detailContent}
        accountId="unified"
        labelSlug={labelSlug}
      />
    </MailThreadListProvider>
  );
}
