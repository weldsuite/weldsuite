
import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  format,
  startOfWeek,
  addDays,
} from 'date-fns';
import { useOrganization } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, Copy, Search } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { cn } from '@/lib/utils';
import { useParams } from '@/lib/router';
import { useBookingPage, useCalendarEventsRange, useUserCalendars } from '@/hooks/queries/use-calendar-queries';
import type { CalendarEvent, WeeklyAvailability, TimeRange } from '@/hooks/queries/use-calendar-queries';
import { FilterPills } from '@/components/entity-list';
import type { ActiveFilter, FilterConfig } from '@/components/entity-list';
import {
  HOURS,
  DEFAULT_HOUR_HEIGHT,
  WeekDayHeader,
  TimeLabelColumn,
  TimeGridScroll,
  TimeGridInner,
  AvailabilityBlock,
} from '@/app/weldcalendar/components/calendar-shared';
import { getTranslations } from '@/lib/i18n';
import { WEEK_STARTS_ON, useTimeFormat } from '@/app/weldcalendar/lib/calendar-format';
import type { TimeFormat } from '@/app/weldcalendar/lib/calendar-format';
import { getCalendarDateRange } from '@/app/weldcalendar/lib/date-range';
import { timedEventsForDay } from '@/app/weldcalendar/lib/event-days';
import { applyEventFilters } from '@/app/weldcalendar/lib/event-filters';
import { buildEventFilterConfigs } from '@/app/weldcalendar/lib/event-filter-configs';
import type { TimedSegment } from '@/app/weldcalendar/lib/event-days';
import { EVENT_TYPE_COLORS } from '@/app/weldcalendar/lib/event-form-schema';
import { formatEventTimeRange } from '@/app/weldcalendar/lib/schedule';
import { EventDialog } from '@/app/weldcalendar/components/event-dialog';
import { EventDetailPanel, EVENT_PANEL_WIDTH } from '@/app/weldcalendar/components/calendar-view';
import { isEditableTarget, isEscapeHandledElsewhere } from '@/app/weldcalendar/lib/escape-guard';
import { useObjectPanel } from '@/components/object-panel';
import { buildBookingPageUrl } from '@/lib/weldcalendar/booking-portal-url';

