
import React, { ReactNode } from 'react';
import { usePathname } from '@/lib/router';
import { cn } from '@/lib/utils';

export interface ListDetailLayoutProps {
  /** The list/sidebar content */
  list: ReactNode;
  /** The detail/main content area */
  children: ReactNode;
  /** Width of the list sidebar (default: 420px) */
  listWidth?: number | string;
  /** Additional className for the container */
  className?: string;
  /** Additional className for the list container */
  listClassName?: string;
  /** Additional className for the detail container */
  detailClassName?: string;
  /** Base path to determine if a detail item is selected (e.g., '/welddesk/inbox/all') */
  basePath?: string;
}

export function ListDetailLayout({
  list,
  children,
  listWidth = 420,
  className,
  listClassName,
  detailClassName,
  basePath,
}: ListDetailLayoutProps) {
  const pathname = usePathname();
  const widthStyle = typeof listWidth === 'number' ? `${listWidth}px` : listWidth;

  // Determine if a detail item is selected (pathname has more segments than basePath)
  const isDetailSelected = basePath
    ? pathname !== basePath && pathname.startsWith(basePath)
    : false;

  return (
    <div className={cn("flex h-full w-full overflow-hidden bg-white dark:bg-background", className)}>
      {/* List/Sidebar - full width on mobile, fixed width on desktop, hidden on mobile when detail is selected */}
      <div
        className={cn(
          "bg-white dark:bg-background md:border-r border-gray-200 dark:border-border flex flex-col h-full overflow-hidden",
          "w-full md:w-[var(--list-width)] md:min-w-[var(--list-width)] md:max-w-[var(--list-width)]",
          isDetailSelected && "hidden md:flex",
          listClassName
        )}
        style={{ '--list-width': widthStyle } as React.CSSProperties}
      >
        {list}
      </div>

      {/* Detail/Main Content Area - hidden on mobile when no detail selected */}
      <div
        className={cn(
          "flex-1 flex h-full overflow-hidden",
          "w-full",
          !isDetailSelected && "hidden md:flex",
          detailClassName
        )}
      >
        {children}
      </div>
    </div>
  );
}
