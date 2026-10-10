
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

export function MailSplitLayout({ list, detail, className }: Readonly<MailSplitLayoutProps>) {
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
  let newCount = 0;
  if (stats) {
    newCount = labelSlug === 'inbox' ? stats.inboxUnread : stats.unread;
  }

  return (
    <div className="h-full hidden md:flex flex-col items-center justify-center text-center px-6">
      <EmptyStateIllustration>
        {/* WeldMail logo as a mask, so it takes the theme colour instead of the brand orange */}
        <span
          aria-hidden="true"
          className="block w-20 aspect-[937/669] bg-muted-foreground/20 [mask:url(/assets/images/weldmail/icon.svg)_center/contain_no-repeat]"
        />
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
