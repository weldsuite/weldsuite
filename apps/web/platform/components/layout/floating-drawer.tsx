import * as React from 'react';
import { cn } from '@/lib/utils';

interface FloatingDrawerProps extends React.ComponentPropsWithoutRef<'div'> {
  isOpen: boolean;
  /** Desktop width in px. Mobile is always a full-screen sheet. */
  width?: number;
  /** Skip the open animation (e.g. when swapping between drawers). */
  skipAnimation?: boolean;
}

/**
 * Shared shell for the top-nav drawers (notifications / calendar / agent).
 *
 * It renders as an in-flow flex sibling inside `ModuleContent`'s content row —
 * a rounded white card at a fixed width, stretched to fill the row height. The
 * row's `gap` provides the spacing to the panel / content on its left, so there
 * is no positioning or reservation logic here. On mobile it becomes a
 * full-screen sheet on top of the content.
 *
 * Renders nothing while closed. Callers supply the drawer's header + body as
 * children (keep them in the usual `flex flex-col` / `flex-1` pattern).
 */
export function FloatingDrawer({
  isOpen,
  width = 400,
  skipAnimation,
  className,
  style,
  children,
  ...rest
}: FloatingDrawerProps) {
  if (!isOpen) return null;

  return (
    <div
      {...rest}
      className={cn(
        'flex flex-col overflow-hidden bg-white dark:bg-background',
        // Desktop: in-flow rounded card sibling in the content row.
        'md:h-full md:shrink-0 md:rounded-xl',
        // Mobile: full-screen sheet below the mobile header.
        'max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:top-[56px] max-md:z-50 max-md:!w-full',
        !skipAnimation && 'animate-in slide-in-from-right fade-in-50 duration-200',
        className,
      )}
      style={{ width, ...style }}
    >
      {children}
    </div>
  );
}
