import React, { ReactNode } from 'react';
import { cn } from '@weldsuite/ui/lib/utils';

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
  /**
   * Whether a detail item is currently selected. Controls the responsive
   * mobile behaviour: when `true` the list is hidden and the detail pane is
   * shown on small screens; when `false` the list is shown and the detail
   * pane is hidden. On `md+` both are always visible. Defaults to `false`.
   *
   * Callers wired to a router typically derive this from the pathname, e.g.
   * `pathname !== basePath && pathname.startsWith(basePath)`.
   */
  isDetailSelected?: boolean;
}

export function ListDetailLayout({
  list,
  children,
  listWidth = 420,
  className,
  listClassName,
  detailClassName,
  isDetailSelected = false,
}: ListDetailLayoutProps) {
  const widthStyle = typeof listWidth === 'number' ? `${listWidth}px` : listWidth;

  return (
    <div
      className={cn(
        'flex h-full w-full overflow-hidden bg-white dark:bg-background',
        className,
      )}
    >
      {/* List/Sidebar - full width on mobile, fixed width on desktop, hidden on mobile when detail is selected */}
      <div
        className={cn(
          'bg-white dark:bg-background md:border-r border-gray-200 dark:border-border flex flex-col h-full overflow-hidden',
          'w-full md:w-[var(--list-width)] md:min-w-[var(--list-width)] md:max-w-[var(--list-width)]',
          isDetailSelected && 'hidden md:flex',
          listClassName,
        )}
        style={{ '--list-width': widthStyle } as React.CSSProperties}
      >
        {list}
      </div>

      {/* Detail/Main Content Area - hidden on mobile when no detail selected */}
      <div
        className={cn(
          'flex-1 flex h-full overflow-hidden',
          'w-full',
          !isDetailSelected && 'hidden md:flex',
          detailClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}
