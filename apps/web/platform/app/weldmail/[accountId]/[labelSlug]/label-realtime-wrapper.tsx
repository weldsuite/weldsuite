
import { useCallback, useEffect, useState } from 'react';
import { useParams } from '@/lib/router';
import { ChevronUp } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { MessageList } from '../../components/message-list';
import { useMailRealtime } from '../../hooks/useMailRealtime';
import { getSystemLabelConfig } from '../../lib/label-config';
import type { NewEmailEvent } from '../../hooks/mail-types';
import type { ThreadSummary } from '../../lib/thread-utils';
import { useI18n } from '@/lib/i18n/provider';

interface LabelRealtimeWrapperProps {
  initialThreads: ThreadSummary[];
  accountId: string;
  labelSlug: string;
  displayName: string;
  error: string | null;
  currentPage: number;
  totalPages: number;
  totalCount: number;
  pageSize: number;
  onRefetch?: () => void;
  onThreadLabelUpdate?: (threadId: string, labelName: string, action: 'add' | 'remove') => void;
}

/**
 * Client component wrapper for label views that handles real-time updates.
 *
 * Subscribes to @weldsuite/realtime for mail notifications and triggers
 * a refresh of the thread list when relevant emails arrive.
 */
export function LabelRealtimeWrapper({
  initialThreads,
  accountId,
  labelSlug,
  error: initialError,
  currentPage,
  totalPages,
  totalCount,
  pageSize,
  onRefetch,
  onThreadLabelUpdate,
}: LabelRealtimeWrapperProps) {
  const { t } = useI18n();
  const params = useParams();
  const [threads, setThreads] = useState<ThreadSummary[]>(initialThreads);
  const [error] = useState<string | null>(initialError);

  // Get the currently selected message ID from URL params
  const selectedMessageId = params?.messageId as string | undefined;

  // Update threads when initialThreads prop changes (after server refresh)
  useEffect(() => {
    setThreads(initialThreads);
  }, [initialThreads]);

  // Mark thread as read when a message is selected (optimistic UI update)
  useEffect(() => {
    if (!selectedMessageId) return;

    setThreads((prevThreads) =>
      prevThreads.map((thread) => {
        // Check if this thread contains the selected message
        const containsMessage =
          thread.latestMessageId === selectedMessageId ||
          thread.messages?.some((msg) => msg.id === selectedMessageId);

        if (containsMessage && thread.unreadCount > 0) {
          return {
            ...thread,
            unreadCount: 0,
          };
        }
        return thread;
      })
    );
  }, [selectedMessageId]);

  /**
   * Check if a new email should appear in this label view
   */
  const shouldShowInView = useCallback((): boolean => {
    const config = getSystemLabelConfig(labelSlug);

    if (!config) {
      // User label - would need to check if email has this label
      return false;
    }

    if (config.filterType === 'virtual') {
      // "All Mail" view shows everything
      return labelSlug === 'all';
    }

    // For label-based views, only show new emails in inbox
    return config.slug === 'inbox';
  }, [labelSlug]);

  /**
   * Handle new email event from real-time subscription
   * For threads, we just trigger a refresh to get updated thread grouping
   */
  const handleNewEmail = useCallback(
    (email: NewEmailEvent) => {
      if (email.accountId !== accountId) return;
      if (!shouldShowInView()) return;

      onRefetch?.();
    },
    [accountId, shouldShowInView, onRefetch]
  );

  /**
   * Handle email read status change - trigger refresh for thread updates
   */
  const handleReadStatusChange = useCallback(
    (event: { emailId: string; accountId: string; isRead: boolean }) => {
      if (event.accountId !== accountId) return;
      onRefetch?.();
    },
    [accountId, onRefetch]
  );

  /**
   * Handle email deleted - trigger refresh
   */
  const handleEmailDeleted = useCallback(
    (emailId: string, deletedAccountId: string) => {
      if (deletedAccountId !== accountId) return;
      onRefetch?.();
    },
    [accountId, onRefetch]
  );

  /**
   * Handle email archived - trigger refresh
   */
  const handleEmailArchived = useCallback(
    (emailId: string, archivedAccountId: string) => {
      if (archivedAccountId !== accountId) return;
      onRefetch?.();
    },
    [accountId, onRefetch]
  );

  /**
   * Handle email starred status change - trigger refresh
   */
  const handleEmailStarred = useCallback(
    (emailId: string, starredAccountId: string) => {
      if (starredAccountId !== accountId) return;
      onRefetch?.();
    },
    [accountId, onRefetch]
  );

  // Subscribe to real-time mail events
  const { connectionStatus, newEmailCount, resetNewEmailCount } = useMailRealtime({
    accountId,
    onNewEmail: handleNewEmail,
    onReadStatusChange: handleReadStatusChange,
    onEmailDeleted: handleEmailDeleted,
    onEmailArchived: handleEmailArchived,
    onEmailStarred: handleEmailStarred,
    showToasts: labelSlug === 'inbox', // Only show toasts for inbox
  });

  return (
    <div className="relative h-full">
      {/* Connection status indicator (optional - can be hidden) */}
      {connectionStatus === 'connecting' && (
        <div className="absolute top-2 right-2 z-10">
          <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-gray-500 bg-gray-100 rounded-full">
            <div className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
            {t.mail.splitLayout.connecting}
          </div>
        </div>
      )}

      {/* New email indicator - only show for inbox */}
      {labelSlug === 'inbox' && newEmailCount > 0 && (
        <div className="absolute -top-px left-0 right-0 z-10 flex justify-center">
          <Button
            variant="ghost"
            onClick={() => {
              onRefetch?.();
              resetNewEmailCount();
            }}
            className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-b-lg shadow-md hover:bg-gray-50 hover:text-gray-900 transition-colors"
          >
            <ChevronUp className="h-3 w-3" />
            {t.mail.splitLayout.newEmails.replace('{count}', String(newEmailCount))}
          </Button>
        </div>
      )}

      <MessageList
        threads={threads}
        accountId={accountId}
        folder={labelSlug}
        error={error}
        currentPage={currentPage}
        totalPages={totalPages}
        totalCount={totalCount}
        pageSize={pageSize}
        onThreadLabelUpdate={onThreadLabelUpdate}
      />
    </div>
  );
}
