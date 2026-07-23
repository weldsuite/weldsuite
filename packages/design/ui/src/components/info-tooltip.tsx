import { Info } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import { cn } from '@weldsuite/ui/lib/utils';

export interface InfoTooltipProps {
  /**
   * The content to display in the tooltip.
   * Can be a string (static text or translated text)
   */
  content: string | React.ReactNode;

  /**
   * Optional custom icon size class
   * @default "h-4 w-4"
   */
  iconClassName?: string;

  /**
   * Optional side for tooltip positioning
   * @default "top"
   */
  side?: 'top' | 'right' | 'bottom' | 'left';

  /**
   * Optional alignment for tooltip
   * @default "center"
   */
  align?: 'start' | 'center' | 'end';

  /**
   * Optional delay before showing tooltip (ms)
   * @default 0
   */
  delayDuration?: number;
}

/**
 * InfoTooltip - Small info icon with tooltip for quick explanations
 *
 * @example
 * <InfoTooltip content="This is a helpful tip" />
 *
 * @example
 * <InfoTooltip content="Help text" side="right" align="start" />
 */
export function InfoTooltip({
  content,
  iconClassName,
  side = 'top',
  align = 'center',
  delayDuration = 0,
}: InfoTooltipProps) {
  return (
    <TooltipProvider delayDuration={delayDuration}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            aria-label="More information"
          >
            <Info className={cn('h-4 w-4', iconClassName)} />
          </button>
        </TooltipTrigger>
        <TooltipContent side={side} align={align}>
          <div className="max-w-xs">{content}</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
