import React from 'react';
import { format, isToday, setHours } from 'date-fns';
import { cn } from '@/lib/utils';

/**
 * Shared visual primitives for the calendar week / day / 4-day grids.
 *
 * Both the main calendar (calendar-view.tsx) AND the booking-page calendars
 * (scheduling/[id]/view-page.tsx, scheduling/new/page.tsx) import these so
 * any design tweak made here flows to every surface — header heights, today
 * coloring, time-label gutter, scrollbar treatment, etc. all stay in lockstep.
 *
 * If you need to change the calendar's look, change it HERE.
 */

export const HOURS = Array.from({ length: 24 }, (_, i) => i);

/** Brand blue used for today's highlights across every calendar surface. */
export const TODAY_BLUE = '#3073f1';

/** Today column header background tint (also used for unavailable hours). */
export const TODAY_BG_CLASS = 'bg-zinc-50/60 dark:bg-zinc-900/30';

/** Default per-hour row height in px. */
export const DEFAULT_HOUR_HEIGHT = 48;

/** Width of the leading time-label column (always 72px). */
export const TIME_LABEL_WIDTH = 72;

/** Header strip height — kept stable so nothing reflows when switching views. */
export const HEADER_HEIGHT = 78.5;

// ---------------------------------------------------------------------------

/**
 * The row of day headers shown above a week / 4-day / day calendar.
 * Pass `days` as 1..7 dates; the component decorates today's column with the
 * shared blue text + zinc-50 background.
 */
export function WeekDayHeader({ days }: { days: Date[] }) {
  return (
    <div
      className="grid border-b sticky top-0 bg-background z-[5]"
      style={{
        height: `${HEADER_HEIGHT}px`,
        gridTemplateColumns: `var(--cal-time-label-width, ${TIME_LABEL_WIDTH}px) repeat(${days.length}, 1fr)`,
      }}
    >
      <div className="border-r border-border" />
      {days.map((day) => {
        const today = isToday(day);
        return (
          <div
            key={day.toISOString()}
            className={cn(
              'text-center flex flex-col items-center justify-center border-r border-border last:border-r-0',
              today && TODAY_BG_CLASS,
            )}
          >
            <div
              className={cn(
                'text-[11px] font-medium uppercase tracking-wide',
                today ? `font-semibold` : 'text-muted-foreground',
              )}
              style={today ? { color: TODAY_BLUE } : undefined}
            >
              {format(day, 'EEE')}
            </div>
            <div
              className={cn(
                'text-[22px] font-medium leading-tight mt-1',
                today ? 'font-semibold' : 'text-foreground',
              )}
              style={today ? { color: TODAY_BLUE } : undefined}
            >
              {format(day, 'd')}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * The leading column of hour labels (12 AM, 1 AM … 11 PM). Always 72px wide,
 * with the label nudged up `-7px` so the digits sit on the hour gridline like
 * macOS Calendar / Google Calendar.
 */
export function TimeLabelColumn({ hourHeight = DEFAULT_HOUR_HEIGHT }: { hourHeight?: number }) {
  return (
    <div className="border-r border-border">
      {HOURS.map((hour) => (
        <div
          key={hour}
          className="flex items-start justify-end pr-3 relative"
          style={{ height: hourHeight }}
        >
          <span className="text-[11px] text-muted-foreground -mt-[7px] tabular-nums">
            {hour === 0 ? '' : format(setHours(new Date(), hour), 'h a')}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Outer scrollable shell for the time grid. Uses the same hidden-scrollbar
 * trick as the main calendar so column widths never reflow when content
 * overflows. The `forwardRef` lets callers measure the container height for
 * dynamic hour-row sizing.
 */
export const TimeGridScroll = React.forwardRef<HTMLDivElement, { children: React.ReactNode; className?: string }>(
  function TimeGridScroll({ children, className }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'flex-1 min-h-0 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]',
          className,
        )}
      >
        {children}
      </div>
    );
  },
);

// ---------------------------------------------------------------------------

/**
 * Inner grid wrapping the time labels + day columns. Kept as a separate helper
 * so callers can position absolutely inside the same parent (events, drag
 * ghosts, current-time indicator, availability blocks, etc.).
 */
export function TimeGridInner({
  days,
  children,
  style,
}: {
  days: Date[];
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className="grid relative"
      style={{
        gridTemplateColumns: `var(--cal-time-label-width, ${TIME_LABEL_WIDTH}px) repeat(${days.length}, 1fr)`,
        minHeight: '100%',
        ...style,
      }}
    >
      {children}
    </div>
  );
}
