
import { useState, useMemo, useRef, useEffect } from 'react';
import { Calendar, Video, Phone, Clock, Search, Loader2, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { cn } from '@/lib/utils';
import { FloatingDrawer } from '@/components/layout/floating-drawer';
import { useUpcomingCalendarEvents, useUserCalendars, type CalendarEvent } from '@/hooks/queries/use-calendar-queries';
import { EVENT_TYPE_COLORS } from '@/app/weldcalendar/lib/event-form-schema';
import { useRouter } from '@/lib/router';
import { format, isToday, isTomorrow, startOfDay, setHours, addDays } from 'date-fns';
import { EmptyStateIllustration } from '@/components/entity-list';

const HOURS = Array.from({ length: 24 }, (_, i) => i);
type DrawerView = 'list' | 'day';
const VIEW_STORAGE_KEY = 'weldsuite.calendarDrawer.view';

interface GlobalCalendarDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  width?: number;
  skipAnimation?: boolean;
}

const eventTypeIcons: Record<string, typeof Calendar> = {
  meeting: Video,
  call: Phone,
  reminder: Clock,
  appointment: Calendar,
  event: Calendar,
  other: Calendar,
};

function formatEventTime(event: CalendarEvent): string {
  if (event.allDay) return 'All day';
  const start = new Date(event.startTime);
  const timeStr = format(start, 'h:mm a');
  if (event.endTime) {
    const end = new Date(event.endTime);
    return `${timeStr} - ${format(end, 'h:mm a')}`;
  }
  return timeStr;
}

function getDayLabel(date: Date): string {
  if (isToday(date)) return `Today - ${format(date, 'EEEE, MMM d')}`;
  if (isTomorrow(date)) return `Tomorrow - ${format(date, 'EEEE, MMM d')}`;
  return format(date, 'EEEE, MMM d');
}

interface DayGroup {
  date: Date;
  label: string;
  events: CalendarEvent[];
}

function groupEventsByDay(events: CalendarEvent[]): DayGroup[] {
  const groups = new Map<string, DayGroup>();

  for (const event of events) {
    const date = startOfDay(new Date(event.startTime));
    const key = date.toISOString();
    if (!groups.has(key)) {
      groups.set(key, { date, label: getDayLabel(date), events: [] });
    }
    groups.get(key)!.events.push(event);
  }

  return Array.from(groups.values()).sort((a, b) => a.date.getTime() - b.date.getTime());
}

