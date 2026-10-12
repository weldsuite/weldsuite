/**
 * The round button something floating shrinks to when it is put aside: a
 * minimized mail (`FloatingComposePanel`) or a minimized note
 * (`GlobalPinnedNote`). An icon for the kind of thing, a small avatar badge for
 * who or what it is about, its name on hover to the left, and a dismiss cross
 * on hover.
 *
 * Several of them (minimized mails) sit in a `group/stack` container and tuck
 * behind one another until the stack is hovered; `stacked` and `front` are for
 * that and default to a lone button.
 */

import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';

/** Room one docked button takes next to another floating thing: the button plus a gap. */
export const MINIMIZED_DOCK_ROOM = '44px';

/** How far from the right edge the dock sits: clear of WeldAgent when it is open. */
export function minimizedDockRight(
  mobileNav: { showWeldAgent?: boolean; weldAgentWidth?: number } | null | undefined,
): string {
  return mobileNav?.showWeldAgent ? `${(mobileNav?.weldAgentWidth ?? 480) + 12}px` : '12px';
}

export function MinimizedDockButton({
  label,
  icon,
  avatarUrl,
  avatarAlt,
  avatarFallback,
  stacked = false,
  front = true,
  onOpen,
  onDismiss,
  openLabel,
  dismissLabel,
  testId,
  dismissTestId,
}: Readonly<{
  /** Shown on hover, to the left of the button. */
  label: string;
  /** `size-4 text-foreground`, e.g. a lucide icon. */
  icon: ReactNode;
  avatarUrl?: string | null;
  avatarAlt?: string;
  /** Inside the badge when there is no image, e.g. a `size-2` icon. */
  avatarFallback: ReactNode;
  /** Tucked behind the one below it until the stack is hovered. */
  stacked?: boolean;
  /** The one in front of the stack; the others only show their badge once fanned out. */
  front?: boolean;
  onOpen: () => void;
  onDismiss: () => void;
  openLabel: string;
  dismissLabel: string;
  testId?: string;
  dismissTestId?: string;
}>) {
  return (
    <div
      className={cn(
        'group/item relative transition-[margin] duration-[225ms] ease-out',
        stacked && '-mt-[21px] group-hover/stack:mt-2 group-focus-within/stack:mt-2',
      )}
    >
      <span className="pointer-events-none absolute right-full top-1/2 mr-2 max-w-[240px] -translate-y-1/2 truncate rounded-md border border-border bg-background px-[9px] py-[5px] text-[13px] leading-[18px] font-medium text-foreground shadow-lg opacity-0 transition-opacity group-hover/item:opacity-100 group-focus-within/item:opacity-100">
        {label}
      </span>
      <Button
        variant="outline"
        size="icon"
        onClick={onOpen}
        className="relative h-9 w-9 rounded-full bg-background shadow-lg dark:bg-background dark:hover:bg-muted"
        aria-label={openLabel}
        data-testid={testId}
      >
        {icon}
        <Avatar
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 !rounded-[5px] bg-background ring-2 ring-background',
            !front && 'opacity-0 transition-opacity duration-[225ms] group-hover/stack:opacity-100 group-focus-within/stack:opacity-100',
          )}
        >
          {avatarUrl && <AvatarImage src={avatarUrl} alt={avatarAlt} className="!rounded-[5px]" />}
          <AvatarFallback className="!rounded-[5px] bg-gray-200 dark:bg-accent">{avatarFallback}</AvatarFallback>
        </Avatar>
      </Button>
      <button
        type="button"
        onClick={onDismiss}
        className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/item:opacity-100"
        title={dismissLabel}
        aria-label={dismissLabel}
        data-testid={dismissTestId}
      >
        <X className="size-2.5" />
      </button>
    </div>
  );
}
