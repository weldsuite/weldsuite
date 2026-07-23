
import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  format,
  startOfWeek,
  addDays,
} from 'date-fns';
import { ChevronLeft, ChevronRight, CalendarClock, Search } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { cn } from '@/lib/utils';
import { useParams } from '@/lib/router';
import { useBookingPage } from '@/hooks/queries/use-calendar-queries';
import type { WeeklyAvailability } from '@/hooks/queries/use-calendar-queries';
import { FilterPills } from '@/components/entity-list';
import type { ActiveFilter, FilterConfig } from '@/components/entity-list';
import {
  HOURS,
  DEFAULT_HOUR_HEIGHT,
  WeekDayHeader,
  TimeLabelColumn,
  TimeGridScroll,
  TimeGridInner,
} from '@/app/weldcalendar/components/calendar-shared';
import { getTranslations } from '@/lib/i18n';

export default function BookingPageViewPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = useBookingPage(id);
  const bookingPage = data?.data;
  const t = getTranslations('weldcalendar');

  // View options for the booking page calendar. Booking pages are inherently
  // week-based, so only Week is wired up — but we expose the same dropdown the
  // main calendar uses so the toolbar reads identically.
  const VIEW_OPTIONS = [
    { label: t.calendarView.viewWeek, value: 'week' as const },
  ];

  const [currentWeekStart, setCurrentWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 0 }));
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

  const filterConfigs: FilterConfig[] = useMemo(() => [], []);

  const weekDays = useMemo(() =>
    Array.from({ length: 7 }, (_, i) => addDays(currentWeekStart, i)),
    [currentWeekStart],
  );

  const getAvailabilityBlocks = (dayDate: Date) => {
    if (!bookingPage?.availability) return [];
    const dayName = format(dayDate, 'EEEE').toLowerCase() as keyof WeeklyAvailability;
    return (bookingPage.availability as any)[dayName] || [];
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
            <Button variant="outline" size="sm" className="shadow-none" onClick={() => setCurrentWeekStart(startOfWeek(new Date(), { weekStartsOn: 0 }))}>
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
            <TimeLabelColumn hourHeight={hourHeight} />

            {weekDays.map((day) => {
              const blocks = getAvailabilityBlocks(day);
              const isTodayCol = format(day, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd');
              return (
                <div key={day.toISOString()} className="border-r border-border last:border-r-0 relative">
                  {HOURS.map((hour) => (
                    <div key={hour} className="border-b border-border" style={{ height: hourHeight }} />
                  ))}
                  {blocks.map((block: any, bi: number) => {
                    const [startH, startM] = block.start.split(':').map(Number);
                    const [endH, endM] = block.end.split(':').map(Number);
                    const blockStartMin = startH * 60 + startM;
                    const blockEndMin = endH * 60 + endM;
                    const totalMin = blockEndMin - blockStartMin;
                    const slotWithBuffer = duration + bufferBefore + bufferAfter;
                    const slotCount = Math.floor(totalMin / slotWithBuffer);
                    const startHourVal = startH + startM / 60;
                    const topPx = startHourVal * hourHeight;
                    const blockHeightPx = (totalMin / 60) * hourHeight;
                    const slotWithBufferPx = (slotWithBuffer / 60) * hourHeight;
                    const bufferBeforePx = (bufferBefore / 60) * hourHeight;
                    const bufferAfterPx = (bufferAfter / 60) * hourHeight;
                    const durationPx = (duration / 60) * hourHeight;

                    return (
                      <div
                        key={bi}
                        className="absolute left-[2px] right-[2px] rounded-md overflow-hidden border border-sky-300 dark:border-sky-700 bg-sky-50/50 dark:bg-sky-950/20"
                        style={{ top: `${topPx}px`, height: `${blockHeightPx}px` }}
                      >
                        {Array.from({ length: slotCount }, (_, i) => {
                          const slotTop = i * slotWithBufferPx;
                          return (
                            <div key={i}>
                              {bufferBefore > 0 && (
                                <div
                                  className="absolute left-[3px] right-[3px] bg-amber-100/50 dark:bg-amber-900/20 border border-dashed border-amber-300/50 dark:border-amber-700/50 rounded-[3px]"
                                  style={{ top: `${slotTop + 1}px`, height: `${bufferBeforePx - 2}px` }}
                                />
                              )}
                              <div
                                className="absolute left-[3px] right-[3px] bg-sky-100 dark:bg-sky-900/30 border border-sky-200 dark:border-sky-800 rounded-[4px]"
                                style={{
                                  top: `${slotTop + bufferBeforePx + 1}px`,
                                  height: `${durationPx - 2}px`,
                                }}
                              >
                                {i === 0 && (
                                  <CalendarClock className="h-3 w-3 text-sky-500 absolute top-1 left-1" />
                                )}
                              </div>
                              {bufferAfter > 0 && (
                                <div
                                  className="absolute left-[3px] right-[3px] bg-amber-100/50 dark:bg-amber-900/20 border border-dashed border-amber-300/50 dark:border-amber-700/50 rounded-[3px]"
                                  style={{ top: `${slotTop + bufferBeforePx + durationPx + 1}px`, height: `${bufferAfterPx - 2}px` }}
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
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
    </div>
  );
}
