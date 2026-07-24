import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useBlocker } from '@tanstack/react-router';
import { getTranslations } from '@/lib/i18n';
import {
  format,
  startOfWeek,
  addDays,
  isToday,
} from 'date-fns';
import { ChevronLeft, ChevronRight, Plus, Trash2, Copy, X, CalendarClock, Settings2, Calendar as LucideCalendar, Search } from 'lucide-react';
import { FilterPills } from '@/components/entity-list';
import type { ActiveFilter, FilterConfig } from '@/components/entity-list';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Separator } from '@weldsuite/ui/components/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@weldsuite/ui/components/collapsible';
import { PageTabs } from '@weldsuite/ui/components/page-tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import { Calendar } from '@weldsuite/ui/components/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { cn } from '@/lib/utils';
import { useCreateBookingPage, useUserCalendars } from '@/hooks/queries/use-calendar-queries';
import type { WeeklyAvailability, TimeRange } from '@/hooks/queries/use-calendar-queries';
import { DEFAULT_AVAILABILITY, DURATION_OPTIONS } from '../../types';
import {
  HOURS as SHARED_HOURS,
  DEFAULT_HOUR_HEIGHT,
  WeekDayHeader,
  TimeLabelColumn,
  TimeGridScroll,
  TimeGridInner,
} from '@/app/weldcalendar/components/calendar-shared';
import { useSetAtom } from 'jotai';
import { draftBookingPageTitleAtom } from '../../lib/draft-booking-page';

export interface BookingPageEditorProps {
  mode?: 'create' | 'edit';
  bookingPageId?: string;
  initialData?: {
    title: string;
    duration: number;
    availability: WeeklyAvailability;
    bufferBefore: number;
    bufferAfter: number;
  };
}

const DAY_NAMES: (keyof WeeklyAvailability)[] = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];


export default function NewBookingPage() {
  return <BookingPageEditor mode="create" />;
}

