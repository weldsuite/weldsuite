import { useState, useMemo, useEffect, useRef } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { useNavigate, useBlocker } from '@tanstack/react-router';
import { getTranslations } from '@/lib/i18n';
import {
  format,
  parse,
  startOfWeek,
  startOfToday,
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
import { useCreateBookingPage } from '@/hooks/queries/use-calendar-queries';
import type { BookingDateOverride, WeeklyAvailability, TimeRange } from '@/hooks/queries/use-calendar-queries';
import { findAvailabilityProblem } from '@weldsuite/core-api-client/schemas/booking-pages';
import type { AvailabilityProblem } from '@weldsuite/core-api-client/schemas/booking-pages';
import { WEEK_STARTS_ON } from '../../lib/calendar-format';
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
import {
  DEFAULT_DURATION_MINUTES,
  DEFAULT_MAX_ADVANCE_DAYS,
  DEFAULT_MIN_NOTICE_MINUTES,
  adjustedAvailabilitySummary,
  bookedAppointmentSummary,
  buildSchedulePayload,
  findOverrideProblem,
  fromDateOverrides,
  hasUnsavedBookingChanges,
  hoursToMinutes,
  minutesToHours,
  parseNumberInput,
  schedulingWindowSummary,
  toDateOverrides,
} from '../../lib/booking-editor-settings';
import type {
  BookingScheduleSettings,
  EditableOverride,
  OverrideProblem,
} from '../../lib/booking-editor-settings';

export interface BookingPageEditorProps {
  mode?: 'create' | 'edit';
  bookingPageId?: string;
  initialData?: {
    title: string;
    duration: number;
    availability: WeeklyAvailability;
    bufferBefore: number;
    bufferAfter: number;
    /** Minutes. */
    minNotice: number;
    /** Days. */
    maxAdvance: number;
    dateOverrides: BookingDateOverride[];
    /** null or 0 = unlimited. */
    maxBookingsPerDay: number | null;
  };
}

// Monday first, like the rest of WeldCalendar (WEEK_STARTS_ON).
const DAY_NAMES: (keyof WeeklyAvailability)[] = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
];

type RepeatMode = 'none' | 'weekly' | 'custom';
type RepeatUnit = 'weeks' | 'months';
type RepeatEndType = 'never' | 'date';

type SpecificDate = EditableOverride;

type BookingPageDestination =
  | { to: '/weldcalendar/scheduling/$id'; params: { id: string } }
  | { to: '/weldcalendar/scheduling/$id/view'; params: { id: string } }
  | { to: '/weldcalendar' };

const DATE_KEY_FORMAT = 'yyyy-MM-dd';
const DEFAULT_BOOKING_NAME = 'New Booking Page';

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const resolveBookingName = (title: string) => title.trim() || DEFAULT_BOOKING_NAME;
const bookingSlug = (name: string) => slugify(name) || 'booking';
const currentTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const defaultRange = (): TimeRange => ({ start: '09:00', end: '17:00' });

// Time ranges have no natural id, so list rows get a stable render key per range
// object. An edit produces a new object; editRange hands the old key over so
// the row (and the focused input in it) is not remounted on every keystroke.
const rangeKeys = new WeakMap<TimeRange, string>();
let rangeKeyCounter = 0;

function rangeKey(range: TimeRange): string {
  let key = rangeKeys.get(range);
  if (!key) {
    rangeKeyCounter += 1;
    key = `range-${rangeKeyCounter}`;
    rangeKeys.set(range, key);
  }
  return key;
}

function editRange(range: TimeRange, patch: Partial<TimeRange>): TimeRange {
  const next = { ...range, ...patch };
  rangeKeys.set(next, rangeKey(range));
  return next;
}

// End time for a new range that starts at `start`: one hour later, capped at 23:00.
function nextRangeEnd(start: string): string {
  const [h] = start.split(':').map(Number);
  return `${String(Math.min(h + 1, 23)).padStart(2, '0')}:00`;
}

// Parsed as a local date: `new Date('2026-10-05')` is UTC midnight, which shows the
// previous day west of Greenwich.
const parseDateKey = (value: string): Date => parse(value, DATE_KEY_FORMAT, new Date());
const parseDateValue = (value: string): Date | undefined => (value ? parseDateKey(value) : undefined);
const formatDateValue = (date: Date | undefined): string => (date ? format(date, DATE_KEY_FORMAT) : '');

// The editor's starting values: the stored page when editing, the defaults when
// creating. Also the baseline the unsaved-changes check compares against.
function resolveInitialValues(
  initialData: BookingPageEditorProps['initialData'],
  isEdit: boolean,
  defaultTitle: string,
): BookingScheduleSettings {
  return {
    title: initialData?.title ?? (isEdit ? '' : defaultTitle),
    duration: initialData?.duration || DEFAULT_DURATION_MINUTES,
    availability: initialData?.availability || DEFAULT_AVAILABILITY,
    bufferBefore: initialData?.bufferBefore || 0,
    bufferAfter: initialData?.bufferAfter || 0,
    minNotice: initialData?.minNotice ?? DEFAULT_MIN_NOTICE_MINUTES,
    maxAdvance: initialData?.maxAdvance ?? DEFAULT_MAX_ADVANCE_DAYS,
    dateOverrides: initialData?.dateOverrides ?? [],
    maxBookingsPerDay: initialData?.maxBookingsPerDay ?? 0,
  };
}

