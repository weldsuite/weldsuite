
import { useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from '@/lib/router';
import { LabelRealtimeWrapper } from './label-realtime-wrapper';
import { useMailLabelThreads, useMailDrafts, mailKeys } from '@/hooks/queries/use-mail-queries';
import { getLabelDisplayName } from '../../lib/label-config';
import type { ThreadSummary } from '../../lib/thread-utils';
import { MailDetailWrapper } from '../../components/mail-detail-wrapper';
import { MobileMailLayout } from '../../components/mobile-mail-layout';
import { useI18n } from '@/lib/i18n/provider';
import { useQueryClient } from '@tanstack/react-query';

const PAGE_SIZE = 25;

export default function LabelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const params = useParams<{ accountId: string; labelSlug: string }>();
  const accountId = params.accountId;
  const labelSlug = decodeURIComponent(params.labelSlug);
  const searchParams = useSearchParams();
  const currentPage = Math.max(1, Number(searchParams?.get('page')) || 1);
  const queryClient = useQueryClient();

  const isDraftsView = labelSlug === 'drafts';

  // Thread list for all labels except drafts
  const threadsQuery = useMailLabelThreads(
    { accountId, labelSlug, page: currentPage, pageSize: PAGE_SIZE },
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

  const totalCount = useMemo<number>(() => {
    if (isDraftsView) return draftsQuery.data?.data?.length ?? 0;
    return threadsQuery.data?.data?.totalCount ?? 0;
  }, [isDraftsView, draftsQuery.data, threadsQuery.data]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE) || 1;

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
      queryClient.invalidateQueries({
        queryKey: mailKeys.threadsByLabel({ accountId, labelSlug, page: currentPage, pageSize: PAGE_SIZE }),
      });
    }
  }, [isDraftsView, accountId, labelSlug, currentPage, queryClient]);

  const displayName = getLabelDisplayName(labelSlug);

  const listContent = (
    <LabelRealtimeWrapper
      initialThreads={threads}
      accountId={accountId}
      labelSlug={labelSlug}
      displayName={displayName}
      error={error}
      currentPage={currentPage}
      totalPages={totalPages}
      totalCount={totalCount}
      pageSize={PAGE_SIZE}
      onRefetch={handleRefetch}
    />
  );

  const detailContent = <MailDetailWrapper>{children}</MailDetailWrapper>;

  return (
    <MobileMailLayout
      list={listContent}
      detail={detailContent}
      accountId={accountId}
      labelSlug={labelSlug}
    />
  );
}
