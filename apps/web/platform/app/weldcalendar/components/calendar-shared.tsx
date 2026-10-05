import React from 'react';
import { format, isToday, setHours } from 'date-fns';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { cn } from '@/lib/utils';
import type { TimeRange } from '@/hooks/queries/use-calendar-queries';
import { formatClockCompact } from '../lib/calendar-format';
import type { TimeFormat } from '../lib/calendar-format';

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
export function WeekDayHeader({ days }: Readonly<{ days: Date[] }>) {
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

/** "1 PM" in 12h, "13:00" in 24h. */
export function formatHourLabel(hour: number, timeFormat: TimeFormat): string {
  const d = setHours(new Date(2000, 0, 1), hour);
  return format(d, timeFormat === '24h' ? 'HH:mm' : 'h a');
}

/**
 * The leading column of hour labels (12 AM, 1 AM … 11 PM). Always 72px wide,
 * with the label nudged up `-7px` so the digits sit on the hour gridline like
 * macOS Calendar / Google Calendar.
 */
export function TimeLabelColumn({
  hourHeight = DEFAULT_HOUR_HEIGHT,
  timeFormat = '12h',
}: Readonly<{
  hourHeight?: number;
  /** Follows the user's clock preference ("1 PM" vs "13:00"); 12h when omitted. */
  timeFormat?: TimeFormat;
}>) {
  return (
    <div className="border-r border-border">
      {HOURS.map((hour) => (
        <div
          key={hour}
          className="flex items-start justify-end pr-3 relative"
          style={{ height: hourHeight }}
        >
          <span className="text-[11px] text-muted-foreground -mt-[7px] tabular-nums">
            {hour === 0 ? '' : formatHourLabel(hour, timeFormat)}
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
}: Readonly<{
  days: Date[];
  children: React.ReactNode;
  style?: React.CSSProperties;
}>) {
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

// ---------------------------------------------------------------------------

/** Diagonal hatch (sky-500) marking buffer time around a bookable slot. */
const BUFFER_HATCH = 'repeating-linear-gradient(135deg, rgb(14 165 233 / 0.3) 0 1px, transparent 1px 6px)';

/**
 * One availability window of a booking page, drawn in a day column: a single
 * tinted block labelled with its hours, split by hairlines into the slots a
 * guest can book. Buffer time between slots is hatched instead of filled.
 *
 * With `onSlotClick` each slot becomes a button reporting its start / end as
 * minutes since midnight; without it the block is purely decorative. A
 * hovered slot turns into one solid area (no dividers or hour gridlines
 * running through it) showing `slotHint`.
 */
export function AvailabilityBlock({
  block,
  hourHeight,
  duration,
  bufferBefore,
  bufferAfter,
  timeFormat = '12h',
  onSlotClick,
  slotHint,
}: Readonly<{
  block: TimeRange;
  hourHeight: number;
  duration: number;
  bufferBefore: number;
  bufferAfter: number;
  timeFormat?: TimeFormat;
  onSlotClick?: (startMinutes: number, endMinutes: number) => void;
  /** Shown inside a clickable slot while it is hovered, e.g. "Click to schedule". */
  slotHint?: string;
}>) {
  const [startH, startM] = block.start.split(':').map(Number);
  const [endH, endM] = block.end.split(':').map(Number);
  const totalMin = endH * 60 + endM - (startH * 60 + startM);
  const slotWithBuffer = duration + bufferBefore + bufferAfter;
  const slotCount = Math.floor(totalMin / slotWithBuffer);
  const pxPerMin = hourHeight / 60;
  const topPx = (startH * 60 + startM) * pxPerMin;
  const blockHeightPx = totalMin * pxPerMin;
  const slotWithBufferPx = slotWithBuffer * pxPerMin;
  const bufferBeforePx = bufferBefore * pxPerMin;
  const bufferAfterPx = bufferAfter * pxPerMin;
  const durationPx = duration * pxPerMin;
  const hasBuffer = bufferBefore + bufferAfter > 0;
  const rangeLabel = (fromMin: number, toMin: number) =>
    `${formatClockCompact(new Date(2000, 0, 1, 0, fromMin), timeFormat)} – ${formatClockCompact(new Date(2000, 0, 1, 0, toMin), timeFormat)}`;
  const blockStartMin = startH * 60 + startM;

  const slotStartMin = (i: number) => blockStartMin + i * slotWithBuffer + bufferBefore;

  return (
    <div
      className="absolute left-[3px] right-[3px] rounded-[6px] overflow-hidden bg-sky-500/[0.07]"
      style={{ top: `${topPx}px`, height: `${blockHeightPx}px` }}
    >
      {Array.from({ length: slotCount }, (_, i) => {
        const slotTop = i * slotWithBufferPx;
        return (
          <React.Fragment key={i}>
            {bufferBefore > 0 && (
              <div
                className="absolute inset-x-0"
                style={{ top: `${slotTop}px`, height: `${bufferBeforePx}px`, backgroundImage: BUFFER_HATCH }}
              />
            )}
            <AvailabilitySlot
              // Back-to-back slots need a divider; buffers already separate them.
              divided={i > 0 && !hasBuffer}
              first={i === 0}
              top={slotTop + bufferBeforePx}
              height={durationPx}
              label={rangeLabel(slotStartMin(i), slotStartMin(i) + duration)}
              hint={slotHint}
              onClick={onSlotClick ? () => onSlotClick(slotStartMin(i), slotStartMin(i) + duration) : undefined}
            />
            {bufferAfter > 0 && (
              <div
                className="absolute inset-x-0"
                style={{ top: `${slotTop + bufferBeforePx + durationPx}px`, height: `${bufferAfterPx}px`, backgroundImage: BUFFER_HATCH }}
              />
            )}
          </React.Fragment>
        );
      })}
      {blockHeightPx - bufferBeforePx >= 20 && (
        <div
          // Steps aside while the slot it sits in is hovered, leaving that
          // slot to its "click to schedule" hint.
          className="absolute inset-x-2 truncate text-[11px] font-medium leading-none text-sky-700 dark:text-sky-300 tabular-nums pointer-events-none transition-opacity [[data-first-slot]:hover~&]:opacity-0"
          style={{ top: `${bufferBeforePx + 6}px` }}
        >
          {rangeLabel(blockStartMin, blockStartMin + totalMin)}
        </div>
      )}
      {/* Outline drawn last so a hovered (opaque) slot cannot cover it. */}
      <div className="absolute inset-0 rounded-[6px] ring-1 ring-inset ring-sky-500/25 pointer-events-none" />
    </div>
  );
}

/** One bookable slot inside an `AvailabilityBlock`; a button when clickable. */
function AvailabilitySlot({
  divided,
  first,
  top,
  height,
  label,
  hint,
  onClick,
}: Readonly<{
  divided: boolean;
  /** The block's first slot, where the block's hours label sits. */
  first: boolean;
  top: number;
  height: number;
  label: string;
  hint?: string;
  onClick?: () => void;
}>) {
  const className = cn(
    'absolute inset-x-0 bg-sky-500/[0.13]',
    // The divider also goes when the slot above is hovered, so that slot
    // reads as one clean area.
    divided && 'border-t border-sky-500/25 [:hover+&]:border-transparent',
  );
  const style = { top: `${top}px`, height: `${height}px` };
  if (!onClick) return <div className={className} style={style} />;
  return (
    // The tooltip sits over the neighbouring slot, so it must never take the
    // pointer: otherwise moving onto that slot hovers the tooltip instead.
    // `data-pointer-through` (globals.css) covers Radix's wrapper around it.
    <Tooltip disableHoverableContent>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-first-slot={first || undefined}
          onClick={onClick}
          className={cn(
            className,
            // Opaque on hover: a see-through tint would leave the hour
            // gridlines underneath showing through the slot.
            'group/slot flex items-center justify-center cursor-pointer transition-colors hover:border-transparent hover:bg-[color-mix(in_srgb,var(--color-sky-500)_32%,var(--background))] focus-visible:outline-none focus-visible:bg-[color-mix(in_srgb,var(--color-sky-500)_38%,var(--background))]',
          )}
          style={style}
        >
          {hint && height >= 20 && (
            <span className="truncate px-2 text-[12px] font-medium text-sky-700 dark:text-sky-200 opacity-0 transition-opacity group-hover/slot:opacity-100">
              {hint}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent data-pointer-through side="top" sideOffset={4} className="tabular-nums pointer-events-none">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