// Header label mirrors the main calendar / viewer: "May 2026" when the
// visible week is inside one month, "Apr – May 2026" when it spans two.
function formatWeekHeaderLabel(weekStart: Date): string {
  const weekEnd = addDays(weekStart, 6);
  if (weekStart.getMonth() === weekEnd.getMonth() && weekStart.getFullYear() === weekEnd.getFullYear()) {
    return format(weekStart, 'MMMM yyyy');
  }
  const yearLabel = weekStart.getFullYear() === weekEnd.getFullYear()
    ? format(weekEnd, 'yyyy')
    : `${format(weekStart, 'yyyy')} – ${format(weekEnd, 'yyyy')}`;
  return `${format(weekStart, 'MMM')} – ${format(weekEnd, 'MMM')} ${yearLabel}`;
}

function isCurrentWeek(weekStart: Date): boolean {
  const now = new Date();
  return now >= weekStart && now < addDays(weekStart, 7);
}

// Convert availability to visual blocks for the week view
function getAvailabilityBlocks(
  dayDate: Date,
  repeatMode: RepeatMode,
  specificDates: SpecificDate[],
  availability: WeeklyAvailability,
): TimeRange[] {
  if (repeatMode === 'none') {
    const dateStr = format(dayDate, DATE_KEY_FORMAT);
    const sd = specificDates.find((d) => d.date === dateStr);
    return sd?.ranges || [];
  }
  // An adjusted date replaces the weekly hours for that date (empty = unavailable).
  const override = specificDates.find((d) => d.date === format(dayDate, DATE_KEY_FORMAT));
  if (override) return override.ranges;
  const dayName = format(dayDate, 'EEEE').toLowerCase() as keyof WeeklyAvailability;
  return availability[dayName] || [];
}

function destinationForNewPage(newId: string | null | undefined): BookingPageDestination {
  return newId
    ? { to: '/weldcalendar/scheduling/$id/view', params: { id: newId } }
    : { to: '/weldcalendar' };
}

function continueButtonLabel(
  isSaving: boolean,
  isEdit: boolean,
  labels: { saving: string; creating: string; next: string; continueLabel: string },
): string {
  if (isSaving) return isEdit ? labels.saving : labels.creating;
  return isEdit ? labels.next : labels.continueLabel;
}

function repeatSummaryLabel(
  mode: RepeatMode,
  every: number,
  unit: RepeatUnit,
  labels: { weeks: string; months: string; doesNotRepeat: string; repeatWeekly: string },
): string {
  if (mode === 'custom') return `${every} ${unit === 'weeks' ? labels.weeks : labels.months}`;
  return mode === 'none' ? labels.doesNotRepeat : labels.repeatWeekly;
}

// Immutable helpers for the specific-dates list.
function patchSpecificRange(dates: SpecificDate[], sdIdx: number, rIdx: number, patch: Partial<TimeRange>): SpecificDate[] {
  return dates.map((sd, i) =>
    i === sdIdx
      ? { ...sd, ranges: sd.ranges.map((range, j) => (j === rIdx ? editRange(range, patch) : range)) }
      : sd,
  );
}

function appendSpecificRange(dates: SpecificDate[], sdIdx: number): SpecificDate[] {
  return dates.map((sd, i) => {
    if (i !== sdIdx) return sd;
    const lastRange = sd.ranges[sd.ranges.length - 1];
    if (!lastRange) return { ...sd, ranges: [defaultRange()] };
    return { ...sd, ranges: [...sd.ranges, { start: lastRange.end, end: nextRangeEnd(lastRange.end) }] };
  });
}

function removeSpecificRange(dates: SpecificDate[], sdIdx: number, rIdx: number): SpecificDate[] {
  const updated = dates.map((sd, i) =>
    i === sdIdx ? { ...sd, ranges: sd.ranges.filter((_, j) => j !== rIdx) } : sd,
  );
  return updated[sdIdx]?.ranges.length === 0 ? updated.filter((_, i) => i !== sdIdx) : updated;
}

const sortByDate = (dates: SpecificDate[]): SpecificDate[] => dates.toSorted((a, b) => a.date.localeCompare(b.date));

function useSpecificDates(initial: SpecificDate[]) {
  const [dates, setDates] = useState<SpecificDate[]>(initial);

  const addDate = (date: Date | undefined) => {
    if (!date) return;
    const dateStr = format(date, DATE_KEY_FORMAT);
    if (dates.some((sd) => sd.date === dateStr)) return;
    setDates((prev) => sortByDate([...prev, { date: dateStr, ranges: [defaultRange()] }]));
  };

  const changeDate = (sdIdx: number, date: Date | undefined) => {
    if (!date) return;
    const dateStr = format(date, DATE_KEY_FORMAT);
    setDates((prev) => {
      // Two rows for one date would be ambiguous (and share a React key).
      if (prev.some((sd, i) => i !== sdIdx && sd.date === dateStr)) return prev;
      return sortByDate(prev.map((sd, i) => (i === sdIdx ? { ...sd, date: dateStr } : sd)));
    });
  };

  // No hours at all on a date = the whole day is unavailable.
  const markUnavailable = (sdIdx: number) =>
    setDates((prev) => prev.map((sd, i) => (i === sdIdx ? { ...sd, ranges: [] } : sd)));
  const removeDate = (sdIdx: number) => setDates((prev) => prev.filter((_, i) => i !== sdIdx));

  const updateRange = (sdIdx: number, rIdx: number, patch: Partial<TimeRange>) =>
    setDates((prev) => patchSpecificRange(prev, sdIdx, rIdx, patch));
  const addRange = (sdIdx: number) => setDates((prev) => appendSpecificRange(prev, sdIdx));
  const removeRange = (sdIdx: number, rIdx: number) =>
    setDates((prev) => removeSpecificRange(prev, sdIdx, rIdx));

  return { dates, addDate, changeDate, markUnavailable, removeDate, updateRange, addRange, removeRange };
}

