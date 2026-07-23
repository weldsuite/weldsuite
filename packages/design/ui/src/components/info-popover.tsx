import { Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { cn } from '@weldsuite/ui/lib/utils';

export interface InfoPopoverProps {
  /**
   * Title for the popover (optional)
   */
  title?: string | React.ReactNode;

  /**
   * The content to display in the popover.
   * Supports rich content including markdown, lists, links, etc.
   */
  children: React.ReactNode;

  /**
   * Optional custom icon size class
   * @default "h-4 w-4"
   */
  iconClassName?: string;

  /**
   * Optional side for popover positioning
   * @default "top"
   */
  side?: 'top' | 'right' | 'bottom' | 'left';

  /**
   * Optional alignment for popover
   * @default "center"
   */
  align?: 'start' | 'center' | 'end';

  /**
   * Optional custom width for popover content
   * @default "w-80" (320px)
   */
  contentClassName?: string;
}

/**
 * InfoPopover - Clickable info icon with rich popover content for detailed explanations
 *
 * @example
 * <InfoPopover title="Payment Terms">
 *   Payment terms determine when invoices are due. Common options include Net 30, Net 60, etc.
 * </InfoPopover>
 */
export function InfoPopover({
  title,
  children,
  iconClassName,
  side = 'top',
  align = 'center',
  contentClassName,
}: InfoPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          aria-label="More information"
        >
          <Info className={cn('h-4 w-4', iconClassName)} />
        </button>
      </PopoverTrigger>
      <PopoverContent side={side} align={align} className={cn('w-80', contentClassName)}>
        {title && <div className="font-semibold mb-2 text-sm">{title}</div>}
        <div className="text-sm text-muted-foreground leading-relaxed">{children}</div>
      </PopoverContent>
    </Popover>
  );
}