export default function BookingPageViewPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = useBookingPage(id);
  const bookingPage = data?.data;
  const t = getTranslations('weldcalendar');
  const { organization } = useOrganization();
  const timeFormat = useTimeFormat();
  const orgSlug = organization?.slug || organization?.id || '';
  // Public link guests book through (the booking portal, never the platform).
  const publicUrl = bookingPage?.slug && orgSlug ? buildBookingPageUrl(orgSlug, bookingPage.slug) : null;

  const copyPublicLink = async () => {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      toast.success(t.toast.bookingLinkCopied);
    } catch {
      toast.error(t.bookingView.copyLinkFailed);
    }
  };

  // View options for the booking page calendar. Booking pages are inherently
  // week-based, so only Week is wired up — but we expose the same dropdown the
  // main calendar uses so the toolbar reads identically.
  const VIEW_OPTIONS = [
    { label: t.calendarView.viewWeek, value: 'week' as const },
  ];

  const [currentWeekStart, setCurrentWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: WEEK_STARTS_ON }));
  const [currentView, setCurrentView] = useState<'week'>('week');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);

  // Dynamic per-hour row height — same trick the main calendar's WeekView uses
  // so 24 hours fill the visible scroll area exactly.
  const containerRef = useRef<HTMLDivElement>(null);
  const [hourHeight, setHourHeight] = useState(DEFAULT_HOUR_HEIGHT);
  useEffect(() => {
    const update = () => {
      if (!containerRef.current) return;
      const available = containerRef.current.clientHeight;
      setHourHeight(Math.max(DEFAULT_HOUR_HEIGHT, Math.floor(available / 24)));
    };
    update();
    const observer = new ResizeObserver(update);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);


  // Scheduling yourself into a slot: clicking one opens the regular event
  // dialog on that slot's time. The saved event lands on the owner's calendar,
  // which is also what takes the slot off the public booking page.
  const { data: calendarsData } = useUserCalendars();
  const calendars = useMemo(() => calendarsData?.data || [], [calendarsData]);
  const defaultCalendar = calendars.find((c) => c.isOwn && c.isDefault) || calendars.find((c) => c.isOwn);
  // Same range (and so the same cache entry) as the main calendar's week view.
  const weekRange = useMemo(() => getCalendarDateRange(currentWeekStart, 'week'), [currentWeekStart]);
  const { data: eventsData } = useCalendarEventsRange(weekRange.start, weekRange.end);
  const allEvents = useMemo(() => eventsData?.data || [], [eventsData]);
  // The toolbar filter narrows the events drawn over the availability, with
  // the same fields as on the main calendar.
  const filterConfigs: FilterConfig[] = useMemo(() => buildEventFilterConfigs(calendars), [calendars]);
  const events = useMemo(() => applyEventFilters(allEvents, activeFilters), [allEvents, activeFilters]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [slot, setSlot] = useState<{ start: Date; end: Date } | null>(null);
  // A scheduled event opens in the same details panel as on the main calendar;
  // the dialog is only for creating one, or for the panel's "Edit".
  const [panelOpen, setPanelOpen] = useState(false);
  const reopenPanelAfterDialogRef = useRef(false);
  const { open: openObjectPanel, closeAll: closeObjectPanels } = useObjectPanel();

  const calendarColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const cal of calendars) {
      if (cal.color) map[cal.id] = cal.color;
    }
    return map;
  }, [calendars]);

  const openSlot = (day: Date, startMinutes: number, endMinutes: number) => {
    const start = new Date(day);
    start.setHours(0, startMinutes, 0, 0);
    const end = new Date(day);
    end.setHours(0, endMinutes, 0, 0);
    setPanelOpen(false);
    setSelectedEvent(null);
    setSlot({ start, end });
    setDialogOpen(true);
  };

  const openEvent = (event: CalendarEvent) => {
    // Task-backed events use the standard task panel, as on the main calendar.
    if (event.sourceType === 'task' && event.sourceId) {
      setPanelOpen(false);
      setSelectedEvent(null);
      openObjectPanel({ type: 'task', id: event.sourceId });
      return;
    }
    closeObjectPanels();
    setSelectedEvent(event);
    setPanelOpen(true);
  };

  // The panel edits inline: follow the refreshed event so it never shows the
  // snapshot taken at click time, and close once the event is gone.
  useEffect(() => {
    if (!panelOpen) return;
    setSelectedEvent((prev) => {
      if (!prev?.id) return prev;
      const next = allEvents.find((e) => e.id === prev.id);
      if (!next) return prev;
      return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
    });
  }, [allEvents, panelOpen]);

  // Escape closes the panel, unless a popup or an inline editor wants the key.
  useEffect(() => {
    if (!panelOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isEscapeHandledElsewhere(e) || isEditableTarget(e.target)) return;
      setPanelOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [panelOpen]);

  const eventColor = (event: CalendarEvent) =>
    event.color
    || (event.calendarId ? calendarColorMap[event.calendarId] : undefined)
    || EVENT_TYPE_COLORS[event.type]
    || '#6b7280';

  const weekDays = useMemo(() =>
    Array.from({ length: 7 }, (_, i) => addDays(currentWeekStart, i)),
    [currentWeekStart],
  );

  const getAvailabilityBlocks = (dayDate: Date): TimeRange[] => {
    if (!bookingPage?.availability) return [];
    const dayName = format(dayDate, 'EEEE').toLowerCase() as keyof WeeklyAvailability;
    return bookingPage.availability[dayName] || [];
  };

  if (isLoading) return <div className="flex items-center justify-center py-12 text-muted-foreground">{t.bookingView.loadingBookingPage}</div>;
  if (!bookingPage) return <div className="flex items-center justify-center py-12 text-muted-foreground">{t.bookingView.bookingPageNotFound}</div>;

  const duration = bookingPage.duration || 60;
  const bufferBefore = bookingPage.bufferBefore || 0;
  const bufferAfter = bookingPage.bufferAfter || 0;

  // Header label mirrors the main calendar: shows just "May 2026" when the
  // visible week sits inside one month, "Apr – May 2026" when it spans two.
  const headerLabel = (() => {
    const ws = currentWeekStart;
    const we = addDays(ws, 6);
    if (ws.getMonth() === we.getMonth() && ws.getFullYear() === we.getFullYear()) {
      return format(ws, 'MMMM yyyy');
    }
    const yearLabel = ws.getFullYear() === we.getFullYear()
      ? format(we, 'yyyy')
      : `${format(ws, 'yyyy')} – ${format(we, 'yyyy')}`;
    return `${format(ws, 'MMM')} – ${format(we, 'MMM')} ${yearLabel}`;
  })();

  const isTodayInWeek = (() => {
    const now = new Date();
    return now >= currentWeekStart && now < addDays(currentWeekStart, 7);
  })();

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar — identical structure to the main calendar's toolbar */}
      <div className="flex items-center justify-between border-b px-4 py-2.5 bg-background shrink-0 z-10">
        <div className="flex items-center gap-2">
          {/* Back to main calendar */}
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0 shadow-none"
            onClick={() => navigate({ to: '/weldcalendar' })}
            title={t.bookingEditor.backToCalendar}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <FilterPills
            filters={activeFilters}
            filterConfigs={filterConfigs}
            maxFilters={3}
            onFiltersChange={setActiveFilters}
          />
          {!isTodayInWeek && (
            <Button variant="outline" size="sm" className="shadow-none" onClick={() => setCurrentWeekStart(startOfWeek(new Date(), { weekStartsOn: WEEK_STARTS_ON }))}>
              {t.bookingView.today}
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setCurrentWeekStart(addDays(currentWeekStart, -7))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setCurrentWeekStart(addDays(currentWeekStart, 7))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <h2 className="text-[18px] font-semibold ml-1 -translate-y-[1px]">{headerLabel}</h2>
        </div>

        <div className="flex items-center gap-2">
          {publicUrl && (
            // Same surface as the outline buttons and the view select next to it.
            <div className="flex items-center gap-1 h-8 rounded-md border bg-background dark:bg-input/30 dark:border-input pl-3 pr-0.5 max-w-[360px]">
              <a
                href={publicUrl}
                target="_blank"
                rel="noreferrer"
                title={t.bookingView.openPublicLink}
                // Nudged up 1px: the link is lowercase with descenders ("booking-page"),
                // so its ink sits lower than the capitalised labels beside it.
                className="truncate text-[13px] leading-5 -translate-y-px hover:underline underline-offset-4"
              >
                {publicUrl.replace(/^https?:\/\//, '')}
              </a>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={copyPublicLink}
                title={t.bookingView.copyLink}
                aria-label={t.bookingView.copyLink}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          )}
          <div className="relative flex items-center">
            <div className={cn(
              'flex items-center transition-all duration-200 ease-out',
              searchOpen ? 'w-48' : 'w-8',
            )}>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  'h-8 w-8 p-0 flex-shrink-0 shadow-none transition-opacity duration-200',
                  searchOpen && 'opacity-0 pointer-events-none absolute',
                )}
                onClick={() => setSearchOpen(true)}
              >
                <Search className="h-4 w-4" />
              </Button>
              <div className={cn(
                'relative transition-all duration-200 ease-out',
                searchOpen ? 'opacity-100 w-48' : 'opacity-0 w-0 pointer-events-none',
              )}>
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder={t.bookingView.searchAvailabilityPlaceholder}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onBlur={() => !searchQuery && setSearchOpen(false)}
                  onKeyDown={(e) => { if (e.key === 'Escape') { setSearchQuery(''); setSearchOpen(false); } }}
                  ref={(el) => { if (el && searchOpen) el.focus(); }}
                  className="h-8 w-full pl-8 pr-3 text-sm border border-gray-200 dark:border-border rounded-md bg-white dark:bg-background focus:outline-none"
                />
              </div>
            </div>
          </div>
          <Select value={currentView} onValueChange={(v) => setCurrentView(v as 'week')}>
            <SelectTrigger size="sm" className="w-[130px] shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VIEW_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="shadow-none"
            onClick={() => navigate({ to: '/weldcalendar/scheduling/$id/edit', params: { id } })}
          >
            {t.bookingView.edit}
          </Button>
        </div>
      </div>

      {/* Week view */}
      <div className="flex-1 flex flex-col min-h-0">
        <WeekDayHeader days={weekDays} />

        <TimeGridScroll ref={containerRef}>
          <TimeGridInner days={weekDays}>
            <TimeLabelColumn hourHeight={hourHeight} timeFormat={timeFormat} />

            {weekDays.map((day) => {
              const blocks = getAvailabilityBlocks(day);
              const isTodayCol = format(day, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd');
              return (
                <div key={day.toISOString()} className="border-r border-border last:border-r-0 relative">
                  {HOURS.map((hour) => (
                    <div key={hour} className="border-b border-border" style={{ height: hourHeight }} />
                  ))}
                  {blocks.map((block: TimeRange) => (
                    <AvailabilityBlock
                      key={`${block.start}-${block.end}`}
                      block={block}
                      hourHeight={hourHeight}
                      duration={duration}
                      bufferBefore={bufferBefore}
                      bufferAfter={bufferAfter}
                      timeFormat={timeFormat}
                      onSlotClick={(startMinutes, endMinutes) => openSlot(day, startMinutes, endMinutes)}
                      slotHint={t.bookingView.clickToSchedule}
                    />
                  ))}
                  {timedEventsForDay(events, day).map(({ event, segment }) => (
                    <ScheduledEvent
                      key={event.id}
                      event={event}
                      segment={segment}
                      hourHeight={hourHeight}
                      color={eventColor(event)}
                      timeFormat={timeFormat}
                      onClick={() => openEvent(event)}
                    />
                  ))}
                  {/* Current time indicator on today's column */}
                  {isTodayCol && (() => {
                    const now = new Date();
                    const h = now.getHours() + now.getMinutes() / 60;
                    const tp = h * hourHeight;
                    return (
                      <div className="absolute left-0 right-0 z-[3] pointer-events-none" style={{ top: `${tp}px` }}>
                        <div className="flex items-center">
                          <div className="w-2.5 h-2.5 rounded-full bg-red-500 -ml-[5px]" />
                          <div className="flex-1 h-[2px] bg-red-500" />
                        </div>
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </TimeGridInner>
        </TimeGridScroll>
      </div>

      <EventDetailPanel
        event={selectedEvent}
        isOpen={panelOpen}
        calendars={calendars}
        calendarColorMap={calendarColorMap}
        width={EVENT_PANEL_WIDTH}
        onClose={() => setPanelOpen(false)}
        onEdit={() => {
          reopenPanelAfterDialogRef.current = true;
          setPanelOpen(false);
          setDialogOpen(true);
        }}
      />

      <EventDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          // Cancelling (or saving) the edit goes back to the panel it was opened from.
          if (!open && reopenPanelAfterDialogRef.current) {
            reopenPanelAfterDialogRef.current = false;
            setPanelOpen(true);
          }
        }}
        onDeleted={() => {
          reopenPanelAfterDialogRef.current = false;
          setSelectedEvent(null);
        }}
        event={selectedEvent}
        defaultStart={slot?.start}
        defaultEnd={slot?.end}
        defaultTitle={bookingPage.name}
        calendars={calendars}
        defaultCalendarId={defaultCalendar?.id}
      />
    </div>
  );
}

/** An event already on the calendar, drawn over the availability it takes up. */
function ScheduledEvent({
  event,
  segment,
  hourHeight,
  color,
  timeFormat,
  onClick,
}: Readonly<{
  event: CalendarEvent;
  segment: TimedSegment;
  hourHeight: number;
  color: string;
  timeFormat: TimeFormat;
  onClick: () => void;
}>) {
  const startHours = segment.start.getHours() + segment.start.getMinutes() / 60;
  const durationHours = (segment.end.getTime() - segment.start.getTime()) / 3_600_000;
  const heightPx = Math.max(durationHours * hourHeight, 22);

  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute left-[3px] right-[3px] rounded-[6px] px-2.5 py-1.5 text-white text-[12px] leading-tight overflow-hidden hover:brightness-95 transition-[filter] z-[2] border border-white/10 text-left flex flex-col items-start justify-start cursor-pointer"
      style={{ backgroundColor: color, top: `${startHours * hourHeight}px`, height: `${heightPx}px` }}
    >
      <span className="font-semibold truncate block max-w-full">{event.title}</span>
      {heightPx > 30 && (
        <span className="text-white/70 text-[12px] block mt-[3px]">
          {formatEventTimeRange(segment.start, segment.end, timeFormat)}
        </span>
      )}
    </button>
  );
}