type SpecificDatesApi = ReturnType<typeof useSpecificDates>;

function useCustomRepeat() {
  const [open, setOpen] = useState(false);
  const [every, setEvery] = useState(2);
  const [unit, setUnit] = useState<RepeatUnit>('weeks');
  const [start, setStart] = useState(() => format(new Date(), DATE_KEY_FORMAT));
  const [endType, setEndType] = useState<RepeatEndType>('never');
  const [endDate, setEndDate] = useState('');
  return { open, setOpen, every, setEvery, unit, setUnit, start, setStart, endType, setEndType, endDate, setEndDate };
}

type CustomRepeatState = ReturnType<typeof useCustomRepeat>;

// Keeps the draft title atom in sync while creating a booking page. Cleared on
// unmount unless the returned `continuing` ref was set (the user continued to
// the draft Details page, where the Details page itself keeps the atom in sync).
function useDraftTitleSync(isEdit: boolean, title: string) {
  const setDraftTitle = useSetAtom(draftBookingPageTitleAtom);
  const continuing = useRef({ active: false }).current;
  useEffect(() => {
    if (isEdit) return;
    setDraftTitle(title);
  }, [isEdit, title, setDraftTitle]);
  useEffect(() => {
    if (isEdit) return;
    return () => {
      if (!continuing.active) setDraftTitle(null);
    };
  }, [isEdit, setDraftTitle, continuing]);
  return continuing;
}

// Dynamic per-hour row height — keeps 24 hours filling the visible scroll
// area exactly (matches the main calendar's WeekView). Without this the
// grid stretches to 100% but the static 48px cells don't, leaving an empty
// "phantom" row below 11 PM when the viewport is taller than 1152px.
function usePreviewHourHeight() {
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
  return { containerRef, hourHeight };
}

export default function NewBookingPage() {
  return <BookingPageEditor mode="create" />;
}

