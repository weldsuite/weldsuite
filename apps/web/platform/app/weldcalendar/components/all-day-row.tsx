import React, { useMemo } from 'react';
import { format, isToday } from 'date-fns';
import { cn } from '@/lib/utils';
import type { CalendarEvent } from '@/hooks/queries/use-calendar-queries';
import { layoutAllDayRow } from '../lib/event-days';
import { MonthEventChip } from './month-event-chip';
import { TIME_LABEL_WIDTH, TODAY_BG_CLASS } from './calendar-shared';

/** Height of one lane (bar + breathing room), in px. */
const LANE_HEIGHT = 24;
/** Lanes shown before the row scrolls. */
const MAX_VISIBLE_LANES = 4;

interface AllDayRowProps {
  /** The visible days, left to right (1 for Day view, 4 for 4 Days, 7 for Week). */
  days: Date[];
  events: CalendarEvent[];
  getColor: (event: CalendarEvent) => string;
  /** Same handler the time-grid events use, so the detail panel opens. */
  onSelectEvent: (event: CalendarEvent, mouseEvent: React.MouseEvent) => void;
  allDayLabel: string;
  autoScheduledLabel: string;
}

/**
 * The strip between the day headers and the time grid that lists all-day and
 * multi-day events. A bar spans every visible day the event covers; bars that
 * continue past the visible window lose their rounded corner on that side.
 *
 * It sits outside the scrolling time grid and uses the same column template as
 * the day header, so its columns line up with the grid below.
 */
export function AllDayRow({ days, events, getColor, onSelectEvent, allDayLabel, autoScheduledLabel }: Readonly<AllDayRowProps>) {
  const { bars, laneCount } = useMemo(() => layoutAllDayRow(events, days), [events, days]);
  const lanes = Math.max(laneCount, 1);

  return (
    <div
      data-all-day-row
      className="grid shrink-0 border-b bg-background overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
      style={{
        gridTemplateColumns: `var(--cal-time-label-width, ${TIME_LABEL_WIDTH}px) repeat(${days.length}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${lanes}, ${LANE_HEIGHT}px)`,
        maxHeight: MAX_VISIBLE_LANES * LANE_HEIGHT + 2,
      }}
    >
      <div
        className="border-r border-border flex items-start justify-end pr-3 pt-1 text-[11px] text-muted-foreground"
        style={{ gridColumn: 1, gridRow: `1 / span ${lanes}` }}
      >
        {allDayLabel}
      </div>

      {days.map((day, i) => (
        <div
          key={format(day, 'yyyy-MM-dd')}
          className={cn('border-r border-border last:border-r-0', isToday(day) && TODAY_BG_CLASS)}
          style={{ gridColumn: i + 2, gridRow: `1 / span ${lanes}` }}
        />
      ))}

      {bars.map((bar, i) => (
        <div
          key={bar.event.id || i}
          className="min-w-0 px-0.5 py-0.5"
          style={{ gridColumn: `${bar.startCol + 2} / ${bar.endCol + 3}`, gridRow: bar.lane + 1 }}
        >
          <MonthEventChip
            color={getColor(bar.event)}
            time={null}
            title={bar.event.title}
            status={bar.event.status}
            autoScheduled={bar.event.autoScheduled === true}
            autoScheduledLabel={autoScheduledLabel}
            className={cn(
              'hover:brightness-95',
              bar.continuesBefore && 'rounded-l-none',
              bar.continuesAfter && 'rounded-r-none',
            )}
            onClick={(e) => onSelectEvent(bar.event, e)}
          />
        </div>
      ))}
    </div>
  );
}
