import { format } from 'date-fns';
import { Loader2 } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import type { CalendarEvent } from '@/hooks/queries/use-calendar-queries';
import { EVENT_TYPE_COLORS } from '../lib/event-form-schema';
import { formatClock, formatClockRange, type TimeFormat } from '../lib/calendar-format';
import { eventStatusKind, statusDotStyle, statusRowClass, statusTitleClass } from '../lib/event-status';
import { cn } from '@/lib/utils';

interface CalendarSearchResultsProps {
  results: CalendarEvent[];
  isSearching: boolean;
  calendarColorMap: Record<string, string>;
  timeFormat: TimeFormat;
  onSelect: (event: CalendarEvent) => void;
}

function resultColor(event: CalendarEvent, calendarColorMap: Record<string, string>): string {
  return (
    event.color ||
    (event.calendarId ? calendarColorMap[event.calendarId] : undefined) ||
    EVENT_TYPE_COLORS[event.type] ||
    '#3b82f6'
  );
}

/** "Mon, Oct 5, 2026 · 6:00 PM – 7:00 PM" (date only for all-day events). */
function resultWhen(event: CalendarEvent, timeFormat: TimeFormat, allDayLabel: string): string {
  const start = new Date(event.startTime);
  const day = format(start, 'EEE, MMM d, yyyy');
  if (event.allDay) return `${day} · ${allDayLabel}`;
  const end = event.endTime ? new Date(event.endTime) : null;
  if (!end || end.getTime() <= start.getTime()) return `${day} · ${formatClock(start, timeFormat)}`;
  return `${day} · ${formatClockRange(start, end, timeFormat)}`;
}

/**
 * Events-search results across all dates, shown in place of the calendar grid
 * while the toolbar search box has text.
 */
export function CalendarSearchResults({
  results,
  isSearching,
  calendarColorMap,
  timeFormat,
  onSelect,
}: Readonly<CalendarSearchResultsProps>) {
  const t = getTranslations('weldcalendar');

  if (results.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-8 text-sm text-muted-foreground" role="status">
        {isSearching ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {t.calendarView.searchSearching}
          </>
        ) : (
          t.calendarView.searchNoResults
        )}
      </div>
    );
  }

  return (
    <ul className="flex-1 min-h-0 overflow-y-auto divide-y" aria-busy={isSearching}>
      {results.map((evt) => {
        const kind = eventStatusKind(evt);
        const statusLabel =
          kind === 'cancelled'
            ? t.calendarView.filterStatusCancelled
            : kind === 'tentative'
              ? t.calendarView.filterStatusTentative
              : null;
        return (
          <li key={evt.id ?? `${evt.title}-${String(evt.startTime)}`}>
            <button
              type="button"
              onClick={() => onSelect(evt)}
              data-status={statusLabel ? kind : undefined}
              className={cn(
                'flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/50 transition-colors focus-visible:outline-none focus-visible:bg-accent/50',
                statusRowClass(kind),
              )}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={statusDotStyle(kind, resultColor(evt, calendarColorMap))}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-sm font-medium', statusTitleClass(kind))}>
                  {evt.title || t.calendarView.untitled}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {resultWhen(evt, timeFormat, t.calendarView.allDay)}
                </span>
              </span>
              {statusLabel ? (
                <span className="shrink-0 text-xs text-muted-foreground">{statusLabel}</span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
