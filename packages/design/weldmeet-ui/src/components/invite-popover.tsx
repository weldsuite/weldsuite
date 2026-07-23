import { type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';

export interface InvitePopoverProps {
  /** Slot — host app provides its own content (e.g. workspace member search). */
  popoverContent: ReactNode;
}

/**
 * The small "+" trigger next to the join-code chip in the meeting header.
 * Content is a slot so the host app can plug in workspace-member-aware UI.
 */
export function InvitePopover({ popoverContent }: InvitePopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          title="Invite people"
          className="flex items-center justify-center h-8 w-8 rounded-md border bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-[340px] p-0">
        {popoverContent}
      </PopoverContent>
    </Popover>
  );
}