export function GlobalCalendarDrawer({ isOpen, onClose, width = 400, skipAnimation }: GlobalCalendarDrawerProps) {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<DrawerView>(() => {
    if (typeof window === 'undefined') return 'list';
    const saved = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return saved === 'day' ? 'day' : 'list';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  }, [view]);

  const { data: eventsData, isLoading: eventsLoading } = useUpcomingCalendarEvents({ days: 7, limit: 50 });
  const { data: calendarsData } = useUserCalendars();

  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  const calendarMap = useMemo(() => {
    const map = new Map<string, { name: string; color?: string }>();
    if (calendarsData?.data) {
      for (const cal of calendarsData.data) {
        map.set(cal.id, { name: cal.name, color: cal.color });
      }
    }
    return map;
  }, [calendarsData]);

  const events = useMemo(() => {
    let items = eventsData?.data ?? [];

    // Filter cancelled events
    items = items.filter(e => e.status !== 'cancelled');

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      items = items.filter(e =>
        e.title.toLowerCase().includes(query) ||
        e.location?.toLowerCase().includes(query)
      );
    }

    // Sort by startTime
    return [...items].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  }, [eventsData, searchQuery]);

  const dayGroups = useMemo(() => groupEventsByDay(events), [events]);

  const handleEventClick = (event: CalendarEvent) => {
    const date = format(new Date(event.startTime), 'yyyy-MM-dd');
    router.push(`/weldcalendar?date=${date}&eventId=${event.id}`);
    onClose();
  };

  return (
    <FloatingDrawer
      isOpen={isOpen}
      width={width}
      skipAnimation={skipAnimation}
      data-testid="calendar-drawer"
    >
      {/* Panel Header */}
      <div className="px-3 h-[53px] flex items-center justify-between border-b border-gray-200 dark:border-border bg-white dark:bg-background">
        <div className="flex items-center gap-2">
          <Select value={view} onValueChange={(v) => setView(v as DrawerView)}>
            <SelectTrigger size="sm" className="w-[100px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              align="start"
              className="[&:not(:has([data-highlighted]))_[data-state=checked]]:bg-accent [&:not(:has([data-highlighted]))_[data-state=checked]]:text-accent-foreground"
            >
              <SelectItem value="list">List</SelectItem>
              <SelectItem value="day">Day</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative flex items-center">
            <div
              className={cn(
                "flex items-center transition-all duration-200 ease-out",
                searchOpen ? "w-44" : "w-8"
              )}
            >
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-8 w-8 p-0 flex-shrink-0 transition-opacity duration-200 shadow-none",
                  searchOpen && "opacity-0 pointer-events-none absolute"
                )}
                onClick={() => setSearchOpen(true)}
              >
                <Search className="h-4 w-4" />
              </Button>
              <div className={cn(
                "relative transition-all duration-200 ease-out",
                searchOpen ? "opacity-100 w-44" : "opacity-0 w-0 pointer-events-none"
              )}>
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="Search events..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onBlur={() => !searchQuery && setSearchOpen(false)}
                  className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {eventsLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-all"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {eventsLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 flex-1">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Loading...</span>
          </div>
        ) : view === 'day' ? (
          <PanelDayView events={events} onEventClick={handleEventClick} />
        ) : dayGroups.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6 bg-white dark:bg-background/30">
            <EmptyStateIllustration width={210} height={150}>
              <svg width="100" height="100" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
                {/* Calendar body fill */}
                <rect x="20" y="28" width="80" height="72" rx="8" className="fill-white dark:fill-white/[0.03]" />
                {/* Header strip fill */}
                <path d="M20 36a8 8 0 0 1 8-8h64a8 8 0 0 1 8 8v8H20v-8z" className="fill-gray-50 dark:fill-white/[0.04]" />
                {/* Divider between header and body */}
                <line x1="20" y1="44" x2="100" y2="44" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                {/* Day grid - 5 cols x 4 rows of dots */}
                {[0, 1, 2, 3].map((row) =>
                  [0, 1, 2, 3, 4].map((col) => (
                    <circle
                      key={`${row}-${col}`}
                      cx={32 + col * 14}
                      cy={56 + row * 10}
                      r="1.5"
                      className="fill-gray-200 dark:fill-white/20"
                    />
                  ))
                )}
                {/* Outer border drawn last so it stays consistent around header + body */}
                <rect x="20" y="28" width="80" height="72" rx="8" fill="none" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                {/* Binding rings */}
                <rect x="36" y="20" width="4" height="14" rx="2" className="fill-gray-200 dark:fill-white/20" />
                <rect x="80" y="20" width="4" height="14" rx="2" className="fill-gray-200 dark:fill-white/20" />
              </svg>
            </EmptyStateIllustration>
            <h3 className="text-[15px] font-semibold text-foreground mb-1.5">
              {searchQuery ? 'No matching events' : "You're all caught up"}
            </h3>
            <p className="text-sm text-muted-foreground max-w-[280px] leading-relaxed">
              {searchQuery
                ? 'Try a different search term.'
                : 'Your next 7 days are clear.'}
            </p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {dayGroups.map((group) => (
              <div key={group.date.toISOString()}>
                {/* Day Header */}
                <div className="relative flex items-center gap-2 px-3 md:px-4 h-[35px] bg-background border-b border-border/70 sticky top-0 z-[9]">
                  <div className="absolute inset-0 bg-muted/50 pointer-events-none" />
                  <span className="relative text-xs font-medium text-muted-foreground">
                    {group.label}
                  </span>
                </div>

                {/* Events for this day */}
                {group.events.map((event) => {
                  const TypeIcon = eventTypeIcons[event.type] || Calendar;
                  const eventColor = event.color || EVENT_TYPE_COLORS[event.type] || EVENT_TYPE_COLORS.other;
                  const calendar = event.calendarId ? calendarMap.get(event.calendarId) : undefined;

                  return (
                    <div
                      key={event.id}
                      onClick={() => handleEventClick(event)}
                      className="flex items-start gap-3 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer group transition-colors"
                    >
                      {/* Color dot */}
                      <div
                        className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0"
                        style={{ backgroundColor: eventColor }}
                      />

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <TypeIcon className="h-3.5 w-3.5 text-gray-400 dark:text-muted-foreground flex-shrink-0" />
                          <span className="text-sm font-medium text-gray-900 dark:text-foreground truncate">
                            {event.title}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-gray-500 dark:text-muted-foreground">
                            {formatEventTime(event)}
                          </span>
                          {calendar && (
                            <>
                              <span className="text-gray-300 dark:text-border">Â·</span>
                              <span className="text-xs text-gray-400 dark:text-muted-foreground truncate">
                                {calendar.name}
                              </span>
                            </>
                          )}
                          {event.isVirtual && event.meetingUrl && (
                            <>
                              <span className="text-gray-300 dark:text-border">Â·</span>
                              <Video className="h-3 w-3 text-blue-500 flex-shrink-0" />
                            </>
                          )}
                        </div>
                        {event.location && !event.isVirtual && (
                          <div className="text-xs text-gray-400 dark:text-muted-foreground mt-0.5 truncate">
                            {event.location}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

    </FloatingDrawer>
  );
}

interface PanelDayViewProps {
  events: CalendarEvent[];
  onEventClick: (event: CalendarEvent) => void;
}

function PanelDayView({ events, onEventClick }: PanelDayViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [now, setNow] = useState(() => new Date());
  const [hourHeight, setHourHeight] = useState(44);

  const currentDateKey = format(currentDate, 'yyyy-MM-dd');
  const dayEvents = useMemo(
    () => events.filter((e) => format(new Date(e.startTime), 'yyyy-MM-dd') === currentDateKey),
    [events, currentDateKey],
  );
  const allDayEvents = dayEvents.filter((e) => e.allDay);
  const timedEvents = dayEvents.filter((e) => !e.allDay);

  const isCurrentToday = isToday(currentDate);
  const goPrev = () => setCurrentDate((d) => addDays(d, -1));
  const goNext = () => setCurrentDate((d) => addDays(d, 1));
  const goToday = () => setCurrentDate(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const available = el.clientHeight;
      if (available <= 0) return;
      // Fit all 24 hours into the panel when possible; otherwise fall back to a min row height
      const fit = Math.floor(available / 24);
      setHourHeight(Math.max(36, fit));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Auto-scroll to current hour ONLY if the grid is taller than the container
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    if (didInitialScrollRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    const totalGridHeight = hourHeight * 24;
    if (totalGridHeight > el.clientHeight) {
      const targetHour = Math.max(0, new Date().getHours() - 1);
      el.scrollTop = targetHour * hourHeight;
    }
    didInitialScrollRef.current = true;
  }, [hourHeight]);

  const nowTop = isCurrentToday ? ((now.getHours() * 60 + now.getMinutes()) / 60) * hourHeight : null;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="relative flex items-center gap-2 px-2 h-[35px] bg-background border-b border-border/70">
        <div className="absolute inset-0 bg-muted/50 pointer-events-none" />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={goPrev}
          className="relative h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label="Previous day"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="relative text-xs font-medium text-muted-foreground flex-1 text-center">
          {format(currentDate, 'EEEE, MMM d')}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={goNext}
          className="relative h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label="Next day"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        {!isCurrentToday && (
          <Button
            type="button"
            variant="ghost"
            onClick={goToday}
            className="relative h-6 px-2 inline-flex items-center justify-center rounded text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            Today
          </Button>
        )}
      </div>

      {allDayEvents.length > 0 && (
        <div className="px-3 py-2 border-b border-gray-100 dark:border-border space-y-1">
          {allDayEvents.map((event) => {
            const color = event.color || EVENT_TYPE_COLORS[event.type] || EVENT_TYPE_COLORS.other;
            return (
              <Button
                key={event.id}
                type="button"
                variant="ghost"
                onClick={() => onEventClick(event)}
                className="w-full flex items-center gap-2 px-2 py-1 rounded text-left hover:bg-gray-50 dark:hover:bg-secondary/50 transition-colors"
              >
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                <span className="text-xs font-medium text-foreground truncate flex-1">{event.title}</span>
                <span className="text-[10px] text-muted-foreground">All day</span>
              </Button>
            );
          })}
        </div>
      )}

      <div ref={containerRef} className="flex-1 overflow-y-auto">
        <div className="grid grid-cols-[56px_1fr] relative">
          <div className="border-r border-gray-100 dark:border-border">
            {HOURS.map((hour) => (
              <div key={hour} className="flex items-start justify-end pr-2" style={{ height: hourHeight }}>
                <span className="text-[10px] text-muted-foreground -mt-1.5 tabular-nums">
                  {hour === 0 ? '' : format(setHours(new Date(), hour), 'h a')}
                </span>
              </div>
            ))}
          </div>

          <div className="relative">
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="border-b border-gray-100 dark:border-border"
                style={{ height: hourHeight }}
              />
            ))}

            {timedEvents.map((event) => {
              const start = new Date(event.startTime);
              const end = event.endTime
                ? new Date(event.endTime)
                : new Date(start.getTime() + 30 * 60_000);
              const startMins = start.getHours() * 60 + start.getMinutes();
              const endMins = end.getHours() * 60 + end.getMinutes();
              const top = (startMins / 60) * hourHeight;
              const height = Math.max(20, ((endMins - startMins) / 60) * hourHeight - 2);
              const color = event.color || EVENT_TYPE_COLORS[event.type] || EVENT_TYPE_COLORS.other;

              return (
                <Button
                  key={event.id}
                  type="button"
                  variant="ghost"
                  onClick={() => onEventClick(event)}
                  className="absolute left-1 right-1 rounded-md px-2 py-1 text-left overflow-hidden cursor-pointer transition-all hover:brightness-95 dark:hover:brightness-110"
                  style={{
                    top,
                    height,
                    backgroundColor: `${color}1f`,
                    borderLeft: `3px solid ${color}`,
                  }}
                >
                  <div className="text-[11px] font-semibold truncate" style={{ color }}>
                    {event.title}
                  </div>
                  {height > 28 && (
                    <div className="text-[10px] text-muted-foreground truncate mt-0.5">
                      {format(start, 'h:mm a')}
                      {event.endTime && ` – ${format(end, 'h:mm a')}`}
                    </div>
                  )}
                </Button>
              );
            })}

            {nowTop !== null && (
              <div
                className="absolute left-0 right-0 z-10 pointer-events-none flex items-center"
                style={{ top: nowTop }}
              >
                <div className="w-2 h-2 rounded-full bg-red-500 -ml-1 flex-shrink-0" />
                <div className="flex-1 h-px bg-red-500" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