export function BookingPageEditor({ mode = 'create', bookingPageId, initialData }: Readonly<BookingPageEditorProps>) {
  const t = getTranslations('weldcalendar');

  // Booking pages are inherently week-based, but we expose the same view
  // dropdown the main calendar uses so the toolbar reads identically.
  const VIEW_OPTIONS = [
    { label: t.calendarView.viewWeek, value: 'week' as const },
  ];
  const navigate = useNavigate();
  const createBookingPage = useCreateBookingPage();
  const isEdit = mode === 'edit';
  // Id of the booking page being edited (undefined when creating a new one).
  const editingId = isEdit ? bookingPageId : undefined;

  const savedRef = useRef(false);

  const initial = resolveInitialValues(initialData, isEdit, t.bookingPagesSidebar.defaultTitle);
  const [title, setTitle] = useState(initial.title);
  // Set when the user continues to the draft Details page (see handleContinue).
  const continuing = useDraftTitleSync(isEdit, title);
  const [duration, setDuration] = useState(initial.duration);
  const [customDuration, setCustomDuration] = useState(false);
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [availability, setAvailability] = useState<WeeklyAvailability>(initial.availability);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('weekly');
  const specific = useSpecificDates(fromDateOverrides(initial.dateOverrides));
  const [bufferBefore, setBufferBefore] = useState(initial.bufferBefore);
  const [bufferAfter, setBufferAfter] = useState(initial.bufferAfter);
  const [minNotice, setMinNotice] = useState(initial.minNotice);
  const [maxAdvance, setMaxAdvance] = useState(initial.maxAdvance);
  const [maxBookingsPerDay, setMaxBookingsPerDay] = useState(initial.maxBookingsPerDay);
  const [currentWeekStart, setCurrentWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: WEEK_STARTS_ON }));

  // A range that ends before it starts (Monday 18:00-17:00), or overlaps another
  // one, can never produce a slot. Block saving instead of publishing a page
  // whose days are selectable but empty. The API enforces the same rule.
  const availabilityProblem = repeatMode === 'none' ? null : findAvailabilityProblem(availability);
  // Adjusted dates are saved whatever the repeat mode, so they are always checked.
  const overrideProblem = findOverrideProblem(specific.dates);
  const hasScheduleProblem = !!availabilityProblem || !!overrideProblem;

  // Everything the Schedule tab edits, in the units the API stores.
  const settings: BookingScheduleSettings = {
    title,
    duration,
    availability,
    bufferBefore,
    bufferAfter,
    minNotice,
    maxAdvance,
    dateOverrides: toDateOverrides(specific.dates),
    maxBookingsPerDay,
  };

  const hasUnsavedChanges = () => hasUnsavedBookingChanges(initial, settings);

  const handleNavigateAway = () => {
    if (editingId) {
      navigate({ to: '/weldcalendar/scheduling/$id/view', params: { id: editingId } });
      return;
    }
    navigate({ to: '/weldcalendar' });
  };

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

  const headerLabel = formatWeekHeaderLabel(currentWeekStart);
  const isTodayInWeek = isCurrentWeek(currentWeekStart);

  // Persists the booking page (API mutate in create mode, sessionStorage in
  // edit mode) and returns the destination route the normal Save flow should
  // navigate to. Does NOT navigate — callers decide.
  const persistBookingPage = async (): Promise<BookingPageDestination> => {
    if (hasScheduleProblem) throw new Error('invalid availability');
    const name = resolveBookingName(title);

    if (editingId) {
      sessionStorage.setItem(`booking-edit-${editingId}`, JSON.stringify({
        name,
        ...buildSchedulePayload(settings),
      }));
      return { to: '/weldcalendar/scheduling/$id', params: { id: editingId } };
    }
    const result = await createBookingPage.mutateAsync({
      name,
      slug: bookingSlug(name),
      ...buildSchedulePayload(settings),
      timezone: currentTimezone(),
    });
    return destinationForNewPage(result?.data?.id);
  };

  // In edit mode, behaves like the old "Next" — persist to sessionStorage and
  // jump to the Details page for this existing booking page. In create mode,
  // stash the form data in sessionStorage under the special `__draft__` key
  // and navigate to the Details page in draft mode (where the Create button
  // actually fires the API).
  const handleContinue = () => {
    if (hasScheduleProblem) return;
    const name = resolveBookingName(title);
    if (editingId) {
      sessionStorage.setItem(`booking-edit-${editingId}`, JSON.stringify({
        name,
        ...buildSchedulePayload(settings),
      }));
      savedRef.current = true;
      navigate({ to: '/weldcalendar/scheduling/$id', params: { id: editingId } });
      return;
    }
    sessionStorage.setItem('booking-new-draft', JSON.stringify({
      name,
      slug: bookingSlug(name),
      ...buildSchedulePayload(settings),
      timezone: currentTimezone(),
    }));
    savedRef.current = true;
    continuing.active = true;
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

  const weekPreview = (
    // Uses the shared <WeekDayHeader> + time-grid primitives so the booking
    // editor's preview stays visually identical to the main calendar page.
    <WeekPreview
      weekDays={weekDays}
      getBlocks={(day) => getAvailabilityBlocks(day, repeatMode, specific.dates, availability)}
      duration={duration}
      bufferBefore={bufferBefore}
      bufferAfter={bufferAfter}
    />
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
            <ToolbarSearch
              open={searchOpen}
              onOpenChange={setSearchOpen}
              query={searchQuery}
              onQueryChange={setSearchQuery}
            />
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
            <DurationSection
              duration={duration}
              onDurationChange={setDuration}
              customDuration={customDuration}
              onCustomDurationChange={setCustomDuration}
              customDialogOpen={customDialogOpen}
              onCustomDialogOpenChange={setCustomDialogOpen}
            />

            {/* General availability */}
            <AvailabilitySection
              repeatMode={repeatMode}
              onRepeatModeChange={setRepeatMode}
              availability={availability}
              onAvailabilityChange={setAvailability}
              availabilityProblem={availabilityProblem}
              specific={specific}
            />

            {/* Adjusted availability */}
            <AdjustedAvailabilitySection specific={specific} problem={overrideProblem} />

            {/* Scheduling window */}
            <CollapsibleSection
              title={t.bookingEditor.schedulingWindow}
              summary={schedulingWindowSummary(minNotice, maxAdvance, t.bookingEditor)}
            >
              <div className="px-5 pb-4 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="booking-min-notice">{t.bookingEditor.minimumNotice}</Label>
                  <div className="flex items-center gap-2">
                    <NumberField
                      id="booking-min-notice"
                      value={minutesToHours(minNotice)}
                      min={0}
                      onCommit={(hours) => setMinNotice(hoursToMinutes(hours))}
                    />
                    <span className="text-sm text-muted-foreground">{t.bookingEditor.hours}</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="booking-max-advance">{t.bookingEditor.maximumAdvanceBooking}</Label>
                  <div className="flex items-center gap-2">
                    <NumberField
                      id="booking-max-advance"
                      value={maxAdvance}
                      min={1}
                      integer
                      onCommit={setMaxAdvance}
                    />
                    <span className="text-sm text-muted-foreground">{t.bookingEditor.days}</span>
                  </div>
                </div>
              </div>
            </CollapsibleSection>

            {/* Buffer settings */}
            <CollapsibleSection
              title={t.bookingEditor.bookedAppointmentSettings}
              summary={bookedAppointmentSummary({ bufferBefore, bufferAfter, maxBookingsPerDay }, t.bookingEditor)}
            >
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
                  <Label htmlFor="booking-max-per-day">{t.bookingEditor.maxBookingsPerDay}</Label>
                  <div className="flex items-center gap-2">
                    <NumberField
                      id="booking-max-per-day"
                      value={maxBookingsPerDay}
                      min={0}
                      integer
                      onCommit={setMaxBookingsPerDay}
                    />
                    <span className="text-sm text-muted-foreground">{t.bookingEditor.maxBookingsUnlimited}</span>
                  </div>
                </div>
              </div>
            </CollapsibleSection>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t px-5 py-3 flex justify-between shrink-0">
          <Button variant="outline" onClick={handleNavigateAway}>
            {t.bookingEditor.cancel}
          </Button>
          <Button onClick={handleContinue} disabled={isSaving || hasScheduleProblem}>
            {continueButtonLabel(isSaving, isEdit, t.bookingEditor)}
          </Button>
        </div>
      </div>
      </div>

      <Dialog
        open={blocked}
        onOpenChange={(open) => {
          if (!open) reset?.();
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

function ToolbarSearch({
  open,
  onOpenChange,
  query,
  onQueryChange,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
}>) {
  const t = getTranslations('weldcalendar');

  return (
    <div className="relative flex items-center">
      <div className={cn(
        'flex items-center transition-all duration-200 ease-out',
        open ? 'w-48' : 'w-8',
      )}>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-8 w-8 p-0 flex-shrink-0 shadow-none transition-opacity duration-200',
            open && 'opacity-0 pointer-events-none absolute',
          )}
          onClick={() => onOpenChange(true)}
        >
          <Search className="h-4 w-4" />
        </Button>
        <div className={cn(
          'relative transition-all duration-200 ease-out',
          open ? 'opacity-100 w-48' : 'opacity-0 w-0 pointer-events-none',
        )}>
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder={t.bookingEditor.searchAvailabilityPlaceholder}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onBlur={() => !query && onOpenChange(false)}
            onKeyDown={(e) => { if (e.key === 'Escape') { onQueryChange(''); onOpenChange(false); } }}
            ref={(el) => { if (el && open) el.focus(); }}
            className="h-8 w-full pl-8 pr-3 text-sm border border-gray-200 dark:border-border rounded-md bg-white dark:bg-background focus:outline-none"
          />
        </div>
      </div>
    </div>
  );
}

function NowIndicator({ hourHeight }: Readonly<{ hourHeight: number }>) {
  const now = new Date();
  const h = now.getHours() + now.getMinutes() / 60;
  const topPx = h * hourHeight;
  return (
    <div className="absolute left-0 right-0 z-[3] pointer-events-none" style={{ top: `${topPx}px` }}>
      <div className="flex items-center">
        <div className="w-2.5 h-2.5 rounded-full bg-red-500 -ml-[5px]" />
        <div className="flex-1 h-[2px] bg-red-500" />
      </div>
    </div>
  );
}

function AvailabilityBlock({
  block,
  hourHeight,
  duration,
  bufferBefore,
  bufferAfter,
}: Readonly<{
  block: TimeRange;
  hourHeight: number;
  duration: number;
  bufferBefore: number;
  bufferAfter: number;
}>) {
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
}

function WeekPreview({
  weekDays,
  getBlocks,
  duration,
  bufferBefore,
  bufferAfter,
}: Readonly<{
  weekDays: Date[];
  getBlocks: (day: Date) => TimeRange[];
  duration: number;
  bufferBefore: number;
  bufferAfter: number;
}>) {
  const { containerRef, hourHeight } = usePreviewHourHeight();

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <WeekDayHeader days={weekDays} />
      <TimeGridScroll ref={containerRef}>
        <TimeGridInner days={weekDays}>
          <TimeLabelColumn hourHeight={hourHeight} />
          {weekDays.map((day) => (
            <div key={day.toISOString()} className="border-r border-border last:border-r-0 relative">
              {SHARED_HOURS.map((hour) => (
                <div key={hour} className="border-b border-border" style={{ height: hourHeight }} />
              ))}
              {getBlocks(day).map((block) => (
                <AvailabilityBlock
                  key={`${block.start}-${block.end}`}
                  block={block}
                  hourHeight={hourHeight}
                  duration={duration}
                  bufferBefore={bufferBefore}
                  bufferAfter={bufferAfter}
                />
              ))}
              {isToday(day) && <NowIndicator hourHeight={hourHeight} />}
            </div>
          ))}
        </TimeGridInner>
      </TimeGridScroll>
    </div>
  );
}

/**
 * A number input that keeps what the user is typing (empty, "1.") while only
 * committing values that satisfy `min` / `integer`. Reverts to the last
 * committed value on blur.
 */
function NumberField({
  id,
  value,
  min,
  integer = false,
  onCommit,
}: Readonly<{
  id: string;
  value: number;
  min: number;
  integer?: boolean;
  onCommit: (value: number) => void;
}>) {
  const [text, setText] = useState(String(value));

  // Follow the value when it changes from outside, but not for the edit that caused it.
  useEffect(() => {
    setText((prev) => (parseNumberInput(prev) === value ? prev : String(value)));
  }, [value]);

  const handleChange = (raw: string) => {
    setText(raw);
    const parsed = parseNumberInput(raw);
    if (parsed === null || parsed < min || (integer && !Number.isInteger(parsed))) return;
    onCommit(parsed);
  };

  return (
    <Input
      id={id}
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      value={text}
      onChange={(e) => handleChange(e.target.value)}
      onBlur={() => setText(String(value))}
      className="w-[80px]"
    />
  );
}

function CollapsibleSection({
  title,
  summary,
  children,
}: Readonly<{ title: string; summary: string; children: ReactNode }>) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex items-center gap-3 px-5 py-4 w-full text-left hover:bg-accent/30 transition-colors group">
        <div className="flex-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{summary}</p>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

function TimeRangeInputs({
  range,
  invalid = false,
  onStartChange,
  onEndChange,
}: Readonly<{
  range: TimeRange;
  invalid?: boolean;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
}>) {
  const inputClass = cn(
    'h-9 text-sm shadow-none w-[95px] [&::-webkit-calendar-picker-indicator]:hidden',
    invalid && 'border-destructive focus-visible:ring-destructive/30',
  );
  return (
    <>
      <Input
        type="time"
        value={range.start}
        aria-invalid={invalid || undefined}
        onChange={(e) => onStartChange(e.target.value)}
        className={inputClass}
      />
      <span className="text-muted-foreground text-sm">–</span>
      <Input
        type="time"
        value={range.end}
        aria-invalid={invalid || undefined}
        onChange={(e) => onEndChange(e.target.value)}
        className={inputClass}
      />
    </>
  );
}

function DurationSection({
  duration,
  onDurationChange,
  customDuration,
  onCustomDurationChange,
  customDialogOpen,
  onCustomDialogOpenChange,
}: Readonly<{
  duration: number;
  onDurationChange: (duration: number) => void;
  customDuration: boolean;
  onCustomDurationChange: (custom: boolean) => void;
  customDialogOpen: boolean;
  onCustomDialogOpenChange: (open: boolean) => void;
}>) {
  const t = getTranslations('weldcalendar');

  const handleValueChange = (value: string) => {
    if (value === 'custom') {
      onCustomDurationChange(true);
      onCustomDialogOpenChange(true);
      return;
    }
    onCustomDurationChange(false);
    onDurationChange(Number(value));
  };

  return (
    <div className="px-5 py-4">
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{t.bookingEditor.appointmentDuration}</p>
            <p className="text-xs text-muted-foreground">{t.bookingEditor.appointmentDurationHint}</p>
          </div>
          <Select
            value={customDuration ? 'custom' : String(duration)}
            onValueChange={handleValueChange}
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
                    setTimeout(() => onCustomDialogOpenChange(true), 100);
                  }
                }}
              >
                {t.bookingEditor.customRepeat}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <CustomDurationDialog
          open={customDialogOpen}
          onOpenChange={onCustomDialogOpenChange}
          duration={duration}
          onDurationChange={onDurationChange}
          onCustomDurationChange={onCustomDurationChange}
        />
      </div>
    </div>
  );
}

