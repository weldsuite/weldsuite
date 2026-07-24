
import React from 'react';
import { usePathname } from '@/lib/router';
import { cn } from '@/lib/utils';

interface MobileMailLayoutProps {
  list: React.ReactNode;
  detail: React.ReactNode;
  accountId: string;
  labelSlug: string;
}

/**
 * Mobile-aware mail layout component.
 * On mobile: Shows list when no message selected, shows detail when message selected
 * On desktop: Shows both side by side
 */
export function MobileMailLayout({ list, detail }: MobileMailLayoutProps) {
  const pathname = usePathname();

  // Check if we're viewing a specific message (has messageId in path)
  // Path pattern: /mail/[accountId]/[labelSlug]/[messageId]
  const pathParts = pathname?.split('/').filter(Boolean) || [];
  const hasMessageSelected = pathParts.length >= 4 && pathParts[0] === 'weldmail';

  // Check if we're in compose mode
  const isComposing = pathname?.includes('/compose');

  // Should show detail on mobile
  const showDetailOnMobile = hasMessageSelected || isComposing;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-white dark:bg-background">
      <div className="flex flex-1 overflow-hidden">
        {/* Thread List */}
        {/* Desktop: Always visible with fixed width */}
        {/* Mobile: Hidden when viewing a message or composing */}
        <div
          className={cn(
            "w-full md:w-[420px] flex-shrink-0 md:border-r border-gray-200 dark:border-border overflow-hidden",
            showDetailOnMobile ? "hidden md:block" : "block"
          )}
        >
          {list}
        </div>

        {/* Message Detail or Compose */}
        {/* Desktop: Always visible, takes remaining space */}
        {/* Mobile: Only visible when message selected or composing */}
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
