import type { ComponentProps, CSSProperties, MouseEvent } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';

/**
 * Shared class list for every chip in a month-view day cell. The fixed height
 * matches `MONTH_CHIP_HEIGHT` in `../lib/month-layout` so the number of chips
 * that fit in a cell can be computed from the row height alone.
 */
export const MONTH_CHIP_CLASS =
  'h-5 w-full min-w-0 justify-start gap-1 px-1.5 py-0 rounded-[6px] text-left text-[11px] leading-none font-medium border-0 text-white transition-all';

interface MonthEventChipProps
  extends Omit<ComponentProps<typeof Button>, 'children' | 'style'> {
  /** Start time, e.g. "5:10 PM" or "17:10". Omitted for all-day events. Never truncated. */
  time?: string | null;
  title: string;
  color: string;
  /** Marks the event as placed by the auto-scheduler. */
  autoScheduled?: boolean;
  /** Accessible name / tooltip of the auto-scheduled marker ("Auto-scheduled"). */
  autoScheduledLabel?: string;
  style?: CSSProperties;
}

/**
 * One event chip in the month grid (also used for the bars of the all-day
 * row). The time and the title are separate elements: only the title shrinks
 * and ellipsises, so a long title can never push the start of the time label
 * out of view.
 */
export function MonthEventChip({
  time,
  title,
  color,
  autoScheduled,
  autoScheduledLabel,
  className,
  style,
  ...props
}: MonthEventChipProps) {
  return (
    <Button
      variant="ghost"
      className={cn(MONTH_CHIP_CLASS, className)}
      style={{ backgroundColor: color, ...style }}
      {...props}
    >
      {time ? (
        <span data-slot="chip-time" className="shrink-0 tabular-nums">
          {time}
        </span>
      ) : null}
      <span data-slot="chip-title" className="min-w-0 flex-1 truncate text-left">
        {title}
      </span>
      {autoScheduled ? (
        <span
          data-slot="chip-auto-scheduled"
          role="img"
          aria-label={autoScheduledLabel}
          title={autoScheduledLabel}
          className="shrink-0 opacity-80"
        >
          <Sparkles className="h-2.5 w-2.5" aria-hidden />
        </span>
      ) : null}
    </Button>
  );
}

interface MonthMoreButtonProps {
  label: string;
  onClick: (e: MouseEvent) => void;
}

/** The "+N more" line at the bottom of an overflowing day cell. */
export function MonthMoreButton({ label, onClick }: MonthMoreButtonProps) {
  return (
    <Button
      variant="ghost"
      data-slot="month-more"
      className="h-5 w-full justify-start px-1.5 py-0 rounded-[6px] text-left text-[11px] leading-none font-medium text-muted-foreground hover:text-foreground"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}