function CustomDurationDialog({
  open,
  onOpenChange,
  duration,
  onDurationChange,
  onCustomDurationChange,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  duration: number;
  onDurationChange: (duration: number) => void;
  onCustomDurationChange: (custom: boolean) => void;
}>) {
  const t = getTranslations('weldcalendar');

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next && !duration) onCustomDurationChange(false); }}>
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
              if (val >= 1) onDurationChange(val);
            }}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') onOpenChange(false);
            }}
          />
          <span className="text-sm text-muted-foreground shrink-0">{t.bookingEditor.minutes}</span>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => { onOpenChange(false); onCustomDurationChange(false); }}>{t.bookingEditor.cancel}</Button>
          <Button type="button" onClick={() => onOpenChange(false)}>{t.bookingEditor.done}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AvailabilitySection({
  repeatMode,
  onRepeatModeChange,
  availability,
  onAvailabilityChange,
  availabilityProblem,
  specific,
}: Readonly<{
  repeatMode: RepeatMode;
  onRepeatModeChange: (mode: RepeatMode) => void;
  availability: WeeklyAvailability;
  onAvailabilityChange: Dispatch<SetStateAction<WeeklyAvailability>>;
  availabilityProblem: AvailabilityProblem | null;
  specific: SpecificDatesApi;
}>) {
  const t = getTranslations('weldcalendar');
  const customRepeat = useCustomRepeat();

  const handleRepeatSelect = (value: string) => {
    if (value === 'custom') {
      onRepeatModeChange('custom');
      customRepeat.setOpen(true);
      return;
    }
    onRepeatModeChange(value === 'none' ? 'none' : 'weekly');
  };

  return (
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
        <Select value={repeatMode} onValueChange={handleRepeatSelect}>
          <SelectTrigger className="w-[200px] shadow-none">
            <SelectValue>
              {repeatSummaryLabel(repeatMode, customRepeat.every, customRepeat.unit, t.bookingEditor)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t.bookingEditor.doesNotRepeat}</SelectItem>
            <SelectItem value="weekly">{t.bookingEditor.repeatWeekly}</SelectItem>
            <SelectItem
              value="custom"
              onPointerUp={() => {
                if (repeatMode === 'custom') {
                  setTimeout(() => customRepeat.setOpen(true), 100);
                }
              }}
            >
              {t.bookingEditor.customRepeat}
            </SelectItem>
          </SelectContent>
        </Select>

        <CustomRepeatDialog
          state={customRepeat}
          repeatMode={repeatMode}
          onRepeatModeChange={onRepeatModeChange}
        />

        {/* Day rows for regular availability, or a date list for one-off dates */}
        {repeatMode === 'none' ? (
          <SpecificDatesEditor specific={specific} />
        ) : (
          <WeeklyAvailabilityEditor
            availability={availability}
            onChange={onAvailabilityChange}
            problem={availabilityProblem}
          />
        )}
      </div>
    </div>
  );
}

