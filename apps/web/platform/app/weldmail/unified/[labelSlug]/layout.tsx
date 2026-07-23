
import { useEffect, useState, useCallback, useMemo } from 'react';
import { ChevronUp } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { useParams, useSearchParams } from '@/lib/router';
import { useMailLabelThreads } from '@/hooks/queries/use-mail-queries';
import { getLabelDisplayName, getSystemLabelConfig } from '../../lib/label-config';
import type { ThreadSummary } from '../../lib/thread-utils';
import { MailDetailWrapper } from '../../components/mail-detail-wrapper';
import { MobileMailLayout } from '../../components/mobile-mail-layout';
import { MessageList } from '../../components/message-list';
import { useMailRealtime } from '../../hooks/useMailRealtime';
import type { NewEmailEvent } from '../../hooks/mail-types';
import { UNIFIED_ACCOUNT } from '../../lib/mail-preferences';
import {
  useUserPreferences,
  useUpdateMailLastAccount,
} from '@/hooks/queries/use-settings-queries';

const PAGE_SIZE = 25;

export default function UnifiedLabelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const params = useParams<{ labelSlug: string }>();
  const labelSlug = decodeURIComponent(params.labelSlug);
  const searchParams = useSearchParams();
  const currentPage = Math.max(1, Number(searchParams?.get('page')) || 1);

  // Remember that the unified inbox was the last view opened (per-user).
  const { data: preferences } = useUserPreferences();
  const updateLastAccount = useUpdateMailLastAccount();
  const storedLast = preferences?.uiPreferences?.mailLastAccountId;
  useEffect(() => {
    if (!preferences) return;
    if (storedLast === UNIFIED_ACCOUNT) return;
    updateLastAccount.mutate(UNIFIED_ACCOUNT);
    // updateLastAccount is stable from react-query; intentionally not a dep.
  }, [storedLast, preferences]);

  // Unified inbox: omit `accountId` so app-api's /mail-labels/threads
  // aggregates threads across every account the caller can read.
  const threadsQuery = useMailLabelThreads({ labelSlug, page: currentPage, pageSize: PAGE_SIZE });

  const mappedThreads = useMemo<ThreadSummary[]>(() => {
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
  }, [threadsQuery.data]);

  // Local copy so optimistic label updates render immediately; re-seeded
  // whenever the query refetches.
  const [threads, setThreads] = useState<ThreadSummary[]>(mappedThreads);
  useEffect(() => {
    setThreads(mappedThreads);
  }, [mappedThreads]);

  const totalCount = threadsQuery.data?.data?.totalCount ?? 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE) || 1;
  const error = threadsQuery.isError ? t.mail.unifiedLayout.failedToLoadConversations : null;

  const refetchThreads = useCallback(() => {
    void threadsQuery.refetch();
  }, [threadsQuery]);

  useEffect(() => {
    const handler = () => refetchThreads();
    window.addEventListener('mail:refresh', handler);
    return () => window.removeEventListener('mail:refresh', handler);
  }, [refetchThreads]);

  const shouldShowInView = useCallback(
    (email: NewEmailEvent): boolean => {
      const config = getSystemLabelConfig(labelSlug);
      if (!config) return false;
      if (config.filterType === 'virtual') return labelSlug === 'all';
      return config.slug === 'inbox';
    },
    [labelSlug],
  );

  const handleNewEmail = useCallback(
    (email: NewEmailEvent) => {
      if (!shouldShowInView(email)) return;
      refetchThreads();
    },
    [shouldShowInView, refetchThreads],
  );

  const { newEmailCount, resetNewEmailCount, connectionStatus } = useMailRealtime({
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
          const updated =
            action === 'add'
              ? current.includes(labelName)
                ? current
                : [...current, labelName]
              : current.filter((l) => l !== labelName);
          return { ...thread, labels: updated };
        }),
      );
    },
    [],
  );

  const displayName = getLabelDisplayName(labelSlug);

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
      {labelSlug === 'inbox' && newEmailCount > 0 && (
        <div className="absolute -top-px left-0 right-0 z-10 flex justify-center">
          <Button
            variant="ghost"
            onClick={() => {
              refetchThreads();
              resetNewEmailCount();
            }}
            className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-b-lg shadow-md hover:bg-gray-50 hover:text-gray-900 transition-colors"
          >
            <ChevronUp className="h-3 w-3" />
            {t.mail.unifiedLayout.newEmails.replace('{count}', String(newEmailCount))}
          </Button>
        </div>
      )}
      <MessageList
        threads={threads}
        accountId="unified"
        folder={labelSlug}
        error={error}
        currentPage={currentPage}
        totalPages={totalPages}
        totalCount={totalCount}
        pageSize={PAGE_SIZE}
        isUnified
        onThreadLabelUpdate={handleThreadLabelUpdate}
      />
    </div>
  );

  const detailContent = <MailDetailWrapper>{children}</MailDetailWrapper>;

  return (
    <MobileMailLayout
      list={listContent}
      detail={detailContent}
      accountId="unified"
      labelSlug={labelSlug}
    />
  );
}
