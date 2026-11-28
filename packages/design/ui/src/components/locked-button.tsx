'use client';

import { useId, type ComponentProps, type MouseEvent } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { cn } from '@weldsuite/ui/lib/utils';

export interface LockedButtonProps extends Omit<ComponentProps<typeof Button>, 'disabled'> {
  /**
   * Why the action is not available right now, in words. While set the button
   * does nothing, looks disabled and says why on hover and focus; left out it
   * is an ordinary button.
   */
  lockedReason?: string | null;
  /** Disabled for a reason that needs no explanation (a request is running). */
  disabled?: boolean;
}

/**
 * A button that stays reachable while it is locked. A native `disabled` button
 * leaves the tab order and cannot explain itself; this one uses
 * `aria-disabled`, so a keyboard or screen reader user lands on it, hears the
 * reason (an `aria-describedby` text) and a mouse user sees it in a tooltip.
 * Activation is blocked in the click handler. It holds no translations.
 */
export function LockedButton({ lockedReason, disabled, onClick, className, children, ...props }: Readonly<LockedButtonProps>) {
  const reasonId = useId();
  if (!lockedReason) {
    return (
      <Button {...props} disabled={disabled} onClick={onClick} className={className}>
        {children}
      </Button>
    );
  }
  const block = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          {...props}
          aria-disabled="true"
          aria-describedby={reasonId}
          onClick={block}
          className={cn('cursor-not-allowed opacity-50 hover:bg-transparent', className)}
        >
          {children}
          <span id={reasonId} className="sr-only">
            {lockedReason}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{lockedReason}</TooltipContent>
    </Tooltip>
  );
}
