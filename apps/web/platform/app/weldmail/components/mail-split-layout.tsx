
import React from 'react';
import { usePathname, useParams } from '@/lib/router';
import { cn } from '@/lib/utils';
import { EmptyStateIllustration } from '@/components/entity-list';
import { useI18n } from '@/lib/i18n/provider';
import { useMailMessageStats } from '@/hooks/queries/use-mail-queries';

interface MailSplitLayoutProps {
  list: React.ReactNode;
  detail: React.ReactNode;
  className?: string;
}

export function MailSplitLayout({ list, detail, className }: MailSplitLayoutProps) {
  const pathname = usePathname();

  // Check if we're viewing a specific message (has messageId in path)
  // Path pattern: /mail/[accountId]/[labelSlug]/[messageId]
  const pathParts = pathname?.split('/').filter(Boolean) || [];
  const hasMessageSelected = pathParts.length >= 4 && pathParts[0] === 'weldmail';
  const isComposing = pathname?.includes('/compose');
  const showDetailOnMobile = hasMessageSelected || isComposing;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-white dark:bg-background">
      {/* Main Content Area */}
      <div className={cn('flex flex-1 overflow-hidden', className)}>
        {/* Message List - Fixed width on desktop, full width on mobile */}
        <div
          className={cn(
            "w-full md:w-[420px] flex-shrink-0 md:border-r border-gray-200 dark:border-border overflow-hidden",
            showDetailOnMobile ? "hidden md:block" : "block"
          )}
        >
          {list}
        </div>

        {/* Message Detail - Flexible width */}
        <div
          className={cn(
            "flex-1 overflow-hidden bg-white dark:bg-background",
            showDetailOnMobile ? "block" : "hidden md:block"
          )}
        >
          {detail}
        </div>
      </div>
    </div>
  );
}

// Empty state component for when no message is selected
// Only shown on desktop; on mobile, the list fills the screen
export function EmptyDetailState() {
  const { t } = useI18n();
  const params = useParams<{ accountId: string; labelSlug: string }>();
  const accountId = params?.accountId;
  const labelSlug = params?.labelSlug ? decodeURIComponent(params.labelSlug) : '';

  // "New emails" = unread. On the inbox we surface the inbox-specific unread
  // count; on any other folder's empty state we fall back to the account-wide
  // unread total (the only other reliably-populated stat).
  const statsQuery = useMailMessageStats(accountId, !!accountId);
  const stats = statsQuery.data?.data;
  const newCount = stats ? (labelSlug === 'inbox' ? stats.inboxUnread : stats.unread) : 0;

  return (
    <div className="h-full hidden md:flex flex-col items-center justify-center text-center px-6">
      <EmptyStateIllustration>
        <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          {/* Envelope body */}
          <rect x="20" y="35" width="80" height="55" rx="4" className="fill-white dark:fill-secondary" />
          <rect x="20" y="35" width="80" height="55" rx="4" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" />
          {/* Bottom V fold lines */}
          <path d="M20 90L52 65" className="stroke-gray-100 dark:stroke-border" strokeWidth="1" />
          <path d="M100 90L68 65" className="stroke-gray-100 dark:stroke-border" strokeWidth="1" />
          {/* Envelope flap background */}
          <path d="M20.5 38C20.5 36.3 21.8 35 23.5 35H96.5C98.2 35 99.5 36.3 99.5 38L60 64Z" className="fill-gray-50 dark:fill-border/30" />
          {/* Envelope flap stroke */}
          <path d="M20 35L60 64L100 35" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" fill="none" />
        </svg>
      </EmptyStateIllustration>
      <h3 className="text-[15px] font-semibold text-foreground mb-1.5">{t.mail.emptyState.selectMessage}</h3>
      <p className="text-sm text-muted-foreground max-w-[320px] leading-relaxed">{t.mail.emptyState.selectMessageDescription}</p>
      {newCount > 0 && (
        <p className="mt-4 text-sm font-medium text-foreground">
          {(newCount === 1 ? t.mail.emptyState.newEmails : t.mail.emptyState.newEmailsPlural).replace(
            '{count}',
            newCount.toLocaleString(),
          )}
        </p>
      )}
    </div>
  );
}