function CustomRepeatDialog({
  state,
  repeatMode,
  onRepeatModeChange,
}: Readonly<{
  state: CustomRepeatState;
  repeatMode: RepeatMode;
  onRepeatModeChange: (mode: RepeatMode) => void;
}>) {
  const t = getTranslations('weldcalendar');

  const handleOpenChange = (open: boolean) => {
    state.setOpen(open);
    if (!open && repeatMode !== 'custom') onRepeatModeChange('weekly');
  };

  const handleCancel = () => {
    state.setOpen(false);
    onRepeatModeChange('weekly');
  };

  return (
    <Dialog open={state.open} onOpenChange={handleOpenChange}>
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
                value={state.every}
                onChange={(e) => state.setEvery(Math.max(1, Number(e.target.value)))}
                className="w-[70px]"
                autoFocus
              />
              <Select value={state.unit} onValueChange={(v) => state.setUnit(v as RepeatUnit)}>
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
              value={parseDateValue(state.start)}
              onChange={(d) => state.setStart(formatDateValue(d))}
            />
          </div>

          {/* Ends */}
          <div className="space-y-2">
            <Label>{t.bookingEditor.ends}</Label>
            <div className="flex items-center gap-2">
              <Select value={state.endType} onValueChange={(v) => state.setEndType(v as RepeatEndType)}>
                <SelectTrigger className="w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="never">{t.bookingEditor.endNever}</SelectItem>
                  <SelectItem value="date">{t.bookingEditor.endOnDate}</SelectItem>
                </SelectContent>
              </Select>
              {state.endType === 'date' && (
                <DatePickerInput
                  value={parseDateValue(state.endDate)}
                  onChange={(d) => state.setEndDate(formatDateValue(d))}
                  fullWidth={false}
                />
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleCancel}>{t.bookingEditor.cancel}</Button>
          <Button
            type="button"
            onClick={() => state.setOpen(false)}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 h-9 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {t.bookingEditor.done}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WeeklyAvailabilityEditor({
  availability,
  onChange,
  problem,
}: Readonly<{
  availability: WeeklyAvailability;
  onChange: Dispatch<SetStateAction<WeeklyAvailability>>;
  problem: AvailabilityProblem | null;
}>) {
  const t = getTranslations('weldcalendar');
  const dayShort: Record<keyof WeeklyAvailability, string> = {
    sunday: t.bookingEditorDays.sun,
    monday: t.bookingEditorDays.mon,
    tuesday: t.bookingEditorDays.tue,
    wednesday: t.bookingEditorDays.wed,
    thursday: t.bookingEditorDays.thu,
    friday: t.bookingEditorDays.fri,
    saturday: t.bookingEditorDays.sat,
  };

  const updateDay = (day: keyof WeeklyAvailability, ranges: TimeRange[]) => {
    onChange((prev) => ({ ...prev, [day]: ranges }));
  };

  const enableDay = (day: keyof WeeklyAvailability) => {
    updateDay(day, [defaultRange()]);
  };

  const addRange = (day: keyof WeeklyAvailability) => {
    const ranges = [...availability[day]];
    const lastRange = ranges[ranges.length - 1];
    const newStart = lastRange ? lastRange.end : '09:00';
    ranges.push({ start: newStart, end: nextRangeEnd(newStart) });
    updateDay(day, ranges);
  };

  const removeRange = (day: keyof WeeklyAvailability, index: number) => {
    updateDay(day, availability[day].filter((_, i) => i !== index));
  };

  const updateRange = (day: keyof WeeklyAvailability, index: number, patch: Partial<TimeRange>) => {
    const ranges = [...availability[day]];
    ranges[index] = editRange(ranges[index], patch);
    updateDay(day, ranges);
  };

  // Copy this day's schedule to all other enabled days
  const copyToAllDays = (source: keyof WeeklyAvailability, ranges: TimeRange[]) => {
    const newAvail = { ...availability };
    DAY_NAMES.forEach((d) => {
      if (d !== source && availability[d].length > 0) {
        newAvail[d] = [...ranges];
      }
    });
    onChange(newAvail);
  };

  return (
    <div className="divide-y">
      {DAY_NAMES.map((day) => (
        <DayAvailabilityRow
          key={day}
          label={dayShort[day]}
          ranges={availability[day]}
          problem={problem?.day === day ? problem : null}
          onEnable={() => enableDay(day)}
          onAddRange={() => addRange(day)}
          onRemoveRange={(idx) => removeRange(day, idx)}
          onUpdateRange={(idx, patch) => updateRange(day, idx, patch)}
          onCopyToAll={() => copyToAllDays(day, availability[day])}
        />
      ))}
    </div>
  );
}

function DayAvailabilityRow({
  label,
  ranges,
  problem,
  onEnable,
  onAddRange,
  onRemoveRange,
  onUpdateRange,
  onCopyToAll,
}: Readonly<{
  label: string;
  ranges: TimeRange[];
  /** The first invalid range on this day, if any. Shown inline and blocks saving. */
  problem: AvailabilityProblem | null;
  onEnable: () => void;
  onAddRange: () => void;
  onRemoveRange: (index: number) => void;
  onUpdateRange: (index: number, patch: Partial<TimeRange>) => void;
  onCopyToAll: () => void;
}>) {
  const t = getTranslations('weldcalendar');
  const isEnabled = ranges.length > 0;

  return (
    <div className="flex items-start py-3 group/day min-h-[44px]">
      <span className={cn('text-sm w-10 shrink-0 h-9 flex items-center', isEnabled ? 'font-medium' : 'text-muted-foreground')}>
        {label}
      </span>
      {isEnabled ? (
        <div className="flex-1 space-y-2">
          {ranges.map((range, idx) => (
            <div key={rangeKey(range)} className="space-y-1">
              <div className="flex items-center gap-2">
                <TimeRangeInputs
                  range={range}
                  invalid={problem?.index === idx}
                  onStartChange={(value) => onUpdateRange(idx, { start: value })}
                  onEndChange={(value) => onUpdateRange(idx, { end: value })}
                />
                <div className="flex items-center gap-0.5 ml-auto">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-[11px] hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => onRemoveRange(idx)}
                    title={t.bookingPagesSidebar.delete}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-[11px]"
                    onClick={onAddRange}
                    title={t.availabilityEditor.addTimeRange}
                  >
                    <Plus className="h-4 w-4 text-muted-foreground" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-[11px]"
                    onClick={onCopyToAll}
                    title={t.bookingEditor.copyToAllDays}
                  >
                    <Copy className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
              </div>
              {problem?.index === idx && (
                <p role="alert" className="text-xs text-destructive">
                  {problem.kind === 'end-before-start'
                    ? t.bookingEditor.availabilityEndBeforeStart
                    : t.bookingEditor.availabilityOverlap}
                </p>
              )}
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
          onClick={onEnable}
          title={t.bookingEditor.addAvailability}
        >
          <Plus className="h-4 w-4 text-muted-foreground" />
        </Button>
      )}
    </div>
  );
}

function SpecificDatesEditor({ specific }: Readonly<{ specific: SpecificDatesApi }>) {
  const t = getTranslations('weldcalendar');

  return (
    <div className="space-y-2">

      {/* Specific dates list */}
      <div className="divide-y">
        {specific.dates.map((sd, sdIdx) => (
          <div key={sd.date} className="flex items-start py-3 group/sd min-h-[44px]">
            <span className="text-sm font-medium w-[90px] shrink-0 h-9 flex items-center">
              {parseDateKey(sd.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
            <div className="flex-1 space-y-2">
              {sd.ranges.map((range, rIdx) => (
                <div key={rangeKey(range)} className="flex items-center gap-2">
                  <TimeRangeInputs
                    range={range}
                    onStartChange={(value) => specific.updateRange(sdIdx, rIdx, { start: value })}
                    onEndChange={(value) => specific.updateRange(sdIdx, rIdx, { end: value })}
                  />
                  <div className="flex items-center gap-0.5 ml-auto">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-[11px]"
                      onClick={() => specific.addRange(sdIdx)}
                    >
                      <Plus className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-[11px] hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => specific.removeRange(sdIdx, rIdx)}
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
        onChange={specific.addDate}
      />
    </div>
  );
}

function AdjustedAvailabilitySection({
  specific,
  problem,
}: Readonly<{ specific: SpecificDatesApi; problem: OverrideProblem | null }>) {
  const t = getTranslations('weldcalendar');

  return (
    <CollapsibleSection
      title={t.bookingEditor.adjustedAvailability}
      summary={adjustedAvailabilitySummary(specific.dates.length, t.bookingEditor)}
    >
      <div className="px-5 pb-4 space-y-3">
        <p className="text-xs text-muted-foreground">{t.bookingEditor.adjustedAvailabilityOverrideHint}</p>

        {/* Adjusted dates list */}
        {specific.dates.length > 0 && (
          <div className="divide-y">
            {specific.dates.map((sd, sdIdx) => (
              <div key={sd.date} className="py-2.5 group/adj space-y-1.5">
                {sd.ranges.length === 0 && (
                  <div className="flex items-center gap-2">
                    <DatePickerInput
                      value={parseDateKey(sd.date)}
                      onChange={(d) => specific.changeDate(sdIdx, d)}
                      fullWidth={false}
                      showIcon={false}
                    />
                    <span className="text-sm text-muted-foreground">{t.bookingEditor.dateUnavailable}</span>
                    <div className="flex items-center gap-0.5 ml-auto">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 rounded-[11px]"
                        onClick={() => specific.addRange(sdIdx)}
                        title={t.bookingEditor.addHoursToDate}
                        aria-label={t.bookingEditor.addHoursToDate}
                      >
                        <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 rounded-[11px] hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => specific.removeDate(sdIdx)}
                        title={t.bookingEditor.removeDate}
                        aria-label={t.bookingEditor.removeDate}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
                {sd.ranges.map((range, rIdx) => {
                  const rangeInvalid = problem?.dateIndex === sdIdx && problem.index === rIdx;
                  return (
                    <div key={rangeKey(range)} className="space-y-1">
                      <div className="flex items-center gap-2">
                        {rIdx === 0 && (
                          <DatePickerInput
                            value={parseDateKey(sd.date)}
                            onChange={(d) => specific.changeDate(sdIdx, d)}
                            fullWidth={false}
                            showIcon={false}
                          />
                        )}
                        {rIdx > 0 && <div className="w-[115px] shrink-0" />}
                        <TimeRangeInputs
                          range={range}
                          invalid={rangeInvalid}
                          onStartChange={(value) => specific.updateRange(sdIdx, rIdx, { start: value })}
                          onEndChange={(value) => specific.updateRange(sdIdx, rIdx, { end: value })}
                        />
                        <div className="flex items-center gap-0.5 ml-auto">
                          {rIdx === 0 && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-[11px]"
                              onClick={() => specific.markUnavailable(sdIdx)}
                              title={t.bookingEditor.markDateUnavailable}
                              aria-label={t.bookingEditor.markDateUnavailable}
                            >
                              <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 rounded-[11px] hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => specific.removeRange(sdIdx, rIdx)}
                            title={t.bookingPagesSidebar.delete}
                            aria-label={t.bookingPagesSidebar.delete}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                      {rangeInvalid && (
                        <p role="alert" className="text-xs text-destructive">
                          {problem.kind === 'end-before-start'
                            ? t.bookingEditor.availabilityEndBeforeStart
                            : t.bookingEditor.availabilityOverlap}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        <DatePickerInput
          placeholder={t.bookingEditor.changeDateAvailability}
          fullWidth={false}
          showPlusIcon
          showIcon={false}
          onChange={specific.addDate}
        />
      </div>
    </CollapsibleSection>
  );
}

function DatePickerInput({
  value,
  onChange,
  fullWidth = true,
  placeholder = 'Select date',
  showIcon = true,
  showPlusIcon = false,
}: Readonly<{
  value?: Date;
  onChange: (date: Date | undefined) => void;
  fullWidth?: boolean;
  placeholder?: string;
  showIcon?: boolean;
  showPlusIcon?: boolean;
}>) {
  const [open, setOpen] = useState(false);
  // Only dates a guest could actually book: today until the end of the year after next.
  const today = startOfToday();
  const firstMonth = new Date(today.getFullYear(), 0, 1);
  const lastMonth = new Date(today.getFullYear() + 2, 11, 31);
  let widthClass = 'w-auto justify-start';
  if (fullWidth) widthClass = 'w-full justify-between';
  else if (showIcon) widthClass = 'flex-1 justify-between';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn("font-normal", widthClass)}
        >
          {showPlusIcon && <Plus className="h-4 w-4" />}
          <span>{value ? value.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : placeholder}</span>
          {showIcon && <LucideCalendar className="h-4 w-4 text-muted-foreground" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto overflow-hidden p-0" align="start">
        <Calendar
          mode="single"
          weekStartsOn={WEEK_STARTS_ON}
          selected={value}
          defaultMonth={value && value >= firstMonth ? value : undefined}
          startMonth={firstMonth}
          endMonth={lastMonth}
          captionLayout="dropdown"
          disabled={[{ before: today }, { after: lastMonth }]}
          onSelect={(date) => {
            onChange(date);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