export function BookingPageEditor({ mode = 'create', bookingPageId, initialData }: BookingPageEditorProps) {
  const t = getTranslations('weldcalendar');

  // Booking pages are inherently week-based, but we expose the same view
  // dropdown the main calendar uses so the toolbar reads identically.
  const VIEW_OPTIONS = [
    { label: t.calendarView.viewWeek, value: 'week' as const },
  ];
  const DAY_SHORT: Record<keyof WeeklyAvailability, string> = {
    sunday: t.bookingEditorDays.sun,
    monday: t.bookingEditorDays.mon,
    tuesday: t.bookingEditorDays.tue,
    wednesday: t.bookingEditorDays.wed,
    thursday: t.bookingEditorDays.thu,
    friday: t.bookingEditorDays.fri,
    saturday: t.bookingEditorDays.sat,
  };
  const navigate = useNavigate();
  const createBookingPage = useCreateBookingPage();
  const { data: calendarsData } = useUserCalendars();
  const calendars = calendarsData?.data || [];
  const [selectedCalendarId, setSelectedCalendarId] = useState<string>('');
  const isEdit = mode === 'edit';

  const savedRef = useRef(false);

  const hasUnsavedChanges = () => {
    if (isEdit && initialData) {
      return title !== initialData.title || duration !== initialData.duration || bufferBefore !== initialData.bufferBefore || bufferAfter !== initialData.bufferAfter;
    }
    return title.trim() !== '' || duration !== 120 || bufferBefore !== 0 || bufferAfter !== 0;
  };

  const handleNavigateAway = () => {
    if (isEdit && bookingPageId) {
      navigate({ to: '/weldcalendar/scheduling/$id/view', params: { id: bookingPageId } });
    } else {
      navigate({ to: '/weldcalendar' });
    }
  };

  const [title, setTitle] = useState(initialData?.title ?? (isEdit ? '' : t.bookingPagesSidebar.defaultTitle));
  const setDraftTitle = useSetAtom(draftBookingPageTitleAtom);
  const continuingRef = useRef(false);
  useEffect(() => {
    if (isEdit) return;
    setDraftTitle(title);
  }, [isEdit, title, setDraftTitle]);
  // Unmount-only cleanup: clear the atom unless the user continued to the
  // draft Details page (where the Details page itself keeps the atom in sync).
  useEffect(() => {
    if (isEdit) return;
    return () => {
      if (!continuingRef.current) setDraftTitle(null);
    };
  }, [isEdit, setDraftTitle]);
  const [duration, setDuration] = useState(initialData?.duration || 120);
  const [customDuration, setCustomDuration] = useState(false);
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [availability, setAvailability] = useState<WeeklyAvailability>(initialData?.availability || DEFAULT_AVAILABILITY);
  const [repeatMode, setRepeatMode] = useState<'none' | 'weekly' | 'custom'>('weekly');
  const [customRepeatInterval, setCustomRepeatInterval] = useState(2);
  const [customRepeatUnit, setCustomRepeatUnit] = useState<'weeks' | 'months'>('weeks');
  const [customRepeatStart, setCustomRepeatStart] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [customRepeatEndType, setCustomRepeatEndType] = useState<'never' | 'date'>('never');
  const [customRepeatEndDate, setCustomRepeatEndDate] = useState('');
  const [customRepeatDialogOpen, setCustomRepeatDialogOpen] = useState(false);
  const [specificDates, setSpecificDates] = useState<{ date: string; ranges: TimeRange[] }[]>([]);
  const [bufferBefore, setBufferBefore] = useState(initialData?.bufferBefore || 0);
  const [bufferAfter, setBufferAfter] = useState(initialData?.bufferAfter || 0);
  const [currentWeekStart, setCurrentWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 0 }));

  const weekDays = useMemo(() =>
    Array.from({ length: 7 }, (_, i) => addDays(currentWeekStart, i)),
    [currentWeekStart],
  );

  // Toolbar state — kept in sync with the booking-viewer's toolbar so both
  // pages render identically. Filter pills + search + view dropdown are
  // mounted for visual parity (no functional filters yet).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [currentView, setCurrentView] = useState<'week'>('week');
  const filterConfigs: FilterConfig[] = useMemo(() => [], []);

  // Header label mirrors the main calendar / viewer: "May 2026" when the
  // visible week is inside one month, "Apr – May 2026" when it spans two.
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

  // Dynamic per-hour row height — keeps 24 hours filling the visible scroll
  // area exactly (matches the main calendar's WeekView). Without this the
  // grid stretches to 100% but the static 48px cells don't, leaving an empty
  // "phantom" row below 11 PM when the viewport is taller than 1152px.
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const [previewHourHeight, setPreviewHourHeight] = useState(DEFAULT_HOUR_HEIGHT);
  useEffect(() => {
    const update = () => {
      if (!previewContainerRef.current) return;
      const available = previewContainerRef.current.clientHeight;
      setPreviewHourHeight(Math.max(DEFAULT_HOUR_HEIGHT, Math.floor(available / 24)));
    };
    update();
    const observer = new ResizeObserver(update);
    if (previewContainerRef.current) observer.observe(previewContainerRef.current);
    return () => observer.disconnect();
  }, []);

  const updateDay = (day: keyof WeeklyAvailability, ranges: TimeRange[]) => {
    setAvailability((prev) => ({ ...prev, [day]: ranges }));
  };

  const toggleDay = (day: keyof WeeklyAvailability) => {
    if (availability[day].length > 0) {
      updateDay(day, []);
    } else {
      updateDay(day, [{ start: '09:00', end: '17:00' }]);
    }
  };

  const addRange = (day: keyof WeeklyAvailability) => {
    const ranges = [...availability[day]];
    const lastRange = ranges[ranges.length - 1];
    const newStart = lastRange ? lastRange.end : '09:00';
    const [h] = newStart.split(':').map(Number);
    const newEnd = `${String(Math.min(h + 1, 23)).padStart(2, '0')}:00`;
    ranges.push({ start: newStart, end: newEnd });
    updateDay(day, ranges);
  };

  const removeRange = (day: keyof WeeklyAvailability, index: number) => {
    updateDay(day, availability[day].filter((_, i) => i !== index));
  };

  const updateRange = (day: keyof WeeklyAvailability, index: number, field: 'start' | 'end', value: string) => {
    const ranges = [...availability[day]];
    ranges[index] = { ...ranges[index], [field]: value };
    updateDay(day, ranges);
  };

  // Persists the booking page (API mutate in create mode, sessionStorage in
  // edit mode) and returns the destination route the normal Save flow should
  // navigate to. Does NOT navigate — callers decide.
  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  type BookingPageDestination =
    | { to: '/weldcalendar/scheduling/$id'; params: { id: string } }
    | { to: '/weldcalendar/scheduling/$id/view'; params: { id: string } }
    | { to: '/weldcalendar' };

  const persistBookingPage = async (): Promise<BookingPageDestination> => {
    const name = title.trim() || 'New Booking Page';
    const slug = slugify(name) || 'booking';

    if (isEdit && bookingPageId) {
      sessionStorage.setItem(`booking-edit-${bookingPageId}`, JSON.stringify({
        name, duration, availability, bufferBefore, bufferAfter,
      }));
      return { to: '/weldcalendar/scheduling/$id', params: { id: bookingPageId } };
    }
    const result = await createBookingPage.mutateAsync({
      name,
      slug,
      duration,
      availability,
      bufferBefore,
      bufferAfter,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    const newId = result?.data?.id;
    return newId
      ? { to: '/weldcalendar/scheduling/$id/view', params: { id: newId } }
      : { to: '/weldcalendar' };
  };

  // In edit mode, behaves like the old "Next" — persist to sessionStorage and
  // jump to the Details page for this existing booking page. In create mode,
  // stash the form data in sessionStorage under the special `__draft__` key
  // and navigate to the Details page in draft mode (where the Create button
  // actually fires the API).
  const handleContinue = () => {
    const name = title.trim() || 'New Booking Page';
    if (isEdit && bookingPageId) {
      sessionStorage.setItem(`booking-edit-${bookingPageId}`, JSON.stringify({
        name, duration, availability, bufferBefore, bufferAfter,
      }));
      savedRef.current = true;
      navigate({ to: '/weldcalendar/scheduling/$id', params: { id: bookingPageId } });
      return;
    }
    sessionStorage.setItem('booking-new-draft', JSON.stringify({
      name,
      slug: slugify(name) || 'booking',
      duration,
      availability,
      bufferBefore,
      bufferAfter,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }));
    savedRef.current = true;
    continuingRef.current = true;
    navigate({ to: '/weldcalendar/scheduling/$id', params: { id: '__draft__' } });
  };

  const isSaving = createBookingPage.isPending;

  const { proceed, reset, status } = useBlocker({
    shouldBlockFn: () => !savedRef.current && hasUnsavedChanges() && !isSaving,
    withResolver: true,
    enableBeforeUnload: () => !savedRef.current && hasUnsavedChanges(),
  });
  const blocked = status === 'blocked';

  const handleSaveAndProceed = async () => {
    try {
      await persistBookingPage();
      savedRef.current = true;
      proceed?.();
    } catch {
      // mutation already toasts; keep dialog open so the user can retry / discard
    }
  };

  // Convert availability to visual blocks for the week view
  const getAvailabilityBlocks = (dayDate: Date) => {
    if (repeatMode === 'none') {
      const dateStr = format(dayDate, 'yyyy-MM-dd');
      const sd = specificDates.find((d) => d.date === dateStr);
      return sd?.ranges || [];
    }
    const dayName = format(dayDate, 'EEEE').toLowerCase() as keyof WeeklyAvailability;
    return availability[dayName] || [];
  };

  const weekPreview = (
    // Uses the shared <WeekDayHeader> + time-grid primitives so the booking
    // editor's preview stays visually identical to the main calendar page.
    <div className="flex-1 flex flex-col min-h-0">
      <WeekDayHeader days={weekDays} />
      <TimeGridScroll ref={previewContainerRef}>
        <TimeGridInner days={weekDays}>
          <TimeLabelColumn hourHeight={previewHourHeight} />
          {weekDays.map((day) => {
            const blocks = getAvailabilityBlocks(day);
            return (
              <div key={day.toISOString()} className="border-r border-border last:border-r-0 relative">
                {SHARED_HOURS.map((hour) => (
                  <div key={hour} className="border-b border-border" style={{ height: previewHourHeight }} />
                ))}
                {blocks.map((block, bi) => {
                  const [startH, startM] = block.start.split(':').map(Number);
                  const [endH, endM] = block.end.split(':').map(Number);
                  const blockStartMin = startH * 60 + startM;
                  const blockEndMin = endH * 60 + endM;
                  const totalMin = blockEndMin - blockStartMin;
                  const slotWithBuffer = duration + bufferBefore + bufferAfter;
                  const slotCount = Math.floor(totalMin / slotWithBuffer);
                  const startHourVal = startH + startM / 60;
                  const topPx = startHourVal * previewHourHeight;
                  const blockHeightPx = (totalMin / 60) * previewHourHeight;
                  const slotWithBufferPx = (slotWithBuffer / 60) * previewHourHeight;
                  const bufferBeforePx = (bufferBefore / 60) * previewHourHeight;
                  const bufferAfterPx = (bufferAfter / 60) * previewHourHeight;
                  const durationPx = (duration / 60) * previewHourHeight;

                  return (
                    <div
                      key={bi}
                      className="absolute left-[2px] right-[2px] rounded-md overflow-hidden border border-sky-300 dark:border-sky-700 bg-sky-50/50 dark:bg-sky-950/20"
                      style={{ top: `${topPx}px`, height: `${blockHeightPx}px` }}
                    >
                      {/* Individual slot blocks with buffer */}
                      {Array.from({ length: slotCount }, (_, i) => {
                        const slotTop = i * slotWithBufferPx;
                        return (
                          <div key={i}>
                            {/* Buffer before */}
                            {bufferBefore > 0 && (
                              <div
                                className="absolute left-[3px] right-[3px] bg-amber-100/50 dark:bg-amber-900/20 border border-dashed border-amber-300/50 dark:border-amber-700/50 rounded-[3px]"
                                style={{ top: `${slotTop + 1}px`, height: `${bufferBeforePx - 2}px` }}
                              />
                            )}
                            {/* Appointment slot */}
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
                            {/* Buffer after */}
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
                {isToday(day) && (() => {
                  const now = new Date();
                  const h = now.getHours() + now.getMinutes() / 60;
                  const topPx = h * previewHourHeight;
                  return (
                    <div className="absolute left-0 right-0 z-[3] pointer-events-none" style={{ top: `${topPx}px` }}>
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
  );

  return (
    <div className="flex flex-col h-full">
      {/* Shared header row — left toolbar matches the booking viewer's toolbar
          exactly (back chevron + filter pills + today + nav + month label,
          search + view dropdown on the right). Right 480px region remains the
          settings-panel header unique to the editor. */}
      <div className="flex items-center shrink-0 border-b h-[53px]">
        <div className="flex-1 flex items-center justify-between gap-2 px-4 py-2">
          <div className="flex items-center gap-2">
            {/* Back to main calendar — booking-page-only affordance */}
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0 shadow-none"
              onClick={handleNavigateAway}
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
                    placeholder={t.bookingEditor.searchAvailabilityPlaceholder}
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
          </div>
        </div>
        <div className="w-[480px] shrink-0 border-l flex items-end h-full">
          {/* Horizontal icon+text tabs (same PageTabs primitive the task detail
              panel uses) — rendered identically in create AND edit mode so the
              page never visually shifts between flows. In create mode the
              "Details" tab triggers handleContinue first (since the Details
              page needs a saved booking page id to exist). */}
          <PageTabs
            tabs={[
              { id: 'schedule', label: t.bookingEditor.tabSchedule, icon: CalendarClock },
              { id: 'details', label: t.bookingEditor.tabDetails, icon: Settings2 },
            ]}
            activeTab="schedule"
            onTabChange={(id) => {
              if (id !== 'details') return;
              handleContinue();
            }}
            // PageTabs renders its own absolute bottom border which would
            // double up with the outer header's `border-b`; hide its first
            // child (the border line) so only the outer border remains.
            className="w-full [&>div:first-child]:hidden"
            innerClassName="px-4"
          />
          {/* Close — exits the editor back to the main calendar. */}
          <Button
            variant="ghost"
            onClick={handleNavigateAway}
            className="self-center mr-5 p-1.5 hover:bg-muted rounded-md transition-colors"
            title={t.bookingEditor.close}
          >
            <X className="h-4 w-4 text-gray-500" />
          </Button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
      {weekPreview}

      {/* Right panel — Settings */}
      <div className="w-[480px] shrink-0 border-l flex flex-col bg-background">
        <div className="flex-1 overflow-y-auto">
          {/* Title */}
          <div className="px-5 pt-5 pb-4 space-y-2">
            <Label htmlFor="booking-title">{t.bookingEditor.titleLabel}</Label>
            <Input
              id="booking-title"
              placeholder={t.bookingEditor.titlePlaceholder}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {/* Sections */}
          <div className="divide-y">
            {/* Appointment duration */}
            <div className="px-5 py-4">
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{t.bookingEditor.appointmentDuration}</p>
                      <p className="text-xs text-muted-foreground">{t.bookingEditor.appointmentDurationHint}</p>
                    </div>
                    <Select
                      value={customDuration ? 'custom' : String(duration)}
                      onValueChange={(v) => {
                        if (v === 'custom') {
                          setCustomDuration(true);
                          setCustomDialogOpen(true);
                        } else {
                          setCustomDuration(false);
                          setDuration(Number(v));
                        }
                      }}
                    >
                      <SelectTrigger className="w-[160px] shadow-none">
                        <SelectValue>
                          {customDuration ? `${duration} ${t.bookingEditor.minutes}` : undefined}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {DURATION_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={String(opt.value)}>{opt.label}</SelectItem>
                        ))}
                        <SelectItem
                          value="custom"
                          onPointerUp={() => {
                            if (customDuration) {
                              setTimeout(() => setCustomDialogOpen(true), 100);
                            }
                          }}
                        >
                          {t.bookingEditor.customRepeat}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Custom duration dialog */}
                  <Dialog open={customDialogOpen} onOpenChange={(open) => { setCustomDialogOpen(open); if (!open && !duration) setCustomDuration(false); }}>
                    <DialogContent className="sm:max-w-[340px]">
                      <DialogHeader>
                        <DialogTitle>{t.bookingEditor.customDuration}</DialogTitle>
                        <DialogDescription>{t.bookingEditor.customDurationDescription}</DialogDescription>
                      </DialogHeader>
                      <div className="flex items-center gap-2 py-2">
                        <Input
                          type="number"
                          min={5}
                          value={duration}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            if (val >= 1) setDuration(val);
                          }}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') setCustomDialogOpen(false);
                          }}
                        />
                        <span className="text-sm text-muted-foreground shrink-0">{t.bookingEditor.minutes}</span>
                      </div>
                      <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => { setCustomDialogOpen(false); setCustomDuration(false); }}>{t.bookingEditor.cancel}</Button>
                        <Button type="button" onClick={() => setCustomDialogOpen(false)}>{t.bookingEditor.done}</Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
            </div>

            {/* General availability */}
            <div className="px-5 py-4">
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-medium">{t.bookingEditor.generalAvailability}</p>
                    <p className="text-xs text-muted-foreground">
                      {repeatMode === 'none'
                        ? t.bookingEditor.generalAvailabilityHintSpecific
                        : t.bookingEditor.generalAvailabilityHintRegular}
                    </p>
                  </div>

                  {/* Repeat select */}
                  <Select
                    value={repeatMode === 'custom' ? 'custom' : repeatMode}
                    onValueChange={(v) => {
                      if (v === 'custom') {
                        setRepeatMode('custom');
                        setCustomRepeatDialogOpen(true);
                      } else if (v === 'none') {
                        setRepeatMode('none');
                      } else {
                        setRepeatMode('weekly');
                      }
                    }}
                  >
                    <SelectTrigger className="w-[200px] shadow-none">
                      <SelectValue>
                        {repeatMode === 'custom'
                          ? `${customRepeatInterval} ${customRepeatUnit === 'weeks' ? t.bookingEditor.weeks : t.bookingEditor.months}`
                          : repeatMode === 'none'
                          ? t.bookingEditor.doesNotRepeat
                          : t.bookingEditor.repeatWeekly}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t.bookingEditor.doesNotRepeat}</SelectItem>
                      <SelectItem value="weekly">{t.bookingEditor.repeatWeekly}</SelectItem>
                      <SelectItem
                        value="custom"
                        onPointerUp={() => {
                          if (repeatMode === 'custom') {
                            setTimeout(() => setCustomRepeatDialogOpen(true), 100);
                          }
                        }}
                      >
                        {t.bookingEditor.customRepeat}
                      </SelectItem>
                    </SelectContent>
                  </Select>

                  {/* Custom repeat dialog */}
                  <Dialog open={customRepeatDialogOpen} onOpenChange={(open) => { setCustomRepeatDialogOpen(open); if (!open && repeatMode !== 'custom') setRepeatMode('weekly'); }}>
                    <DialogContent className="sm:max-w-[380px]">
                      <DialogHeader>
                        <DialogTitle>{t.bookingEditor.customRepeatTitle}</DialogTitle>
                        <DialogDescription className="sr-only">{t.bookingEditor.customRepeatTitle}</DialogDescription>
                      </DialogHeader>

                      <div className="space-y-4 py-2">
                        {/* Repeat every */}
                        <div className="space-y-2">
                          <Label>{t.bookingEditor.repeatEvery}</Label>
                          <div className="flex items-center gap-2">
                            <Input
                              type="number"
                              min={1}
                              value={customRepeatInterval}
                              onChange={(e) => setCustomRepeatInterval(Math.max(1, Number(e.target.value)))}
                              className="w-[70px]"
                              autoFocus
                            />
                            <Select value={customRepeatUnit} onValueChange={(v) => setCustomRepeatUnit(v as 'weeks' | 'months')}>
                              <SelectTrigger className="w-[110px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="weeks">{t.bookingEditor.weeks}</SelectItem>
                                <SelectItem value="months">{t.bookingEditor.months}</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        <Separator />

                        {/* Starts */}
                        <div className="space-y-2">
                          <Label>{t.bookingEditor.starts}</Label>
                          <DatePickerInput
                            value={customRepeatStart ? new Date(customRepeatStart) : undefined}
                            onChange={(d) => setCustomRepeatStart(d ? format(d, 'yyyy-MM-dd') : '')}
                          />
                        </div>

                        {/* Ends */}
                        <div className="space-y-2">
                          <Label>{t.bookingEditor.ends}</Label>
                          <div className="flex items-center gap-2">
                            <Select value={customRepeatEndType} onValueChange={(v) => setCustomRepeatEndType(v as 'never' | 'date')}>
                              <SelectTrigger className="w-[120px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="never">{t.bookingEditor.endNever}</SelectItem>
                                <SelectItem value="date">{t.bookingEditor.endOnDate}</SelectItem>
                              </SelectContent>
                            </Select>
                            {customRepeatEndType === 'date' && (
                              <DatePickerInput
                                value={customRepeatEndDate ? new Date(customRepeatEndDate) : undefined}
                                onChange={(d) => setCustomRepeatEndDate(d ? format(d, 'yyyy-MM-dd') : '')}
                                fullWidth={false}
                              />
                            )}
                          </div>
                        </div>
                      </div>

                      <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => { setCustomRepeatDialogOpen(false); setRepeatMode('weekly'); }}>{t.bookingEditor.cancel}</Button>
                        <Button
                          type="button"
                          onClick={() => setCustomRepeatDialogOpen(false)}
                          className="inline-flex items-center justify-center rounded-md bg-primary px-4 h-9 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                        >
                          {t.bookingEditor.done}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {/* Day rows — only show when repeat mode is not 'none' */}
                  {repeatMode !== 'none' && (
                  <div className="divide-y">
                    {DAY_NAMES.map((day) => {
                      const ranges = availability[day];
                      const isEnabled = ranges.length > 0;

                      return (
                        <div key={day} className="flex items-start py-3 group/day min-h-[44px]">
                          <span className={cn('text-sm w-10 shrink-0 h-9 flex items-center', isEnabled ? 'font-medium' : 'text-muted-foreground')}>
                            {DAY_SHORT[day]}
                          </span>
                          {isEnabled ? (
                            <div className="flex-1 space-y-2">
                              {ranges.map((range, idx) => (
                                <div key={idx} className="flex items-center gap-2">
                                  <Input
                                    type="time"
                                    value={range.start}
                                    onChange={(e) => updateRange(day, idx, 'start', e.target.value)}
                                    className="h-9 text-sm shadow-none w-[95px] [&::-webkit-calendar-picker-indicator]:hidden"
                                  />
                                  <span className="text-muted-foreground text-sm">–</span>
                                  <Input
                                    type="time"
                                    value={range.end}
                                    onChange={(e) => updateRange(day, idx, 'end', e.target.value)}
                                    className="h-9 text-sm shadow-none w-[95px] [&::-webkit-calendar-picker-indicator]:hidden"
                                  />
                                  <div className="flex items-center gap-0.5 ml-auto">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 rounded-[11px] hover:bg-destructive/10 hover:text-destructive"
                                      onClick={() => removeRange(day, idx)}
                                      title={t.bookingPagesSidebar.delete}
                                    >
                                      <X className="h-4 w-4" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 rounded-[11px]"
                                      onClick={() => addRange(day)}
                                      title={t.availabilityEditor.addTimeRange}
                                    >
                                      <Plus className="h-4 w-4 text-muted-foreground" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 rounded-[11px]"
                                      onClick={() => {
                                        // Copy this day's schedule to all other enabled days
                                        const newAvail = { ...availability };
                                        DAY_NAMES.forEach((d) => {
                                          if (d !== day && availability[d].length > 0) {
                                            newAvail[d] = [...ranges];
                                          }
                                        });
                                        setAvailability(newAvail);
                                      }}
                                      title={t.bookingEditor.copyToAllDays}
                                    >
                                      <Copy className="h-4 w-4 text-muted-foreground" />
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground flex-1 h-9 flex items-center">{t.bookingEditor.unavailable}</span>
                          )}
                          {!isEnabled && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 ml-auto rounded-[11px]"
                              onClick={() => toggleDay(day)}
                              title={t.bookingEditor.addAvailability}
                            >
                              <Plus className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  )}

                  {repeatMode === 'none' && (
                    <div className="space-y-2">

                      {/* Specific dates list */}
                      <div className="divide-y">
                        {specificDates.map((sd, sdIdx) => (
                          <div key={sdIdx} className="flex items-start py-3 group/sd min-h-[44px]">
                            <span className="text-sm font-medium w-[90px] shrink-0 h-9 flex items-center">
                              {new Date(sd.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                            </span>
                            <div className="flex-1 space-y-2">
                              {sd.ranges.map((range, rIdx) => (
                                <div key={rIdx} className="flex items-center gap-2">
                                  <Input
                                    type="time"
                                    value={range.start}
                                    onChange={(e) => {
                                      const updated = [...specificDates];
                                      updated[sdIdx].ranges[rIdx] = { ...range, start: e.target.value };
                                      setSpecificDates(updated);
                                    }}
                                    className="h-9 text-sm shadow-none w-[95px] [&::-webkit-calendar-picker-indicator]:hidden"
                                  />
                                  <span className="text-muted-foreground text-sm">–</span>
                                  <Input
                                    type="time"
                                    value={range.end}
                                    onChange={(e) => {
                                      const updated = [...specificDates];
                                      updated[sdIdx].ranges[rIdx] = { ...range, end: e.target.value };
                                      setSpecificDates(updated);
                                    }}
                                    className="h-9 text-sm shadow-none w-[95px] [&::-webkit-calendar-picker-indicator]:hidden"
                                  />
                                  <div className="flex items-center gap-0.5 ml-auto">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 rounded-[11px]"
                                      onClick={() => {
                                        const updated = [...specificDates];
                                        const lastRange = updated[sdIdx].ranges[updated[sdIdx].ranges.length - 1];
                                        const [h] = lastRange.end.split(':').map(Number);
                                        updated[sdIdx].ranges.push({ start: lastRange.end, end: `${String(Math.min(h + 1, 23)).padStart(2, '0')}:00` });
                                        setSpecificDates(updated);
                                      }}
                                    >
                                      <Plus className="h-4 w-4 text-muted-foreground" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 rounded-[11px] hover:bg-destructive/10 hover:text-destructive"
                                      onClick={() => {
                                        const updated = [...specificDates];
                                        updated[sdIdx].ranges = updated[sdIdx].ranges.filter((_, i) => i !== rIdx);
                                        if (updated[sdIdx].ranges.length === 0) {
                                          setSpecificDates(updated.filter((_, i) => i !== sdIdx));
                                        } else {
                                          setSpecificDates(updated);
                                        }
                                      }}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Add date button */}
                      <DatePickerInput
                        placeholder={t.bookingEditor.addDate}
                        fullWidth={false}
                        showIcon={false}
                        showPlusIcon
                        onChange={(date) => {
                          if (date) {
                            const dateStr = format(date, 'yyyy-MM-dd');
                            if (!specificDates.some((sd) => sd.date === dateStr)) {
                              setSpecificDates((prev) => [...prev, { date: dateStr, ranges: [{ start: '09:00', end: '17:00' }] }].sort((a, b) => a.date.localeCompare(b.date)));
                            }
                          }
                        }}
                      />
                    </div>
                  )}
                </div>
            </div>

            {/* Adjusted availability */}
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-3 px-5 py-4 w-full text-left hover:bg-accent/30 transition-colors group">
                <div className="flex-1">
                  <p className="text-sm font-medium">{t.bookingEditor.adjustedAvailability}</p>
                  <p className="text-xs text-muted-foreground">{t.bookingEditor.adjustedAvailabilityHint}</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="px-5 pb-4 space-y-3">
                  <p className="text-xs text-muted-foreground">{t.bookingEditor.adjustedAvailabilityOverrideHint}</p>

                  {/* Adjusted dates list */}
                  {specificDates.length > 0 && (
                    <div className="divide-y">
                      {specificDates.map((sd, sdIdx) => (
                        <div key={sdIdx} className="py-2.5 group/adj space-y-1.5">
                            {sd.ranges.map((range, rIdx) => (
                              <div key={rIdx} className="flex items-center gap-2">
                                {rIdx === 0 && (
                                  <DatePickerInput
                                    value={new Date(sd.date)}
                                    onChange={(d) => {
                                      if (d) {
                                        const updated = [...specificDates];
                                        updated[sdIdx] = { ...updated[sdIdx], date: format(d, 'yyyy-MM-dd') };
                                        setSpecificDates(updated.sort((a, b) => a.date.localeCompare(b.date)));
                                      }
                                    }}
                                    fullWidth={false}
                                    showIcon={false}
                                  />
                                )}
                                {rIdx > 0 && <div className="w-[115px] shrink-0" />}
                                <Input
                                  type="time"
                                  value={range.start}
                                  onChange={(e) => {
                                    const updated = [...specificDates];
                                    updated[sdIdx].ranges[rIdx] = { ...range, start: e.target.value };
                                    setSpecificDates(updated);
                                  }}
                                  className="h-9 text-sm shadow-none w-[95px] [&::-webkit-calendar-picker-indicator]:hidden"
                                />
                                <span className="text-muted-foreground text-sm">–</span>
                                <Input
                                  type="time"
                                  value={range.end}
                                  onChange={(e) => {
                                    const updated = [...specificDates];
                                    updated[sdIdx].ranges[rIdx] = { ...range, end: e.target.value };
                                    setSpecificDates(updated);
                                  }}
                                  className="h-9 text-sm shadow-none w-[95px] [&::-webkit-calendar-picker-indicator]:hidden"
                                />
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 rounded-[11px] hover:bg-destructive/10 hover:text-destructive ml-auto"
                                  onClick={() => {
                                    const updated = [...specificDates];
                                    updated[sdIdx].ranges = updated[sdIdx].ranges.filter((_, i) => i !== rIdx);
                                    if (updated[sdIdx].ranges.length === 0) {
                                      setSpecificDates(updated.filter((_, i) => i !== sdIdx));
                                    } else {
                                      setSpecificDates(updated);
                                    }
                                  }}
                                >
                                  <X className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            ))}
                        </div>
                      ))}
                    </div>
                  )}

                  <DatePickerInput
                    placeholder={t.bookingEditor.changeDateAvailability}
                    fullWidth={false}
                    showPlusIcon
                    showIcon={false}
                    onChange={(date) => {
                      if (date) {
                        const dateStr = format(date, 'yyyy-MM-dd');
                        if (!specificDates.some((sd) => sd.date === dateStr)) {
                          setSpecificDates((prev) => [...prev, { date: dateStr, ranges: [{ start: '09:00', end: '17:00' }] }].sort((a, b) => a.date.localeCompare(b.date)));
                        }
                      }
                    }}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>

            {/* Scheduling window */}
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-3 px-5 py-4 w-full text-left hover:bg-accent/30 transition-colors group">
                <div className="flex-1">
                  <p className="text-sm font-medium">{t.bookingEditor.schedulingWindow}</p>
                  <p className="text-xs text-muted-foreground">{t.bookingEditor.schedulingWindowSummary}</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="px-5 pb-4 space-y-4">
                  <div className="space-y-2">
                    <Label>{t.bookingEditor.minimumNotice}</Label>
                    <div className="flex items-center gap-2">
                      <Input type="number" defaultValue={4} min={0} className="w-[80px]" />
                      <span className="text-sm text-muted-foreground">{t.bookingEditor.hours}</span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>{t.bookingEditor.maximumAdvanceBooking}</Label>
                    <div className="flex items-center gap-2">
                      <Input type="number" defaultValue={60} min={1} className="w-[80px]" />
                      <span className="text-sm text-muted-foreground">{t.bookingEditor.days}</span>
                    </div>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>

            {/* Buffer settings */}
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-3 px-5 py-4 w-full text-left hover:bg-accent/30 transition-colors group">
                <div className="flex-1">
                  <p className="text-sm font-medium">{t.bookingEditor.bookedAppointmentSettings}</p>
                  <p className="text-xs text-muted-foreground">{t.bookingEditor.bookedAppointmentSummary}</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="px-5 pb-4 space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>{t.bookingEditor.bufferBefore}</Label>
                      <div className="flex items-center gap-2">
                        <Input type="number" value={bufferBefore} onChange={(e) => setBufferBefore(Math.max(0, Number(e.target.value)))} min={0} className="w-[80px]" />
                        <span className="text-sm text-muted-foreground">{t.bookingEditor.bufferMin}</span>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>{t.bookingEditor.bufferAfter}</Label>
                      <div className="flex items-center gap-2">
                        <Input type="number" value={bufferAfter} onChange={(e) => setBufferAfter(Math.max(0, Number(e.target.value)))} min={0} className="w-[80px]" />
                        <span className="text-sm text-muted-foreground">{t.bookingEditor.bufferMin}</span>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>{t.bookingEditor.maxBookingsPerDay}</Label>
                    <div className="flex items-center gap-2">
                      <Input type="number" defaultValue={0} min={0} placeholder="0" className="w-[80px]" />
                      <span className="text-sm text-muted-foreground">{t.bookingEditor.maxBookingsUnlimited}</span>
                    </div>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>

            {/* Calendar selection */}
            <div className="px-5 py-4">
              <div className="space-y-2.5">
                <div>
                  <p className="text-sm font-medium">{t.bookingEditor.calendarSection}</p>
                  <p className="text-xs text-muted-foreground">{t.bookingEditor.calendarHint}</p>
                </div>
                <Select
                  value={selectedCalendarId || (calendars[0]?.id || '')}
                  onValueChange={setSelectedCalendarId}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t.bookingEditor.calendarPlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {calendars.map((cal) => (
                      <SelectItem key={cal.id} value={cal.id}>
                        <div className="flex items-center gap-2">
                          <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: cal.color || '#3b82f6' }} />
                          {cal.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t px-5 py-3 flex justify-between shrink-0">
          <Button variant="outline" onClick={handleNavigateAway}>
            {t.bookingEditor.cancel}
          </Button>
          <Button onClick={handleContinue} disabled={isSaving}>
            {isSaving ? (isEdit ? t.bookingEditor.saving : t.bookingEditor.creating) : isEdit ? t.bookingEditor.next : t.bookingEditor.continueLabel}
          </Button>
        </div>
      </div>
      </div>

      <Dialog
        open={blocked}
        onOpenChange={(open) => {
          if (!open && reset) reset();
        }}
      >
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t.bookingEditor.discardChangesTitle}</DialogTitle>
            <DialogDescription>
              {t.bookingEditor.discardChangesDescription}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => proceed?.()} disabled={isSaving}>
              {t.bookingEditor.discard}
            </Button>
            <Button onClick={handleSaveAndProceed} disabled={isSaving}>
              {isSaving ? t.bookingEditor.saving : t.bookingDetail.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DatePickerInput({
  value,
  onChange,
  fullWidth = true,
  placeholder = 'Select date',
  showIcon = true,
  showPlusIcon = false,
}: {
  value?: Date;
  onChange: (date: Date | undefined) => void;
  fullWidth?: boolean;
  placeholder?: string;
  showIcon?: boolean;
  showPlusIcon?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn("font-normal", fullWidth ? "w-full justify-between" : showIcon ? "flex-1 justify-between" : "w-auto justify-start")}
        >
          {showPlusIcon && <Plus className="h-4 w-4" />}
          <span>{value ? value.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : placeholder}</span>
          {showIcon && <LucideCalendar className="h-4 w-4 text-muted-foreground" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto overflow-hidden p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          defaultMonth={value}
          captionLayout="dropdown"
          disabled={{ before: new Date() }}
          onSelect={(date) => {
            onChange(date);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
