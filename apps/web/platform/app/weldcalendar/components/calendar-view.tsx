import React, { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { getTranslations } from '@/lib/i18n';
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  addDays,
  addMonths,
  subMonths,
  addWeeks,
  subWeeks,
  isSameMonth,
  isSameDay,
  isToday,
  startOfDay,
  endOfDay,
  differenceInMinutes,
  setHours,
  setMinutes,
  isTomorrow,
  isYesterday,
  isThisWeek,
} from 'date-fns';
import { ChevronLeft, ChevronRight, Plus, CalendarDays, CalendarIcon, CheckSquare, UserCheck, Clock, MapPin, Pencil, Trash2, X, MoreHorizontal, EllipsisVertical, Users, FileText, HardDrive, AlignLeft, Flag, CircleDot, Tag, Paperclip, Repeat2, ChevronDown, Search, ListFilter, Loader2, ListCollapse, Check, Pin, Sparkles, Copy, Settings } from 'lucide-react';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Calendar } from '@weldsuite/ui/components/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@weldsuite/ui/components/input-group';
import { Separator } from '@weldsuite/ui/components/separator';
import { Switch } from '@weldsuite/ui/components/switch';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { LocationAutocomplete } from './location-autocomplete';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { cn } from '@/lib/utils';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@weldsuite/ui/components/alert-dialog';
import {
  useCalendarEventsRange,
  useCreateCalendarEvent,
  useUpdateCalendarEvent,
  useDeleteCalendarEvent,
  useRescheduleCalendarEvent,
  useUnpinCalendarEvent,
  useUserCalendars,
  type CalendarEvent,
  type UserCalendar,
} from '@/hooks/queries/use-calendar-queries';
import { EVENT_TYPE_COLORS, EVENT_TYPE_OPTIONS, EVENT_PRIORITY_OPTIONS } from '../lib/event-form-schema';
import { EntityList, FilterPills, type HeaderColumn, type FilterConfig, type GroupConfig, type RowHandlers, type ActiveFilter } from '@/components/entity-list';
import { usePeople, type Person } from '@/components/objects/person/use-person-data';
import { useCreateTask } from '@/hooks/use-crm-tasks';
import { useWorkspaceMembers, useWorkingHours, type WorkingHours, type DayHours } from '@/hooks/queries/use-settings-queries';
import { EventDialog } from './event-dialog';
import { useEntitySheet } from '@/components/entity-sheet';
import { WeekDayHeader, TimeLabelColumn, TODAY_BLUE } from './calendar-shared';
import { getActiveCalendarIds } from './calendar-sidebar-section';
import { useSlotDrag } from '../hooks/use-slot-drag';
import { useAutoCreateWeldMeeting } from '@/hooks/use-auto-create-weld-meeting';
import { useUpdateMeeting } from '@/hooks/queries/use-weldmeet-queries';
import { EventNotificationDialog } from './event-notification-dialog';
import { useEventDrag } from '../hooks/use-event-drag';
import { useEventResize } from '../hooks/use-event-resize';
import { toast } from 'sonner';
import { getCalendarDateRange, type CalendarView as View } from '../lib/date-range';


const HOURS = Array.from({ length: 24 }, (_, i) => i);

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

const DEFAULT_WORKING_HOURS: WorkingHours = {
  monday: { isOpen: true, openTime: '09:00', closeTime: '17:00' },
  tuesday: { isOpen: true, openTime: '09:00', closeTime: '17:00' },
  wednesday: { isOpen: true, openTime: '09:00', closeTime: '17:00' },
  thursday: { isOpen: true, openTime: '09:00', closeTime: '17:00' },
  friday: { isOpen: true, openTime: '09:00', closeTime: '17:00' },
  saturday: { isOpen: false },
  sunday: { isOpen: false },
};

function isWorkingHour(day: Date, hour: number, workingHours: WorkingHours | null | undefined): boolean {
  const hours = workingHours || DEFAULT_WORKING_HOURS;
  const dayName = DAY_KEYS[day.getDay()];
  const dayConfig = hours[dayName] as DayHours | undefined;
  if (!dayConfig?.isOpen || !dayConfig.openTime || !dayConfig.closeTime) return false;
  const [openH] = dayConfig.openTime.split(':').map(Number);
  const [closeH, closeM] = dayConfig.closeTime.split(':').map(Number);
  return hour >= openH && hour < (closeM > 0 ? closeH + 1 : closeH);
}

function getEventColor(event: CalendarEvent, calendarColorMap: Record<string, string>): string {
  const calColor = event.calendarId ? calendarColorMap[event.calendarId] : undefined;
  return event.color || calColor || EVENT_TYPE_COLORS[event.type] || '#6b7280';
}

export function CalendarView() {
  const t = getTranslations('weldcalendar');

  const VIEW_OPTIONS: { label: string; value: View }[] = [
    { label: t.calendarView.viewDay, value: 'day' },
    { label: t.calendarView.viewFourDay, value: '4day' },
    { label: t.calendarView.viewWeek, value: 'week' },
    { label: t.calendarView.viewMonth, value: 'month' },
    { label: t.calendarView.viewYear, value: 'year' },
    { label: t.calendarView.viewSchedule, value: 'schedule' },
  ];

  // Mobile: only Day / Month / List, matching Apple Calendar on iPhone.
  // Week and 4-day are hidden because their grid is unreadable on a phone
  // (mobile already redirects them to the day-timeline view); Year drills
  // into month-level navigation so it's redundant.
  const MOBILE_VIEW_OPTIONS: { label: string; value: View }[] = [
    { label: t.calendarView.viewDay, value: 'day' },
    { label: t.calendarView.viewMonth, value: 'month' },
    { label: t.calendarView.viewList, value: 'schedule' },
  ];

  const [currentDate, setCurrentDate] = useState(new Date());

  // Mobile detection — synchronous initial value so the first paint already
  // matches the viewport (no flash of the desktop layout on real phones).
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' &&
    window.matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 767px)');
    const handler = () => setIsMobile(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  const [currentView, setCurrentViewState] = useState<View>(() => {
    const saved = localStorage.getItem('weldcalendar:view');
    return (saved && ['month', 'week', '4day', 'day', 'year', 'schedule'].includes(saved)) ? saved as View : 'month';
  });
  const setCurrentView = useCallback((view: View) => {
    setCurrentViewState(view);
    localStorage.setItem('weldcalendar:view', view);
  }, []);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [defaultStart, setDefaultStart] = useState<Date | undefined>();
  const [defaultEnd, setDefaultEnd] = useState<Date | undefined>();
  const [visibilityKey, setVisibilityKey] = useState(0);

  // Pin-on-drop confirm dialog state
  const [pinDialogOpen, setPinDialogOpen] = useState(false);
  const [pendingDrop, setPendingDrop] = useState<{
    event: CalendarEvent;
    newStart: Date;
    newEnd: Date;
  } | null>(null);

  const createTask = useCreateTask();
  const rescheduleEvent = useRescheduleCalendarEvent();
  const unpinEvent = useUnpinCalendarEvent();
  const { data: workingHoursData } = useWorkingHours();
  const navigate = useNavigate();
  const entitySheet = useEntitySheet();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const { data: calendarsData } = useUserCalendars();
  const allCalendars = calendarsData?.data || [];

  const calendarFilterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'type',
      label: t.calendarView.filterType,
      options: [
        { value: 'meeting', label: t.calendarView.filterTypeMeeting },
        { value: 'event', label: t.calendarView.filterTypeEvent },
        { value: 'call', label: t.calendarView.filterTypeCall },
        { value: 'appointment', label: t.calendarView.filterTypeAppointment },
        { value: 'reminder', label: t.calendarView.filterTypeReminder },
        { value: 'other', label: t.calendarView.filterTypeOther },
      ],
    },
    {
      field: 'calendar',
      label: t.calendarView.filterCalendar,
      options: allCalendars.map((c) => ({ value: c.id, label: c.name })),
    },
    {
      field: 'status',
      label: t.calendarView.filterStatus,
      options: [
        { value: 'confirmed', label: t.calendarView.filterStatusConfirmed },
        { value: 'tentative', label: t.calendarView.filterStatusTentative },
        { value: 'cancelled', label: t.calendarView.filterStatusCancelled },
      ],
    },
    {
      field: 'priority',
      label: t.calendarView.filterPriority,
      options: [
        { value: 'low', label: t.calendarView.filterPriorityLow },
        { value: 'normal', label: t.calendarView.filterPriorityNormal },
        { value: 'high', label: t.calendarView.filterPriorityHigh },
        { value: 'urgent', label: t.calendarView.filterPriorityUrgent },
      ],
    },
    {
      field: 'allDay',
      label: t.calendarView.filterAllDay,
      options: [
        { value: 'true', label: t.calendarView.filterAllDayYes },
        { value: 'false', label: t.calendarView.filterAllDayNo },
      ],
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [allCalendars]);

  // Listen for mini-calendar date navigation
  useEffect(() => {
    const handler = (e: Event) => {
      const date = new Date((e as CustomEvent).detail.date);
      setCurrentDate(date);
      setCurrentView('week');
    };
    window.addEventListener('weldcalendar:navigate-to-date', handler);
    return () => window.removeEventListener('weldcalendar:navigate-to-date', handler);
  }, []);

  // Sync mini calendar when main view date changes
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('weldcalendar:view-date-changed', { detail: { date: currentDate.toISOString() } }));
  }, [currentDate]);

  // Listen for sidebar visibility toggle
  useEffect(() => {
    const handler = () => setVisibilityKey((k) => k + 1);
    window.addEventListener('weldcalendar:visibility-changed', handler);
    return () => window.removeEventListener('weldcalendar:visibility-changed', handler);
  }, []);

  const activeCalendarIds = useMemo(
    () => getActiveCalendarIds(allCalendars),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allCalendars, visibilityKey],
  );
  const calendarIdsParam = activeCalendarIds.length > 0 ? activeCalendarIds.join(',') : undefined;
  const defaultCalendar = allCalendars.find((c) => c.isOwn && c.isDefault) || allCalendars.find((c) => c.isOwn);

  const dateRange = useMemo(() => getCalendarDateRange(currentDate, currentView), [currentDate, currentView]);
  const isTodayInView = useMemo(() => {
    const now = Date.now();
    return now >= new Date(dateRange.start).getTime() && now < new Date(dateRange.end).getTime();
  }, [dateRange]);
  const { data: eventsData } = useCalendarEventsRange(dateRange.start, dateRange.end, calendarIdsParam);
  const events = useMemo(() => eventsData?.data || [], [eventsData]);

  // Keep `selectedEvent` (the panel's data source) in sync with the refreshed
  // events list. Without this, inline edits in EventDetailPanel mutate the
  // server but the panel keeps rendering the stale snapshot taken at click
  // time — so the user sees no change and assumes the click didn't work.
  useEffect(() => {
    setSelectedEvent((prev) => {
      if (!prev?.id) return prev;
      const next = events.find((e) => e.id === prev.id);
      if (!next) return prev;
      // Cheap structural comparison — avoid re-setting state every render.
      return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
    });
  }, [events]);

  const filteredEvents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const base = activeFilters.length === 0
      ? events
      : events.filter((evt) => activeFilters.every((f) => {
          if (!f.value) return true;
          const isNot = f.operator === 'is_not';
          let match = false;
          switch (f.field) {
            case 'type':
              match = evt.type === f.value;
              break;
            case 'calendar':
              match = evt.calendarId === f.value;
              break;
            case 'status':
              match = evt.status === f.value;
              break;
            case 'priority':
              match = evt.priority === f.value;
              break;
            case 'allDay':
              match = String(evt.allDay || false) === f.value;
              break;
            default:
              return true;
          }
          return isNot ? !match : match;
        }));

    if (!q) return base;
    return base.filter((evt) => {
      // Match across the fields a user is most likely to remember.
      const haystacks: (string | undefined)[] = [
        evt.title,
        evt.description,
        evt.location,
        evt.meetingUrl,
        evt.notes,
        ...(evt.attendees?.flatMap((a) => [a.name, a.email]) ?? []),
        ...(evt.tags ?? []),
      ];
      return haystacks.some((s) => typeof s === 'string' && s.toLowerCase().includes(q));
    });
  }, [events, activeFilters, searchQuery]);

  const calendarColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const cal of allCalendars) {
      if (cal.color) map[cal.id] = cal.color;
    }
    return map;
  }, [allCalendars]);

  // Navigation
  const goToday = () => setCurrentDate(new Date());
  const goPrev = () => {
    if (currentView === 'schedule') setCurrentDate(addDays(currentDate, -30));
    else if (currentView === 'year') setCurrentDate(new Date(currentDate.getFullYear() - 1, currentDate.getMonth(), 1));
    else if (currentView === 'month') setCurrentDate(subMonths(currentDate, 1));
    else if (currentView === 'week') setCurrentDate(subWeeks(currentDate, 1));
    else if (currentView === '4day') setCurrentDate(addDays(currentDate, -4));
    else setCurrentDate(addDays(currentDate, -1));
  };
  const goNext = () => {
    if (currentView === 'schedule') setCurrentDate(addDays(currentDate, 30));
    else if (currentView === 'year') setCurrentDate(new Date(currentDate.getFullYear() + 1, currentDate.getMonth(), 1));
    else if (currentView === 'month') setCurrentDate(addMonths(currentDate, 1));
    else if (currentView === 'week') setCurrentDate(addWeeks(currentDate, 1));
    else if (currentView === '4day') setCurrentDate(addDays(currentDate, 4));
    else setCurrentDate(addDays(currentDate, 1));
  };

  // Quick-create inline card state
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  // While the user is dragging the preview event card to reschedule it, the
  // popover hides (so it doesn't follow / occlude). The TimeSlotPreview itself
  // stays visible because it's gated on `quickCreateOpen` only.
  const [isPreviewDragging, setIsPreviewDragging] = useState(false);
  // `cardBottomY` is the screen-coord bottom of the dragged event card (when
  // launched from a time-grid drag). It's used to flip the popover so its
  // bottom aligns with the card bottom when the natural top alignment would
  // overflow the viewport. `null` means no card to flip against.
  const [quickCreatePos, setQuickCreatePos] = useState<{ x: number; y: number; cardBottomY: number | null }>({ x: 0, y: 0, cardBottomY: null });
  const quickCreateRef = useRef<HTMLDivElement>(null);
  // Tracks whether the current mouse gesture (mousedown→mouseup) is the one
  // that closed an open popover. The same gesture's mouseup must NOT then
  // re-open the popover via onSelectSlot — the user has to click again.
  const dismissedByCurrentGestureRef = useRef(false);

  // Compute popover position relative to a given start/end time by reading the
  // matching [data-day-col]'s screen rect. Used both on initial open (cell
  // branch) and after a preview-drag completes.
  const computeQuickCreatePosFromDate = useCallback((s: Date, e: Date): { x: number; y: number; cardBottomY: number | null } => {
    const dateKey = format(s, 'yyyy-MM-dd');
    const dayCol = document.querySelector(`[data-day-col="${dateKey}"]`) as HTMLElement | null;
    const calBody = document.querySelector('[data-calendar-body]') as HTMLElement | null;
    const leftBound = calBody ? calBody.getBoundingClientRect().left + 4 : 4;
    if (!dayCol) {
      return {
        x: Math.max(leftBound, Math.round((window.innerWidth - 360) / 2)),
        y: 100,
        cardBottomY: null,
      };
    }
    const colRect = dayCol.getBoundingClientRect();
    const firstHourCell = dayCol.querySelector('[data-calendar-cell]') as HTMLElement | null;
    const hourHeight = firstHourCell ? firstHourCell.offsetHeight : 48;
    const startHour = s.getHours() + s.getMinutes() / 60;
    const endHour = e.getHours() + e.getMinutes() / 60;
    const y = colRect.top + startHour * hourHeight;
    const cardBottomY = colRect.top + endHour * hourHeight;
    let x = colRect.left - 364;
    if (x < leftBound) x = colRect.right + 4;
    if (x + 370 > window.innerWidth) x = Math.max(leftBound, window.innerWidth - 370);
    return { x, y, cardBottomY };
  }, []);
  const [defaultEventType, setDefaultEventType] = useState<string>('event');
  const handleCreateEvent = useCallback((start?: Date, end?: Date, type?: string, mouseEvent?: React.MouseEvent, wasDrag?: boolean) => {
    // If the same gesture just dismissed an open popover (mousedown closed it,
    // and now mouseup is firing onSelectSlot), don't re-open — UNLESS the
    // gesture was a drag-to-create-range, in which case we want to switch the
    // popover to the new range immediately (Google Calendar-like).
    if (dismissedByCurrentGestureRef.current) {
      dismissedByCurrentGestureRef.current = false;
      if (!wasDrag) return;
    }
    setSelectedEvent(null);
    const s = start || (() => { const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d; })();
    const e = end || new Date(s.getTime() + 60 * 60 * 1000);
    setDefaultStart(s);
    setDefaultEnd(e);
    setDefaultEventType(type || 'event');

    if (mouseEvent) {
      const cell = (mouseEvent.target as HTMLElement).closest('[data-calendar-cell]') as HTMLElement;
      const isMonthCell = cell && cell.hasAttribute('data-date');

      if (currentView === 'day') {
        // Day view: center on calendar area
        const calArea = document.querySelector('[data-calendar-body]') as HTMLElement;
        const toolbarEl = calArea?.parentElement;
        if (toolbarEl) {
          const rect = toolbarEl.getBoundingClientRect();
          setQuickCreatePos({
            x: Math.round(rect.left + (rect.width - 360) / 2),
            y: Math.round(rect.top + (rect.height - 400) / 2) - 60,
            cardBottomY: null,
          });
        } else {
          setQuickCreatePos({
            x: Math.round((window.innerWidth - 360) / 2),
            y: Math.round((window.innerHeight - 400) / 2),
            cardBottomY: null,
          });
        }
      } else if (isMonthCell) {
        // Month view: position next to the clicked cell
        const rect = cell.getBoundingClientRect();
        // Find last event button to align Y with where preview will appear
        const eventBtns = cell.querySelectorAll('button');
        const lastBtn = eventBtns.length > 0 ? eventBtns[eventBtns.length - 1] : null;
        let x = rect.left - 364;
        let y = lastBtn ? lastBtn.getBoundingClientRect().bottom + 2 : rect.top + 28;
        if (x < 0) x = rect.right + 4;
        if (x + 370 > window.innerWidth) x = Math.max(10, rect.left);
        if (y + 310 > window.innerHeight) y = Math.max(10, window.innerHeight - 320);
        setQuickCreatePos({ x, y, cardBottomY: null });
      } else if (cell) {
        // Week/4Day/Day views: position to the left of the clicked column, Y at the top
        // of the dragged event preview (derived from the start time inside the day
        // column). Using mouseEvent.clientY would put the popover at the drag-end
        // position, i.e. the bottom of the rendered card. The actual popover height
        // is measured in a layout effect below — if it would overflow the viewport,
        // it gets flipped so its bottom aligns with the card bottom (cardBottomY).
        const rect = cell.getBoundingClientRect();
        const dateKey = format(s, 'yyyy-MM-dd');
        const dayCol = document.querySelector(`[data-day-col="${dateKey}"]`) as HTMLElement | null;
        const calBody = document.querySelector('[data-calendar-body]') as HTMLElement | null;
        // Left bound = the calendar grid's left edge, NOT viewport 0. Otherwise the
        // popover slides over the sidebar when the event is in a leftmost column.
        const leftBound = calBody ? calBody.getBoundingClientRect().left + 4 : 4;
        let y = mouseEvent.clientY;
        let cardBottomY: number | null = null;
        // Prefer the day-column rect over the (sometimes-stale) hover-cell rect
        // for X math — that way the popover anchors to the actual start column.
        let colLeft = rect.left;
        let colRight = rect.right;
        if (dayCol) {
          const colRect = dayCol.getBoundingClientRect();
          colLeft = colRect.left;
          colRight = colRect.right;
          const firstHourCell = dayCol.querySelector('[data-calendar-cell]') as HTMLElement | null;
          const hourHeight = firstHourCell ? firstHourCell.offsetHeight : 48;
          const startHour = s.getHours() + s.getMinutes() / 60;
          const endHour = e.getHours() + e.getMinutes() / 60;
          y = colRect.top + startHour * hourHeight;
          cardBottomY = colRect.top + endHour * hourHeight;
        }
        // Default: popover sits to the LEFT of the column. If that pushes it past
        // the calendar's left edge (e.g. leftmost column with sidebar visible),
        // flip and place it to the RIGHT of the column instead.
        let x = colLeft - 364;
        if (x < leftBound) x = colRight + 4;
        if (x + 370 > window.innerWidth) x = Math.max(leftBound, window.innerWidth - 370);
        setQuickCreatePos({ x, y, cardBottomY });
      }
    } else {
      // From toolbar button — mirror the drag-to-schedule positioning so the
      // popover anchors to the same spot as if the user had dragged to create.
      const dateKey = format(s, 'yyyy-MM-dd');
      const dayCol = document.querySelector(`[data-day-col="${dateKey}"]`) as HTMLElement | null;
      const monthCell = document.querySelector(`[data-date="${dateKey}"]`) as HTMLElement | null;
      const calBody = document.querySelector('[data-calendar-body]') as HTMLElement | null;
      const leftBound = calBody ? calBody.getBoundingClientRect().left + 4 : 4;

      if (dayCol) {
        // Week / Day / 4Day views — position next to the day column at the
        // start hour, same as the drag branch above.
        const colRect = dayCol.getBoundingClientRect();
        const firstHourCell = dayCol.querySelector('[data-calendar-cell]') as HTMLElement | null;
        const hourHeight = firstHourCell ? firstHourCell.offsetHeight : 48;
        const startHour = s.getHours() + s.getMinutes() / 60;
        const endHour = e.getHours() + e.getMinutes() / 60;
        const y = colRect.top + startHour * hourHeight;
        const cardBottomY = colRect.top + endHour * hourHeight;
        let x = colRect.left - 364;
        if (x < leftBound) x = colRect.right + 4;
        if (x + 370 > window.innerWidth) x = Math.max(leftBound, window.innerWidth - 370);
        setQuickCreatePos({ x, y, cardBottomY });
      } else if (monthCell) {
        const rect = monthCell.getBoundingClientRect();
        let x = rect.left - 364;
        let y = rect.top + 28;
        if (x < 0) x = rect.right + 4;
        if (x + 370 > window.innerWidth) x = Math.max(10, rect.left);
        if (y + 310 > window.innerHeight) y = Math.max(10, window.innerHeight - 320);
        setQuickCreatePos({ x, y, cardBottomY: null });
      } else {
        const toolbarEl = calBody?.parentElement;
        if (toolbarEl) {
          const rect = toolbarEl.getBoundingClientRect();
          setQuickCreatePos({
            x: Math.round(rect.left + (rect.width - 360) / 2),
            y: Math.round(rect.top + (rect.height - 400) / 2),
            cardBottomY: null,
          });
        } else {
          setQuickCreatePos({
            x: Math.round((window.innerWidth - 360) / 2),
            y: Math.round((window.innerHeight - 400) / 2),
            cardBottomY: null,
          });
        }
      }
    }
    setQuickCreateOpen(true);
  }, [currentView]);

  // Drag the unsaved preview card to reschedule. While dragging, the popover
  // hides; on release, defaultStart/defaultEnd are updated and the popover
  // reappears anchored to the new time.
  const handlePreviewMouseDown = useCallback((e: React.MouseEvent) => {
    if (!defaultStart || !defaultEnd) return;
    e.preventDefault();
    e.stopPropagation();
    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const origStart = defaultStart;
    const origEnd = defaultEnd;
    const durationMs = origEnd.getTime() - origStart.getTime();
    let dragging = false;
    let latestStart = origStart;
    let latestEnd = origEnd;

    // Capture the click offset within the card so the grab-point stays under
    // the cursor as it moves (matches the use-event-drag.ts pattern).
    const origDateKey = format(origStart, 'yyyy-MM-dd');
    const origCol = document.querySelector(`[data-day-col="${origDateKey}"]`) as HTMLElement | null;
    const origColRect = origCol?.getBoundingClientRect();
    const origFirstCell = origCol?.querySelector('[data-calendar-cell]') as HTMLElement | null;
    const origHourHeight = origFirstCell ? origFirstCell.offsetHeight : 48;
    const origStartTopPx = (origStart.getHours() + origStart.getMinutes() / 60) * origHourHeight;
    const grabOffsetPx = origColRect ? startMouseY - (origColRect.top + origStartTopPx) : 0;

    const onMove = (me: MouseEvent) => {
      const dx = me.clientX - startMouseX;
      const dy = me.clientY - startMouseY;
      if (!dragging) {
        if (Math.abs(dx) + Math.abs(dy) < 5) return;
        dragging = true;
        setIsPreviewDragging(true);
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
      }
      const el = document.elementFromPoint(me.clientX, me.clientY);
      const col = el?.closest('[data-day-col]') as HTMLElement | null;
      if (!col) return;
      const dayKey = col.dataset.dayCol;
      if (!dayKey) return;
      const colRect = col.getBoundingClientRect();
      const firstCell = col.querySelector('[data-calendar-cell]') as HTMLElement | null;
      const hh = firstCell ? firstCell.offsetHeight : 48;
      const newTopPx = me.clientY - colRect.top - grabOffsetPx;
      const clampedTop = Math.max(0, Math.min(newTopPx, 24 * hh - 12));
      const snappedTop = Math.round(clampedTop / (hh / 4)) * (hh / 4);
      const hours = Math.floor(snappedTop / hh);
      const minutes = Math.round(((snappedTop % hh) / hh) * 60 / 15) * 15;
      const newStart = new Date(dayKey + 'T00:00:00');
      newStart.setHours(hours, minutes, 0, 0);
      const newEnd = new Date(newStart.getTime() + durationMs);
      latestStart = newStart;
      latestEnd = newEnd;
      setDefaultStart(newStart);
      setDefaultEnd(newEnd);
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (!dragging) return;
      // Wait one frame so the moved TimeSlotPreview is in the DOM before we
      // measure the new column rect for popover placement.
      requestAnimationFrame(() => {
        const pos = computeQuickCreatePosFromDate(latestStart, latestEnd);
        setQuickCreatePos(pos);
        setIsPreviewDragging(false);
      });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [defaultStart, defaultEnd, computeQuickCreatePosFromDate]);

  // Resize the unsaved preview card from the top or bottom edge to adjust the
  // start or end time. Snaps to 15-minute increments. While resizing the
  // popover stays hidden; on release it reattaches to the new range.
  const handlePreviewResize = useCallback((edge: 'top' | 'bottom', e: React.MouseEvent) => {
    if (!defaultStart || !defaultEnd) return;
    e.preventDefault();
    e.stopPropagation();
    const origStart = defaultStart;
    const origEnd = defaultEnd;
    let resizing = false;
    let latestStart = origStart;
    let latestEnd = origEnd;

    const dateKey = format(origStart, 'yyyy-MM-dd');
    const col = document.querySelector(`[data-day-col="${dateKey}"]`) as HTMLElement | null;
    if (!col) return;
    const colRect = col.getBoundingClientRect();
    const firstCell = col.querySelector('[data-calendar-cell]') as HTMLElement | null;
    const hh = firstCell ? firstCell.offsetHeight : 48;

    const minDurationMs = 15 * 60 * 1000;
    const startMouseY = e.clientY;

    const onMove = (me: MouseEvent) => {
      if (!resizing) {
        if (Math.abs(me.clientY - startMouseY) < 3) return;
        resizing = true;
        setIsPreviewDragging(true);
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
      }
      const localY = me.clientY - colRect.top;
      const clamped = Math.max(0, Math.min(localY, 24 * hh));
      const snapped = Math.round(clamped / (hh / 4)) * (hh / 4);
      const hours = Math.floor(snapped / hh);
      const minutes = Math.round(((snapped % hh) / hh) * 60 / 15) * 15;
      const next = new Date(dateKey + 'T00:00:00');
      next.setHours(hours, minutes, 0, 0);

      if (edge === 'top') {
        const cap = new Date(origEnd.getTime() - minDurationMs);
        const newStart = next.getTime() > cap.getTime() ? cap : next;
        latestStart = newStart;
        latestEnd = origEnd;
      } else {
        const floor = new Date(origStart.getTime() + minDurationMs);
        const newEnd = next.getTime() < floor.getTime() ? floor : next;
        latestStart = origStart;
        latestEnd = newEnd;
      }
      setDefaultStart(latestStart);
      setDefaultEnd(latestEnd);
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (!resizing) return;
      requestAnimationFrame(() => {
        const pos = computeQuickCreatePosFromDate(latestStart, latestEnd);
        setQuickCreatePos(pos);
        setIsPreviewDragging(false);
      });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [defaultStart, defaultEnd, computeQuickCreatePosFromDate]);

  // Close the popover on outside mousedown. The TimeSlotPreview inside the
  // calendar must remain interactive (so it can be dragged), so we use a
  // document-level listener instead of a backdrop overlay — the preview's
  // own mousedown handler stops propagation, so it won't trigger close.
  // When the dismissal happens, mark the gesture so the upcoming mouseup
  // (which may fire onSelectSlot for the same cell) doesn't re-open.
  useEffect(() => {
    if (!quickCreateOpen) return;
    const handleMouseDown = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (target && quickCreateRef.current?.contains(target)) return;
      dismissedByCurrentGestureRef.current = true;
      setQuickCreateOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [quickCreateOpen]);

  // Clear the dismissal flag once the gesture ends — but only AFTER any
  // mouseup-driven onSelectSlot has had a chance to short-circuit. Using a
  // 0-delay setTimeout pushes the reset to the end of the current task,
  // which is after React has flushed the click → onSelectSlot path.
  useEffect(() => {
    const handleMouseUp = () => {
      if (!dismissedByCurrentGestureRef.current) return;
      setTimeout(() => { dismissedByCurrentGestureRef.current = false; }, 0);
    };
    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, []);

  // After the popover renders, measure its actual height. If the natural top
  // alignment would overflow the viewport bottom, flip it so its bottom aligns
  // with the bottom of the dragged event card (cardBottomY). Falls back to a
  // viewport-edge clamp when there's no card to anchor against.
  useLayoutEffect(() => {
    if (!quickCreateOpen || isPreviewDragging) return;
    const el = quickCreateRef.current;
    if (!el) return;
    const popoverHeight = el.offsetHeight;
    const viewportHeight = window.innerHeight;
    if (quickCreatePos.y + popoverHeight <= viewportHeight - 8) return;
    const newY = quickCreatePos.cardBottomY != null
      ? Math.max(10, quickCreatePos.cardBottomY - popoverHeight)
      : Math.max(10, viewportHeight - popoverHeight - 8);
    if (newY !== quickCreatePos.y) {
      setQuickCreatePos((p) => ({ ...p, y: newY }));
    }
  }, [quickCreateOpen, isPreviewDragging, quickCreatePos.y, quickCreatePos.cardBottomY]);

  const handleOpenFullDialog = useCallback(() => {
    setQuickCreateOpen(false);
    setDialogOpen(true);
  }, []);

  const handleEventDrop = useCallback((event: CalendarEvent, newStart: Date, newEnd: Date) => {
    if (!event.id) return;

    // For auto-scheduled task/activity events: show confirm dialog before pinning
    const isAutoScheduledEntity =
      (event.sourceType === 'task' || event.sourceType === 'activity') &&
      event.autoScheduled === true;

    if (isAutoScheduledEntity) {
      setPendingDrop({ event, newStart, newEnd });
      setPinDialogOpen(true);
      return;
    }

    // For all other events: instant reschedule (no dialog)
    rescheduleEvent.mutate({
      id: event.id,
      startTime: newStart.toISOString(),
      endTime: newEnd.toISOString(),
    });
  }, [rescheduleEvent]);

  /** Called when the user confirms "Pin to this time" in the dialog */
  const handleConfirmPin = useCallback(() => {
    if (!pendingDrop?.event.id) return;
    const { event, newStart, newEnd } = pendingDrop;
    rescheduleEvent.mutate(
      {
        id: event.id!,
        startTime: newStart.toISOString(),
        endTime: newEnd.toISOString(),
        manual: true,
      },
      {
        onSuccess: () => {
          const timeLabel = newStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          toast.success(t.toast.pinnedTo.replace('{time}', timeLabel), {
            action: {
              label: t.toast.undo,
              onClick: () => {
                if (event.id) unpinEvent.mutate(event.id);
              },
            },
          });
        },
      },
    );
    setPinDialogOpen(false);
    setPendingDrop(null);
  }, [pendingDrop, rescheduleEvent, unpinEvent]);

  /** Called when the user cancels the pin dialog — revert the optimistic position via query invalidation */
  const handleCancelPin = useCallback(() => {
    setPinDialogOpen(false);
    setPendingDrop(null);
  }, []);

  const [eventPreviewOpen, setEventPreviewOpen] = useState(false);
  const [eventPreviewEditing, setEventPreviewEditing] = useState(false);
  const EVENT_PANEL_WIDTH = 480;

  // Notify the calendar layout to shrink content while the event panel is open,
  // mirroring how TaskDetailPanel announces itself. The layout listens for
  // 'task-detail-panel' to allocate horizontal space — sharing the same event
  // is fine since only one slide-in panel is ever open at a time.
  useLayoutEffect(() => {
    window.dispatchEvent(new CustomEvent('task-detail-panel', {
      detail: { isOpen: eventPreviewOpen, width: eventPreviewOpen ? EVENT_PANEL_WIDTH : 0 },
    }));
    return () => {
      window.dispatchEvent(new CustomEvent('task-detail-panel', {
        detail: { isOpen: false, width: 0 },
      }));
    };
  }, [eventPreviewOpen]);

  const handleSelectEvent = useCallback((event: CalendarEvent, mouseEvent?: React.MouseEvent) => {
    // Task-backed events open the standard task detail panel (same one used in
    // my-tasks, project boards, customer detail, etc.) so behavior matches
    // every other surface where tasks appear.
    if (event.sourceType === 'task' && event.sourceId) {
      setEventPreviewOpen(false);
      setEventPreviewEditing(false);
      setQuickCreateOpen(false);
      setSelectedEvent(null);
      entitySheet.open('task', event.sourceId);
      return;
    }

    setSelectedEvent(event);
    setDefaultStart(undefined);
    setDefaultEnd(undefined);
    setQuickCreateOpen(false);
    setEventPreviewEditing(false);
    setEventPreviewOpen(true);
  }, [entitySheet]);

  // Escape key to close cards
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (quickCreateOpen) setQuickCreateOpen(false);
        if (eventPreviewOpen) { setEventPreviewOpen(false); setEventPreviewEditing(false); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [quickCreateOpen, eventPreviewOpen]);

  // Listen for create-event from sidebar/header
  useEffect(() => {
    const handler = () => handleCreateEvent();
    window.addEventListener('weldcalendar:create-event', handler);
    return () => window.removeEventListener('weldcalendar:create-event', handler);
  }, [handleCreateEvent]);

  // Listen for navigate to new booking page
  useEffect(() => {
    const handler = () => navigate({ to: '/weldcalendar/scheduling/new' });
    window.addEventListener('weldcalendar:navigate-to-booking-new', handler);
    return () => window.removeEventListener('weldcalendar:navigate-to-booking-new', handler);
  }, [navigate]);

  // Header label
  const headerLabel = useMemo(() => {
    switch (currentView) {
      case 'month': return format(currentDate, 'MMMM yyyy');
      case 'week': {
        // When the visible week spans two months, show "Apr – May 2026" so the
        // user still sees the boundary; otherwise just "May 2026".
        const ws = startOfWeek(currentDate, { weekStartsOn: 1 });
        const we = addDays(ws, 6);
        if (ws.getMonth() === we.getMonth() && ws.getFullYear() === we.getFullYear()) {
          return format(ws, 'MMMM yyyy');
        }
        const yearLabel = ws.getFullYear() === we.getFullYear()
          ? format(we, 'yyyy')
          : `${format(ws, 'yyyy')} – ${format(we, 'yyyy')}`;
        return `${format(ws, 'MMM')} – ${format(we, 'MMM')} ${yearLabel}`;
      }
      case '4day': {
        const end = addDays(currentDate, 3);
        if (currentDate.getMonth() === end.getMonth() && currentDate.getFullYear() === end.getFullYear()) {
          return format(currentDate, 'MMMM yyyy');
        }
        const yearLabel = currentDate.getFullYear() === end.getFullYear()
          ? format(end, 'yyyy')
          : `${format(currentDate, 'yyyy')} – ${format(end, 'yyyy')}`;
        return `${format(currentDate, 'MMM')} – ${format(end, 'MMM')} ${yearLabel}`;
      }
      case 'day': return format(currentDate, 'MMMM yyyy');
      case 'year': return format(currentDate, 'yyyy');
      case 'schedule': {
        const end = addDays(currentDate, 60);
        if (currentDate.getMonth() === end.getMonth() && currentDate.getFullYear() === end.getFullYear()) {
          return format(currentDate, 'MMMM yyyy');
        }
        const yearLabel = currentDate.getFullYear() === end.getFullYear()
          ? format(end, 'yyyy')
          : `${format(currentDate, 'yyyy')} – ${format(end, 'yyyy')}`;
        return `${format(currentDate, 'MMM')} – ${format(end, 'MMM')} ${yearLabel}`;
      }
    }
  }, [currentDate, currentView]);

  // Color the inline quick-create preview renders with. Mirrors the priority
  // used by `getEventColor` on saved events so the preview matches the
  // eventual stored event's color and doesn't flicker on save.
  const selectedPreviewColor = quickCreateOpen
    ? (defaultCalendar?.color || EVENT_TYPE_COLORS[defaultEventType] || '#3b82f6')
    : undefined;

  return (
    <div className="flex-1 min-h-0 flex flex-col [--cal-time-label-width:60px] md:[--cal-time-label-width:72px]">
      {/* Toolbar */}
      <div className="flex items-center justify-between max-md:gap-2 border-b px-4 py-2.5 bg-background shrink-0 z-10">
        <div className="flex items-center gap-1 md:gap-2 max-md:min-w-0">
          <FilterPills
            filters={activeFilters}
            filterConfigs={calendarFilterConfigs}
            maxFilters={3}
            onFiltersChange={setActiveFilters}
          />
          <Button variant="ghost" size="icon" className="hidden md:inline-flex h-8 w-8" onClick={goPrev}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="hidden md:inline-flex h-8 w-8" onClick={goNext}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <h2 className="hidden md:block text-[18px] font-semibold ml-1 -translate-y-[1px]">{headerLabel}</h2>
        </div>

        <div className="flex items-center gap-1 md:gap-2 max-md:shrink-0">
          {!isTodayInView && (
            <Button variant="outline" size="sm" className="shadow-none shrink-0" onClick={goToday}>
              {t.calendarView.today}
            </Button>
          )}
          {/* Search — collapsed icon-only on mobile; expanding input on md+. */}
          <div className="relative flex items-center">
            <div className={cn(
              "flex items-center transition-all duration-200 ease-out",
              searchOpen ? "w-36 md:w-48" : "w-8"
            )}>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-8 w-8 p-0 flex-shrink-0 shadow-none transition-opacity duration-200",
                  searchOpen && "opacity-0 pointer-events-none absolute"
                )}
                onClick={() => setSearchOpen(true)}
              >
                <Search className="h-4 w-4" />
              </Button>
              <div className={cn(
                "relative transition-all duration-200 ease-out",
                searchOpen ? "opacity-100 w-36 md:w-48" : "opacity-0 w-0 pointer-events-none"
              )}>
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder={t.calendarView.searchPlaceholder}
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
          <Select
            value={
              // On mobile, fold week/4day/year onto the closest of the 3
              // mobile options so the Select always shows a matching entry.
              isMobile
                ? (currentView === 'week' || currentView === '4day' || currentView === 'day'
                    ? 'day'
                    : currentView === 'year'
                    ? 'month'
                    : currentView)
                : currentView
            }
            onValueChange={(v) => setCurrentView(v as View)}
          >
            <SelectTrigger size="sm" className="w-[110px] md:w-[130px] shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(isMobile ? MOBILE_VIEW_OPTIONS : VIEW_OPTIONS).map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="shadow-none max-md:h-8 max-md:px-2.5"
            onClick={() => handleCreateEvent(undefined, undefined, 'event')}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t.calendarView.newEvent}
          </Button>
        </div>
      </div>

      {/* Calendar Body */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden" data-calendar-body>
        {currentView === 'month' && (
          isMobile ? (
            <MobileMonthView
              currentDate={currentDate}
              events={filteredEvents}
              calendarColorMap={calendarColorMap}
              onSelectEvent={handleSelectEvent}
              onSelectDay={setCurrentDate}
            />
          ) : (
            <MonthView
              currentDate={currentDate}
              events={filteredEvents}
              calendarColorMap={calendarColorMap}
              onSelectEvent={handleSelectEvent}
              selectedEventId={eventPreviewOpen ? selectedEvent?.id : undefined}
              onSelectSlot={(start, end, e, wasDrag) => {
                handleCreateEvent(start, end, undefined, e as React.MouseEvent, wasDrag);
              }}
              selectedDate={quickCreateOpen ? defaultStart : undefined}
              selectedEndDate={quickCreateOpen ? defaultEnd : undefined}
              selectedType={quickCreateOpen ? defaultEventType : undefined}
              selectedColor={selectedPreviewColor}
              onEventDrop={handleEventDrop}
            />
          )
        )}
        {(currentView === 'week' || (isMobile && currentView === '4day')) && (
          isMobile ? (
            <MobileWeekTimelineView
              currentDate={currentDate}
              events={filteredEvents}
              calendarColorMap={calendarColorMap}
              onSelectEvent={handleSelectEvent}
              onSelectDay={setCurrentDate}
              onSelectSlot={(start, end, e, wasDrag) => handleCreateEvent(start, end, undefined, e as React.MouseEvent, wasDrag)}
              selectedDate={quickCreateOpen ? defaultStart : undefined}
              selectedEndDate={quickCreateOpen ? defaultEnd : undefined}
              selectedType={quickCreateOpen ? defaultEventType : undefined}
              selectedColor={selectedPreviewColor}
              onEventDrop={handleEventDrop}
              workingHours={workingHoursData}
              onPreviewMouseDown={handlePreviewMouseDown}
              onPreviewResize={handlePreviewResize}
            />
          ) : (
            <WeekView
              currentDate={currentDate}
              events={filteredEvents}
              calendarColorMap={calendarColorMap}
              onSelectEvent={handleSelectEvent}
              onSelectSlot={(start, end, e, wasDrag) => handleCreateEvent(start, end, undefined, e as React.MouseEvent, wasDrag)}
              selectedDate={quickCreateOpen ? defaultStart : undefined}
              selectedEndDate={quickCreateOpen ? defaultEnd : undefined}
              selectedType={quickCreateOpen ? defaultEventType : undefined}
              selectedColor={selectedPreviewColor}
              onEventDrop={handleEventDrop}
              workingHours={workingHoursData}
              onPreviewMouseDown={handlePreviewMouseDown}
              onPreviewResize={handlePreviewResize}
            />
          )
        )}
        {currentView === '4day' && !isMobile && (
          <FourDayView
            currentDate={currentDate}
            events={filteredEvents}
            calendarColorMap={calendarColorMap}
            onSelectEvent={handleSelectEvent}
            onSelectSlot={(start, end, e, wasDrag) => handleCreateEvent(start, end, undefined, e as React.MouseEvent, wasDrag)}
            selectedDate={quickCreateOpen ? defaultStart : undefined}
            selectedEndDate={quickCreateOpen ? defaultEnd : undefined}
            selectedType={quickCreateOpen ? defaultEventType : undefined}
            selectedColor={selectedPreviewColor}
            onEventDrop={handleEventDrop}
            workingHours={workingHoursData}
            onPreviewMouseDown={handlePreviewMouseDown}
            onPreviewResize={handlePreviewResize}
          />
        )}
        {currentView === 'day' && (
          isMobile ? (
            <MobileWeekTimelineView
              currentDate={currentDate}
              events={filteredEvents}
              calendarColorMap={calendarColorMap}
              onSelectEvent={handleSelectEvent}
              onSelectDay={setCurrentDate}
              onSelectSlot={(start, end, e, wasDrag) => handleCreateEvent(start, end, undefined, e as React.MouseEvent, wasDrag)}
              selectedDate={quickCreateOpen ? defaultStart : undefined}
              selectedEndDate={quickCreateOpen ? defaultEnd : undefined}
              selectedType={quickCreateOpen ? defaultEventType : undefined}
              selectedColor={selectedPreviewColor}
              onEventDrop={handleEventDrop}
              workingHours={workingHoursData}
              onPreviewMouseDown={handlePreviewMouseDown}
              onPreviewResize={handlePreviewResize}
            />
          ) : (
            <DayView
              currentDate={currentDate}
              events={filteredEvents}
              calendarColorMap={calendarColorMap}
              onSelectEvent={handleSelectEvent}
              onSelectSlot={(start, end, e, wasDrag) => handleCreateEvent(start, end, undefined, e as React.MouseEvent, wasDrag)}
              selectedDate={quickCreateOpen ? defaultStart : undefined}
              selectedEndDate={quickCreateOpen ? defaultEnd : undefined}
              selectedType={quickCreateOpen ? defaultEventType : undefined}
              selectedColor={selectedPreviewColor}
              onEventDrop={handleEventDrop}
              workingHours={workingHoursData}
              onPreviewMouseDown={handlePreviewMouseDown}
              onPreviewResize={handlePreviewResize}
            />
          )
        )}
        {currentView === 'year' && (
          <YearView
            currentDate={currentDate}
            events={filteredEvents}
            onDateClick={(date) => { setCurrentDate(date); setCurrentView('day'); }}
          />
        )}
        {currentView === 'schedule' && (
          <ScheduleView
            currentDate={currentDate}
            events={filteredEvents}
            calendarColorMap={calendarColorMap}
            onSelectEvent={handleSelectEvent}
          />
        )}
      </div>

      {/* Inline quick-create card — rendered as fixed overlay so it's never clipped.
          We deliberately don't render a backdrop overlay so the TimeSlotPreview
          underneath stays interactive (drag-to-reschedule). Outside-click close
          is handled by a document-level mousedown listener above. The card
          itself is hidden during preview drag so it doesn't follow / occlude. */}
      {quickCreateOpen && !isPreviewDragging && (
        <>
          <div
            ref={quickCreateRef}
            className="fixed z-[70] w-[360px] bg-popover border rounded-xl shadow-lg animate-in fade-in-0 zoom-in-95"
            style={{ top: quickCreatePos.y, left: quickCreatePos.x }}
          >
            <QuickCreateCard
              defaultType={defaultEventType}
              defaultStart={defaultStart}
              defaultEnd={defaultEnd}
              calendars={allCalendars}
              defaultCalendarId={defaultCalendar?.id}
              onClose={() => setQuickCreateOpen(false)}
              onMoreOptions={handleOpenFullDialog}
            />
          </div>
        </>
      )}

      {/* Event detail panel — slide-in matching TaskDetailPanel design */}
      <EventDetailPanel
        event={selectedEvent}
        isOpen={eventPreviewOpen}
        calendars={allCalendars}
        calendarColorMap={calendarColorMap}
        width={EVENT_PANEL_WIDTH}
        onClose={() => { setEventPreviewOpen(false); setEventPreviewEditing(false); }}
        onEdit={() => {
          setEventPreviewOpen(false);
          setEventPreviewEditing(false);
          setDialogOpen(true);
        }}
      />

      <EventDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        event={selectedEvent}
        defaultStart={defaultStart}
        defaultEnd={defaultEnd}
        defaultType={defaultEventType}
        calendars={allCalendars}
        defaultCalendarId={defaultCalendar?.id}
      />

      {/* Pin-on-drag confirmation dialog */}
      <AlertDialog open={pinDialogOpen} onOpenChange={(open) => { if (!open) handleCancelPin(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.pinDialog.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.pinDialog.body}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelPin}>{t.pinDialog.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmPin}>{t.pinDialog.confirm}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}

// ============================================================================
// Quick Create Card (Google Calendar-style inline creation)
// ============================================================================

function formatDateTimeLocal(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function QuickCreateCard({
  defaultType,
  defaultStart,
  defaultEnd,
  defaultTitle,
  defaultDescription,
  defaultLocation,
  calendars,
  defaultCalendarId,
  onClose,
  onMoreOptions,
  showTypeTabs = true,
  editEvent,
}: {
  defaultType: string;
  defaultStart?: Date;
  defaultEnd?: Date;
  /** Pre-fill the title input when creating a new event. */
  defaultTitle?: string;
  /** Pre-fill the description field when creating a new event. */
  defaultDescription?: string;
  /** Pre-fill the location field when creating a new event. */
  defaultLocation?: string;
  calendars: any[];
  defaultCalendarId?: string;
  onClose: () => void;
  showTypeTabs?: boolean;
  onMoreOptions: () => void;
  editEvent?: CalendarEvent | null;
}) {
  const t = getTranslations('weldcalendar');
  const [type, setType] = useState(editEvent?.type || defaultType);
  const [title, setTitle] = useState(editEvent?.title || defaultTitle || '');
  const [allDay, setAllDay] = useState(editEvent?.allDay || false);
  const [startDate, setStartDate] = useState(() => {
    const d = defaultStart || new Date();
    return format(d, 'yyyy-MM-dd');
  });
  const [endDate, setEndDate] = useState(() => {
    const d = defaultEnd || defaultStart || new Date();
    return format(d, 'yyyy-MM-dd');
  });
  const [startTimeVal, setStartTimeVal] = useState(() => {
    if (defaultStart) return format(defaultStart, 'HH:mm');
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return format(d, 'HH:mm');
  });
  const [endTimeVal, setEndTimeVal] = useState(() => {
    if (defaultEnd) return format(defaultEnd, 'HH:mm');
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 2);
    return format(d, 'HH:mm');
  });

  const [location, setLocation] = useState(editEvent?.location || defaultLocation || '');
  const [description, setDescription] = useState(editEvent?.description || defaultDescription || '');
  const [meetingUrl, setMeetingUrl] = useState(editEvent?.meetingUrl || '');
  // Id + settings of the WeldMeet meeting created from this form, so the
  // hover actions (copy link / adjust settings) on the meeting row can act on it.
  const [meetingId, setMeetingId] = useState('');
  const [meetingLinkCopied, setMeetingLinkCopied] = useState(false);
  const [meetingSettings, setMeetingSettings] = useState<{
    accessType: 'workspace' | 'invited_only' | 'anyone_with_link';
    waitingRoom: boolean;
    allowRecording: boolean;
  }>({ accessType: 'anyone_with_link', waitingRoom: true, allowRecording: false });
  const [guestSearch, setGuestSearch] = useState('');
  const [selectedGuests, setSelectedGuests] = useState<{ id: string; name: string; email: string }[]>(() => {
    if (editEvent?.attendees?.length) {
      return editEvent.attendees.map((a, i) => ({
        id: `attendee-${i}`,
        name: a.name || a.email,
        email: a.email,
      }));
    }
    return [];
  });
  const [activeField, setActiveField] = useState<'guests' | 'meeting' | 'location' | 'description' | 'time' | 'assignee' | null>(null);

  // Auto-grow the description textarea from a single line instead of snapping
  // to a fixed 2-row height — keeps the row height (and the text position)
  // identical across the placeholder, editing, and preview states.
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = descriptionRef.current;
    if (el && activeField === 'description') {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [description, activeField]);

  // Task-specific state
  const [taskStatus, setTaskStatus] = useState<'todo' | 'in_progress' | 'done'>('todo');
  const [taskPriority, setTaskPriority] = useState<'low' | 'medium' | 'high' | null>(null);
  const [taskDueDate, setTaskDueDate] = useState<Date | undefined>(() => defaultStart || undefined);
  const [taskDueTime, setTaskDueTime] = useState(() => {
    if (defaultStart) return format(defaultStart, 'HH:mm');
    return '';
  });
  const [taskLabels, setTaskLabels] = useState<string[]>([]);
  const [taskAssigneeSearch, setTaskAssigneeSearch] = useState('');
  const [taskAssignees, setTaskAssignees] = useState<{ id: string; name: string; email: string }[]>([]);
  const [taskRepeat, setTaskRepeat] = useState<string | null>(null);

  const createEvent = useCreateCalendarEvent();
  const updateEvent = useUpdateCalendarEvent();
  const createTask = useCreateTask();
  const { createMeetingAndGetUrl, isPending: isCreatingMeeting } = useAutoCreateWeldMeeting();
  const updateMeeting = useUpdateMeeting();

  const handleCopyMeetingLink = useCallback(async () => {
    if (!meetingUrl) return;
    try {
      await navigator.clipboard.writeText(meetingUrl);
      setMeetingLinkCopied(true);
      toast.success(t.quickCreate.meetingLinkCopied);
      window.setTimeout(() => setMeetingLinkCopied(false), 1500);
    } catch {
      // Clipboard blocked (e.g. insecure context) — surface a minimal hint.
      toast.error(t.quickCreate.meetingLinkCopied);
    }
  }, [meetingUrl, t.quickCreate.meetingLinkCopied]);

  const updateMeetingSetting = useCallback(
    (patch: Partial<typeof meetingSettings>) => {
      setMeetingSettings((prev) => {
        const next = { ...prev, ...patch };
        if (meetingId) {
          updateMeeting.mutate({ id: meetingId, data: patch });
        }
        return next;
      });
    },
    [meetingId, updateMeeting],
  );

  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [pendingEventData, setPendingEventData] = useState<any>(null);
  const [selectedCalendarId, setSelectedCalendarId] = useState(editEvent?.calendarId || defaultCalendarId);
  const isEditMode = !!editEvent?.id;
  const isTask = type === 'reminder';

  const defaultTitles: Record<string, string> = {
    event: t.quickCreate.defaultTitleEvent,
    reminder: t.quickCreate.defaultTitleTask,
    appointment: t.quickCreate.defaultTitleAppointment,
  };

  const handleSave = async () => {
    const finalTitle = title.trim() || defaultTitles[type] || t.calendarView.untitled;

    if (isTask) {
      await createTask.mutateAsync({
        title: finalTitle,
        description: description.trim() || undefined,
        status: taskStatus,
        priority: taskPriority || undefined,
        dueDate: taskDueDate && taskDueTime
          ? new Date(`${format(taskDueDate, 'yyyy-MM-dd')}T${taskDueTime}`)
          : taskDueDate,
        labels: taskLabels.length > 0 ? taskLabels : undefined,
        repeat: taskRepeat ? { frequency: taskRepeat as any } : undefined,
      });
    } else {
      const start = allDay ? new Date(`${startDate}T00:00:00`) : new Date(`${startDate}T${startTimeVal}`);
      const end = allDay ? new Date(`${endDate}T23:59:59`) : new Date(`${endDate}T${endTimeVal}`);
      const eventData = {
        calendarId: selectedCalendarId,
        title: finalTitle,
        type: type as any,
        allDay,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        status: 'confirmed' as const,
        priority: 'normal' as const,
        location: location.trim() || undefined,
        description: description.trim() || undefined,
        isVirtual: !!meetingUrl.trim(),
        meetingUrl: meetingUrl.trim() || undefined,
        attendees: selectedGuests.length > 0 ? selectedGuests.map((g) => ({ email: g.email, name: g.name })) : undefined,
      };
      if (isEditMode) {
        const hasExistingAttendees = !!editEvent?.attendees?.length;
        if (hasExistingAttendees) {
          setPendingEventData(eventData);
          setShowUpdateDialog(true);
          return; // don't close yet — wait for dialog
        }
        await updateEvent.mutateAsync({ id: editEvent.id, data: eventData });
      } else {
        await createEvent.mutateAsync(eventData);
      }
    }
    onClose();
  };

  const handleUpdateConfirm = async (sendNotification: boolean) => {
    if (editEvent?.id && pendingEventData) {
      await updateEvent.mutateAsync({ id: editEvent.id, data: pendingEventData, sendNotification });
      setPendingEventData(null);
      setShowUpdateDialog(false);
      onClose();
    }
  };

  return (
    <div
      className="overflow-y-auto max-h-[80vh]"
      onClick={() => setActiveField(null)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
        if (e.key === 'Enter' && !e.shiftKey && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); handleSave(); }
      }}
    >
      {/* Title */}
      <div className="px-4 pt-4 pb-4">
        <Input
          placeholder={t.quickCreate.addTitlePlaceholder}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); handleSave(); } }}
          className="h-10 text-sm font-medium shadow-none"
          autoFocus
        />
      </div>

      {/* Type tabs */}
      {showTypeTabs && (
        <div className="px-4 pb-3">
          <Tabs value={type} onValueChange={setType}>
            {/* `--muted` equals `--popover` in dark mode, so the default pill
                track is invisible inside this popover. Give the track a
                contrasting surface and the active pill a raised one in dark
                mode so it reads the same as light mode. */}
            <TabsList className="h-8 w-auto dark:bg-secondary">
              <TabsTrigger value="event" className="text-xs px-3 h-7 dark:data-[state=active]:bg-input">{t.quickCreate.typeEventTab}</TabsTrigger>
              <TabsTrigger value="reminder" className="text-xs px-3 h-7 dark:data-[state=active]:bg-input">{t.quickCreate.typeTaskTab}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      )}

      <Separator />

      {/* Rows */}
      <div className="divide-y" onClick={(e) => e.stopPropagation()}>
        {isTask ? (
          <>
            {/* Task: Status row */}
            <InlineSelectRow
              icon={<CircleDot className="h-4 w-4 text-muted-foreground shrink-0" />}
              value={taskStatus}
              displayValue={taskStatus === 'todo' ? t.quickCreate.statusTodo : taskStatus === 'in_progress' ? t.quickCreate.statusInProgress : t.quickCreate.statusDone}
              options={[
                { value: 'todo', label: t.quickCreate.statusTodo },
                { value: 'in_progress', label: t.quickCreate.statusInProgress },
                { value: 'done', label: t.quickCreate.statusDone },
              ]}
              onChange={(v) => setTaskStatus(v as any)}
            />

            {/* Task: Priority row */}
            <InlineSelectRow
              icon={<Flag className="h-4 w-4 text-muted-foreground shrink-0" />}
              value={taskPriority || 'none'}
              displayValue={taskPriority === 'low' ? t.quickCreate.priorityLow : taskPriority === 'medium' ? t.quickCreate.priorityMedium : taskPriority === 'high' ? t.quickCreate.priorityHigh : t.quickCreate.priorityLabel}
              options={[
                { value: 'none', label: t.quickCreate.priorityNone },
                { value: 'low', label: t.quickCreate.priorityLow },
                { value: 'medium', label: t.quickCreate.priorityMedium },
                { value: 'high', label: t.quickCreate.priorityHigh },
              ]}
              onChange={(v) => setTaskPriority(v === 'none' ? null : v as any)}
            />

            {/* Task: Labels row */}
            <div className="flex items-center gap-3 px-4 py-[10px] cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => setActiveField(activeField === 'labels' as any ? null : 'labels' as any)}>
              <Tag className="h-4 w-4 text-muted-foreground shrink-0" />
              {activeField === ('labels' as any) ? (
                <div className="flex-1" onClick={(e) => e.stopPropagation()}>
                  <Input
                    placeholder={t.quickCreate.labelsPlaceholder}
                    className="h-7 text-sm shadow-none border-0 px-0 focus-visible:ring-0"
                    autoFocus
                    onBlur={() => setTimeout(() => setActiveField(null), 150)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.target as HTMLInputElement).value.trim()) {
                        const val = (e.target as HTMLInputElement).value.trim();
                        if (!taskLabels.includes(val)) setTaskLabels((prev) => [...prev, val]);
                        (e.target as HTMLInputElement).value = '';
                      }
                    }}
                  />
                  {taskLabels.length > 0 && (
                    <div className="flex items-center gap-1 flex-wrap mt-1.5">
                      {taskLabels.map((l) => (
                        <span key={l} className="inline-flex items-center gap-1 text-xs bg-accent rounded px-2 py-0.5">
                          {l}
                          <Button variant="ghost" className="hover:text-foreground" onMouseDown={(e) => e.preventDefault()} onClick={() => setTaskLabels((prev) => prev.filter((x) => x !== l))}>
                            <X className="h-2.5 w-2.5" />
                          </Button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ) : taskLabels.length > 0 ? (
                <div className="flex items-center gap-1 flex-wrap">
                  {taskLabels.map((l) => (
                    <span key={l} className="text-xs bg-accent px-2 py-0.5 rounded">{l}</span>
                  ))}
                </div>
              ) : (
                <span className="text-sm text-foreground h-7 flex items-center">{t.quickCreate.labelsLabel}</span>
              )}
            </div>

            {/* Task: Assignees row */}
            {taskAssignees.length > 0 || activeField === 'assignee' ? (
              <div className="px-4 py-[10px] cursor-pointer" onClick={() => activeField !== 'assignee' && setActiveField('assignee')}>
                <div className="flex gap-3">
                  <Users className="h-4 w-4 text-muted-foreground shrink-0 mt-1.5" />
                  <div className="flex-1 min-w-0 space-y-1">
                    {taskAssignees.map((g) => (
                      <div key={g.id} className="flex items-center justify-between gap-2 h-7">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <div className="h-[20px] w-[20px] rounded-[5.5px] bg-primary/10 flex items-center justify-center shrink-0 leading-none">
                            <span className="text-[10px] font-medium text-primary leading-none -mt-[0.5px]">
                              {(g.name?.[0] || g.email[0] || '?').toUpperCase()}
                            </span>
                          </div>
                          <span className="text-sm truncate leading-none">{g.name || g.email}</span>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 rounded-[5.5px] hover:bg-muted flex items-center justify-center shrink-0"
                          onClick={(e) => { e.stopPropagation(); setTaskAssignees((prev) => prev.filter((p) => p.id !== g.id)); }}
                        >
                          <X className="h-3 w-3 text-muted-foreground" />
                        </Button>
                      </div>
                    ))}
                    {activeField === 'assignee' && (
                      <GuestSearchInput
                        value={taskAssigneeSearch}
                        onChange={setTaskAssigneeSearch}
                        selectedIds={taskAssignees.map((g) => g.id)}
                        onSelect={(guest) => {
                          setTaskAssignees((prev) => [...prev, guest]);
                          setTaskAssigneeSearch('');
                        }}
                        onBlurAway={() => setActiveField(null)}
                      />
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 px-4 py-[10px] cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => setActiveField('assignee')}>
                <Users className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm text-foreground h-7 flex items-center">{t.quickCreate.assigneeLabel}</span>
              </div>
            )}

            {/* Task: Due date & time row */}
            <InlineDateTimeRow
              icon={<CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />}
              date={taskDueDate}
              time={taskDueTime}
              onDateChange={setTaskDueDate}
              onTimeChange={setTaskDueTime}
              placeholder={t.quickCreate.dueDatePlaceholder}
            />

            {/* Task: Description row */}
            <div
              className="flex items-start gap-3 px-4 py-[10px] cursor-pointer hover:bg-accent/50 transition-colors"
              onClick={() => setActiveField('description')}
            >
              <AlignLeft className="h-4 w-4 text-muted-foreground shrink-0 mt-1.5" />
              {activeField === 'description' ? (
                <textarea
                  ref={descriptionRef}
                  placeholder={t.quickCreate.descriptionPlaceholder}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onBlur={() => setActiveField(null)}
                  rows={1}
                  className="flex-1 text-sm leading-7 py-0 bg-transparent resize-none focus:outline-none overflow-hidden"
                  autoFocus
                />
              ) : description ? (
                <span className="flex-1 min-w-0 text-sm text-foreground leading-7 truncate">{description}</span>
              ) : (
                <span className="flex-1 text-sm text-foreground leading-7">{t.quickCreate.descriptionPlaceholder}</span>
              )}
            </div>

            {/* Task: Attachment row */}
            <div className="flex items-center gap-3 px-4 py-[10px] cursor-pointer hover:bg-accent/50 transition-colors">
              <Paperclip className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="text-sm text-foreground h-7 flex items-center">{t.quickCreate.addAttachment}</span>
            </div>
          </>
        ) : (
          <>
            {/* Event: Date/time row */}
            <div
              className={cn(
                'flex items-start gap-3 px-4 py-[10px] cursor-pointer transition-colors',
                activeField !== 'time' && 'hover:bg-accent/50',
              )}
              onClick={() => setActiveField(activeField === 'time' ? null : 'time')}
            >
              <Clock className="h-4 w-4 text-muted-foreground shrink-0 mt-[5px]" />
              <div className="flex-1 min-w-0 space-y-2">
                {activeField === 'time' ? (
                  <div onClick={(e) => e.stopPropagation()} className="space-y-2.5">
                    <div className="flex items-center gap-2">
                      <DatePickerField
                        value={new Date(startDate)}
                        onChange={(d) => setStartDate(format(d, 'yyyy-MM-dd'))}
                      />
                      <span className="text-muted-foreground text-xs shrink-0">–</span>
                      <DatePickerField
                        value={new Date(endDate)}
                        onChange={(d) => setEndDate(format(d, 'yyyy-MM-dd'))}
                      />
                    </div>
                    {!allDay && (
                      <div className="flex items-center gap-2">
                        <Input
                          type="time"
                          value={startTimeVal}
                          onChange={(e) => setStartTimeVal(e.target.value)}
                          className="h-[34px] text-sm shadow-none flex-1 [&::-webkit-calendar-picker-indicator]:hidden"
                        />
                        <span className="text-muted-foreground text-xs shrink-0">–</span>
                        <Input
                          type="time"
                          value={endTimeVal}
                          onChange={(e) => setEndTimeVal(e.target.value)}
                          className="h-[34px] text-sm shadow-none flex-1 [&::-webkit-calendar-picker-indicator]:hidden"
                        />
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">{t.calendarView.allDay}</span>
                      <Switch checked={allDay} onCheckedChange={setAllDay} className="h-[18.5px] [&_[data-slot=switch-thumb]]:translate-y-0" />
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-1 text-sm h-7">
                    <span>{format(new Date(startDate), 'EEEE, MMM d')}</span>
                    {!allDay && (
                      <>
                        <span className="text-muted-foreground">·</span>
                        <span>{format(new Date(`${startDate}T${startTimeVal}`), 'h:mm a')}</span>
                        <span className="text-muted-foreground">–</span>
                        <span>{format(new Date(`${endDate}T${endTimeVal}`), 'h:mm a')}</span>
                      </>
                    )}
                    {allDay && startDate !== endDate && (
                      <>
                        <span className="text-muted-foreground">–</span>
                        <span>{format(new Date(endDate), 'EEEE, MMM d')}</span>
                      </>
                    )}
                    {allDay && startDate === endDate && (
                      <span className="text-xs text-muted-foreground ml-1">· {t.calendarView.allDay}</span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Event: Participants row */}
            {selectedGuests.length > 0 || activeField === 'guests' ? (
              <div className="px-4 py-[10px] cursor-pointer" onClick={() => activeField !== 'guests' && setActiveField('guests')}>
                <div className="flex gap-3">
                  <Users className="h-4 w-4 text-muted-foreground shrink-0 mt-1.5" />
                  <div className="flex-1 min-w-0 space-y-1">
                    {selectedGuests.map((g) => (
                      <div key={g.id} className="flex items-center justify-between gap-2 h-7">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <div className="h-[20px] w-[20px] rounded-[5.5px] bg-primary/10 flex items-center justify-center shrink-0 leading-none">
                            <span className="text-[10px] font-medium text-primary leading-none -mt-[0.5px]">
                              {(g.name?.[0] || g.email[0] || '?').toUpperCase()}
                            </span>
                          </div>
                          <span className="text-sm truncate leading-none">{g.name || g.email}</span>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 rounded-[5.5px] hover:bg-muted flex items-center justify-center shrink-0"
                          onClick={(e) => { e.stopPropagation(); setSelectedGuests((prev) => prev.filter((p) => p.id !== g.id)); }}
                        >
                          <X className="h-3 w-3 text-muted-foreground" />
                        </Button>
                      </div>
                    ))}
                    {activeField === 'guests' && (
                      <GuestSearchInput
                        value={guestSearch}
                        onChange={setGuestSearch}
                        selectedIds={selectedGuests.map((g) => g.id)}
                        onSelect={(guest) => {
                          setSelectedGuests((prev) => [...prev, guest]);
                          setGuestSearch('');
                        }}
                        onBlurAway={() => setActiveField(null)}
                      />
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 px-4 py-[10px] cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => setActiveField('guests')}>
                <Users className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm text-foreground h-7 flex items-center">{t.quickCreate.addParticipants}</span>
              </div>
            )}

            {/* Event: WeldMeet row */}
            <div
              className={cn(
                'group flex items-center gap-3 px-4 py-[10px]',
                !isCreatingMeeting && !meetingUrl && 'cursor-pointer hover:bg-accent/50 transition-colors',
              )}
              onClick={
                !isCreatingMeeting && !meetingUrl
                  ? async () => {
                      const result = await createMeetingAndGetUrl(title || 'Meeting');
                      if (result) {
                        setMeetingUrl(result.url);
                        setMeetingId(result.meetingId);
                      }
                    }
                  : undefined
              }
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="h-[18px] w-[18px] -mx-px text-muted-foreground shrink-0"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
                />
              </svg>
              {isCreatingMeeting ? (
                <div className="flex items-center gap-2 h-7">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">{t.quickCreate.creatingMeetingLink}</span>
                </div>
              ) : meetingUrl ? (
                <div className="flex items-center justify-between flex-1 h-7 min-w-0 gap-2">
                  <span className="text-sm text-primary truncate">{meetingUrl}</span>
                  <div className="flex items-center gap-0.5 shrink-0">
                    {/* Copy link — revealed on row hover */}
                    <Button
                      variant="ghost"
                      size="icon"
                      type="button"
                      title={t.quickCreate.copyMeetingLink}
                      aria-label={t.quickCreate.copyMeetingLink}
                      className="h-6 w-6 rounded-[5.5px] hover:bg-muted flex items-center justify-center"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCopyMeetingLink();
                      }}
                    >
                      {meetingLinkCopied ? (
                        <Check className="h-3.5 w-3.5 text-green-600" />
                      ) : (
                        <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </Button>

                    {/* Meeting settings — revealed on row hover, opens a popover */}
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          type="button"
                          title={t.quickCreate.meetingSettings}
                          aria-label={t.quickCreate.meetingSettings}
                          className="h-6 w-6 rounded-[5.5px] hover:bg-muted flex items-center justify-center data-[state=open]:bg-muted"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Settings className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        align="end"
                        className="w-72 p-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <p className="text-sm font-medium mb-3">{t.quickCreate.meetingSettings}</p>
                        <div className="space-y-3">
                          <div className="space-y-1.5">
                            <label className="text-xs text-muted-foreground">{t.quickCreate.meetingAccess}</label>
                            <Select
                              value={meetingSettings.accessType}
                              onValueChange={(v) =>
                                updateMeetingSetting({ accessType: v as typeof meetingSettings.accessType })
                              }
                            >
                              <SelectTrigger className="h-8 text-sm">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="anyone_with_link">{t.quickCreate.meetingAccessAnyone}</SelectItem>
                                <SelectItem value="workspace">{t.quickCreate.meetingAccessWorkspace}</SelectItem>
                                <SelectItem value="invited_only">{t.quickCreate.meetingAccessInvited}</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="flex items-center justify-between">
                            <label htmlFor="weldmeet-waiting-room" className="text-sm">{t.quickCreate.meetingWaitingRoom}</label>
                            <Switch
                              id="weldmeet-waiting-room"
                              checked={meetingSettings.waitingRoom}
                              onCheckedChange={(c) => updateMeetingSetting({ waitingRoom: c })}
                            />
                          </div>
                          <div className="flex items-center justify-between">
                            <label htmlFor="weldmeet-allow-recording" className="text-sm">{t.quickCreate.meetingAllowRecording}</label>
                            <Switch
                              id="weldmeet-allow-recording"
                              checked={meetingSettings.allowRecording}
                              onCheckedChange={(c) => updateMeetingSetting({ allowRecording: c })}
                            />
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>

                    {/* Remove meeting link */}
                    <Button
                      variant="ghost"
                      size="icon"
                      type="button"
                      className="h-6 w-6 rounded-[5.5px] hover:bg-muted flex items-center justify-center"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMeetingUrl('');
                        setMeetingId('');
                      }}
                    >
                      <X className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  </div>
                </div>
              ) : (
                <span className="text-sm text-foreground h-7 flex items-center">
                  {t.quickCreate.addWeldMeet}
                </span>
              )}
            </div>

            {/* Event: Location row */}
            <div className="flex items-center gap-3 px-4 py-[10px] cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => setActiveField('location')}>
              <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
              {activeField === 'location' ? (
                <LocationAutocomplete
                  placeholder={t.quickCreate.addLocation}
                  value={location}
                  onChange={setLocation}
                  className="h-7 text-sm shadow-none border-0 px-0 focus-visible:ring-0"
                  autoFocus
                  onBlurAfterGrace={() => setActiveField(null)}
                />
              ) : location ? (
                <span className="text-sm text-foreground h-7 flex items-center truncate">{location}</span>
              ) : (
                <span className="text-sm text-foreground h-7 flex items-center">{t.quickCreate.addLocation}</span>
              )}
            </div>

            {/* Event: Description row */}
            <div
              className="flex items-start gap-3 px-4 py-[10px] cursor-pointer hover:bg-accent/50 transition-colors"
              onClick={() => setActiveField('description')}
            >
              <AlignLeft className="h-4 w-4 text-muted-foreground shrink-0 mt-1.5" />
              {activeField === 'description' ? (
                <textarea
                  ref={descriptionRef}
                  placeholder={t.quickCreate.descriptionPlaceholder}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onBlur={() => setActiveField(null)}
                  rows={1}
                  className="flex-1 text-sm leading-7 py-0 bg-transparent resize-none focus:outline-none overflow-hidden"
                  autoFocus
                />
              ) : description ? (
                <span className="flex-1 min-w-0 text-sm text-foreground leading-7 truncate">{description}</span>
              ) : (
                <span className="flex-1 text-sm text-foreground leading-7">{t.quickCreate.descriptionWithDrivePlaceholder}</span>
              )}
            </div>

            {/* Event: Calendar row */}
            {calendars.length > 0 && (
              <CalendarSelectRow
                calendars={calendars}
                selectedId={selectedCalendarId}
                onChange={setSelectedCalendarId}
              />
            )}
          </>
        )}
      </div>

      <Separator />

      {/* Footer */}
      <div className="flex items-center justify-end px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1.5">
          <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size={taskRepeat ? 'sm' : 'icon'}
                  className={cn(
                    'h-8',
                    taskRepeat
                      ? 'gap-1.5 px-2.5 bg-primary/5 text-primary border-primary/10 hover:bg-primary/10 hover:text-primary'
                      : 'w-8',
                  )}
                >
                  <Repeat2 className="h-4 w-4" />
                  {taskRepeat && <span className="text-xs">{taskRepeat.charAt(0).toUpperCase() + taskRepeat.slice(1)}</span>}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[140px] p-1 z-[80]" align="end" sideOffset={4}>
                {[
                  { value: null, label: t.quickCreate.noRepeat },
                  { value: 'daily', label: t.quickCreate.repeatDaily },
                  { value: 'weekly', label: t.quickCreate.repeatWeekly },
                  { value: 'monthly', label: t.quickCreate.repeatMonthly },
                  { value: 'yearly', label: t.quickCreate.repeatYearly },
                ].map((opt) => (
                  <Button
                    variant="ghost"
                    key={opt.label}
                    className={cn(
                      'w-full text-left text-sm px-3 py-1.5 rounded-md transition-colors',
                      taskRepeat === opt.value ? 'bg-accent font-medium' : 'hover:bg-accent/50',
                    )}
                    onClick={() => setTaskRepeat(opt.value)}
                  >
                    {opt.label}
                  </Button>
                ))}
              </PopoverContent>
            </Popover>
          <Button
            variant="default"
            size="sm"
            onClick={handleSave}
            disabled={createEvent.isPending || createTask.isPending}
          >
            {t.quickCreate.save}
          </Button>
        </div>
      </div>

      <EventNotificationDialog
        open={showUpdateDialog}
        onOpenChange={(open) => { if (!open) { setShowUpdateDialog(false); setPendingEventData(null); } }}
        onConfirm={handleUpdateConfirm}
        isPending={updateEvent.isPending}
        variant="update"
      />
    </div>
  );
}

// ============================================================================
// Month View
// ============================================================================

function MonthView({
  currentDate,
  events,
  calendarColorMap,
  onSelectEvent,
  onSelectSlot,
  selectedDate,
  selectedType,
  selectedColor,
  selectedEventId,
  onEventDrop,
}: {
  currentDate: Date;
  events: CalendarEvent[];
  calendarColorMap: Record<string, string>;
  onSelectEvent: (e: CalendarEvent, mouseEvent: React.MouseEvent) => void;
  onSelectSlot: (start: Date, end: Date, e: React.MouseEvent | MouseEvent, wasDrag?: boolean) => void;
  selectedDate?: Date;
  selectedType?: string;
  selectedColor?: string;
  selectedEventId?: string;
  onEventDrop: (event: CalendarEvent, newStart: Date, newEnd: Date) => void;
}) {
  const t = getTranslations('weldcalendar');
  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const calStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });

  // Build weeks
  const weeks: Date[][] = [];
  let day = calStart;
  while (day <= calEnd) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(day);
      day = addDays(day, 1);
    }
    weeks.push(week);
  }

  // Group events by day
  const eventsByDay = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {};
    for (const evt of events) {
      const key = format(new Date(evt.startTime), 'yyyy-MM-dd');
      if (!map[key]) map[key] = [];
      map[key].push(evt);
    }
    return map;
  }, [events]);

  // Drag-and-drop state
  const [dragEvent, setDragEvent] = useState<CalendarEvent | null>(null);
  const [dragOverDate, setDragOverDate] = useState<string | null>(null);
  const dragRef = useRef<{ event: CalendarEvent; originDate: string; startX: number; startY: number } | null>(null);
  const pendingDragRef = useRef(false);
  const justDraggedRef = useRef(false);

  useEffect(() => {
    if (!dragEvent) return;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    const handleMouseMove = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const cell = el?.closest('[data-date]') as HTMLElement;
      if (cell?.dataset.date) {
        setDragOverDate(cell.dataset.date);
      }
    };
    const handleMouseUp = () => {
      if (dragRef.current && dragOverDate && dragOverDate !== dragRef.current.originDate) {
        const evt = dragRef.current.event;
        const oldStart = new Date(evt.startTime);
        const newDay = new Date(dragOverDate + 'T00:00:00');
        const newStart = new Date(newDay);
        newStart.setHours(oldStart.getHours(), oldStart.getMinutes(), oldStart.getSeconds());
        const duration = evt.endTime
          ? new Date(evt.endTime).getTime() - oldStart.getTime()
          : 60 * 60 * 1000;
        const newEnd = new Date(newStart.getTime() + duration);
        onEventDrop(evt, newStart, newEnd);
      }
      justDraggedRef.current = true;
      setTimeout(() => { justDraggedRef.current = false; }, 50);
      dragRef.current = null;
      setDragEvent(null);
      setDragOverDate(null);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragEvent, dragOverDate, onEventDrop]);

  // Pending drag: only promote to real drag after mouse moves 5px
  useEffect(() => {
    if (!pendingDragRef.current || dragEvent) return;
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      if (Math.abs(dx) + Math.abs(dy) > 5) {
        pendingDragRef.current = false;
        setDragEvent(dragRef.current.event);
        setDragOverDate(dragRef.current.originDate);
      }
    };
    const handleMouseUp = () => {
      pendingDragRef.current = false;
      dragRef.current = null;
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  });

  const handleEventDragStart = useCallback((evt: CalendarEvent, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const originDate = format(new Date(evt.startTime), 'yyyy-MM-dd');
    dragRef.current = { event: evt, originDate, startX: e.clientX, startY: e.clientY };
    pendingDragRef.current = true;
  }, []);

  const dayNames = [
    t.bookingEditorDays.mon,
    t.bookingEditorDays.tue,
    t.bookingEditorDays.wed,
    t.bookingEditorDays.thu,
    t.bookingEditorDays.fri,
    t.bookingEditorDays.sat,
    t.bookingEditorDays.sun,
  ];

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Day headers */}
      <div className="grid grid-cols-7 border-b">
        {dayNames.map((name) => (
          <div key={name} className="text-center text-xs font-medium text-muted-foreground py-2 border-r last:border-r-0">
            {name}
          </div>
        ))}
      </div>

      {/* Weeks */}
      <div className="grid flex-1" style={{ gridTemplateRows: `repeat(${weeks.length}, 1fr)` }}>
        {weeks.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7 border-b last:border-b-0 overflow-hidden">
            {week.map((day) => {
              const key = format(day, 'yyyy-MM-dd');
              const dayEvents = eventsByDay[key] || [];
              const isCurrentMonth = isSameMonth(day, currentDate);
              const today = isToday(day);

              const isSelected = selectedDate && isSameDay(day, selectedDate);
              const previewColor = selectedColor || (selectedType ? (EVENT_TYPE_COLORS[selectedType] || '#3b82f6') : '#3b82f6');
              const isDragOver = dragEvent && dragOverDate === key && dragRef.current?.originDate !== key;

              return (
                <div
                  key={key}
                  data-calendar-cell
                  data-date={key}
                  className={cn(
                    'border-r last:border-r-0 p-1 cursor-pointer transition-colors hover:bg-accent/30',
                    !isCurrentMonth && 'bg-muted/50',
                    today && 'bg-primary/[0.01]',
                    isSelected && 'bg-primary/5',
                    isDragOver && 'bg-primary/10 ring-2 ring-inset ring-primary/30',
                  )}
                  onClick={(e) => { if (!dragEvent) onSelectSlot(day, new Date(day.getTime() + 3600000), e); }}
                >
                  <div className="flex justify-end mb-0.5">
                    <span
                      className={cn(
                        'text-sm font-medium w-6 h-6 flex items-center justify-center rounded-[7px]',
                        today && 'text-[#3073f1] font-semibold',
                        !today && isCurrentMonth && 'text-foreground',
                        !today && !isCurrentMonth && 'text-muted-foreground',
                      )}
                    >
                      {format(day, 'd')}
                    </span>
                  </div>
                  <div className="space-y-0.5 overflow-hidden">
                    {(() => {
                      const max = isSelected ? 6 : 7;
                      const showMore = dayEvents.length > max;
                      const visible = showMore ? max - 1 : dayEvents.length;
                      const remaining = dayEvents.length - visible;
                      return (
                        <>
                          {dayEvents.slice(0, visible).map((evt, ei) => {
                            const isEventSelected = selectedEventId === evt.id;
                            const isDragging = dragEvent?.id === evt.id;
                            const eventColor = getEventColor(evt, calendarColorMap);
                            return (
                            <Button
                              variant="ghost"
                              key={evt.id || ei}
                              className={cn(
                                "w-full text-left text-[11px] leading-tight px-1.5 pt-[6px] pb-[5px] rounded-[6px] truncate text-white font-medium border-0 transition-all",
                                isEventSelected && "ring-2 ring-foreground/50 ring-offset-1 brightness-90",
                                isDragging && "opacity-40 pointer-events-none",
                              )}
                              style={{ backgroundColor: eventColor, cursor: 'grab' }}
                              onMouseDown={(e) => handleEventDragStart(evt, e)}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!dragEvent && !justDraggedRef.current) onSelectEvent(evt, e);
                              }}
                            >
                              {evt.allDay ? evt.title : `${format(new Date(evt.startTime), 'h:mm')} ${evt.title}`}
                            </Button>
                            );
                          })}
                          {showMore && (
                            <p className="text-[11px] text-muted-foreground pl-1.5 font-medium mt-[3px]">
                              {t.misc.moreEvents.replace('{count}', String(remaining))}
                            </p>
                          )}
                        </>
                      );
                    })()}
                    {/* Ghost preview on drag target */}
                    {isDragOver && dragEvent && (
                      <div
                        className="w-full text-left text-[11px] leading-tight px-1.5 pt-[6px] pb-[5px] rounded-[6px] truncate text-white font-medium opacity-60"
                        style={{ backgroundColor: getEventColor(dragEvent, calendarColorMap) }}
                      >
                        {dragEvent.title}
                      </div>
                    )}
                    {/* Preview block on selected date */}
                    {isSelected && !dragEvent && (
                      <Button
                        variant="ghost"
                        data-preview
                        className="w-full text-left text-[11px] leading-tight px-1.5 pt-[6px] pb-[5px] rounded-[6px] truncate text-white font-medium border-0 animate-in fade-in-50"
                        style={{ backgroundColor: previewColor }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {t.misc.noTitle}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Mobile views — Apple Calendar-style. Phones can't show a 7-column week grid
// or per-cell event labels in a month grid, so on viewports under md (768px)
// we swap the desktop grids for these compact equivalents.
// ============================================================================

/** A horizontal 7-day strip used as the header on mobile week / day views.
 *  Single-letter day initials, large date number, today in brand blue,
 *  selected day filled, a dot underneath if there are events that day. */
function MobileWeekDayStrip({
  weekDate,
  selectedDate,
  events,
  onSelectDay,
}: {
  weekDate: Date;
  selectedDate: Date;
  events: CalendarEvent[];
  onSelectDay: (d: Date) => void;
}) {
  const weekStart = startOfWeek(weekDate, { weekStartsOn: 1 });
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  void events; // event-dot indicator removed by request

  return (
    <div className="flex border-b shrink-0 px-1 py-2 bg-background">
      {days.map((day) => {
        const key = format(day, 'yyyy-MM-dd');
        const today = isToday(day);
        const selected = isSameDay(day, selectedDate);
        return (
          <Button
            variant="ghost"
            key={key}
            type="button"
            onClick={() => onSelectDay(day)}
            className="flex-1 flex flex-col items-center gap-1 py-1 focus:outline-none"
          >
            <span
              className={cn(
                'text-[11px] font-medium uppercase tracking-wide',
                today ? 'font-semibold' : 'text-muted-foreground',
              )}
              style={today ? { color: TODAY_BLUE } : undefined}
            >
              {format(day, 'EEEEE')}
            </span>
            <span
              className={cn(
                'h-8 w-8 flex items-center justify-center rounded-full text-[15px] font-medium transition-colors',
                selected && today && 'text-white',
                selected && !today && 'bg-foreground text-background',
                !selected && today && 'font-semibold',
                !selected && !today && 'text-foreground',
              )}
              style={
                selected && today
                  ? { backgroundColor: TODAY_BLUE }
                  : !selected && today
                  ? { color: TODAY_BLUE }
                  : undefined
              }
            >
              <span className="translate-y-px">{format(day, 'd')}</span>
            </span>
          </Button>
        );
      })}
    </div>
  );
}

/** Mobile week / day view — week-strip header + a single-day timeline. The
 *  user picks a day in the strip to swap the timeline; toolbar PREV/NEXT
 *  navigate by week (handled by the parent's existing goPrev / goNext when
 *  currentView is 'week'). */
function MobileWeekTimelineView(props: {
  currentDate: Date;
  events: CalendarEvent[];
  calendarColorMap: Record<string, string>;
  onSelectEvent: (e: CalendarEvent, mouseEvent: React.MouseEvent) => void;
  onSelectDay: (d: Date) => void;
  onSelectSlot: (start: Date, end: Date, e: React.MouseEvent | MouseEvent, wasDrag?: boolean) => void;
  selectedDate?: Date;
  selectedEndDate?: Date;
  selectedType?: string;
  selectedColor?: string;
  onEventDrop: (event: CalendarEvent, newStart: Date, newEnd: Date) => void;
  workingHours?: WorkingHours | null;
  onPreviewMouseDown?: (e: React.MouseEvent) => void;
  onPreviewResize?: (edge: 'top' | 'bottom', e: React.MouseEvent) => void;
}) {
  const { currentDate, events, onSelectDay, ...dayProps } = props;

  // Horizontal swipe → previous / next day with a smooth slide.
  //
  // PERF: during the drag and snap animation we mutate `stripRef.current.style`
  // directly instead of going through React state. setState on every touchmove
  // would force a re-render of three heavyweight DayViews ~60×/sec — that's
  // the lag. The transform never depends on React state until `onSelectDay`
  // commits, at which point the layout effect below resets the strip in one
  // synchronous step (no animated jump back to centre).
  const containerRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number; width: number } | null>(null);
  const dragLockedRef = useRef<'horizontal' | 'vertical' | null>(null);
  const snapDirRef = useRef<-1 | 0 | 1>(0);

  const dayPrev = useMemo(() => addDays(currentDate, -1), [currentDate]);
  const dayNext = useMemo(() => addDays(currentDate, 1), [currentDate]);

  const SLIDE_TRANSITION = 'transform 260ms cubic-bezier(0.22, 0.61, 0.36, 1)';

  const setStripTransform = (px: number, withTransition: boolean) => {
    const el = stripRef.current;
    if (!el) return;
    el.style.transition = withTransition ? SLIDE_TRANSITION : 'none';
    el.style.transform = `translate3d(calc(-33.3333% + ${px}px), 0, 0)`;
  };

  // Whenever currentDate changes (slide commit OR user tap on the week strip),
  // snap the inner strip back to centre with no animation. The new currentDate
  // re-renders the three slots; the centre slot now shows the day the user
  // landed on, so the reset is invisible.
  useLayoutEffect(() => {
    setStripTransform(0, false);
    // Re-enable transitions for the next interaction once the snap is committed.
    const id = requestAnimationFrame(() => {
      const el = stripRef.current;
      if (el) el.style.transition = SLIDE_TRANSITION;
    });
    return () => cancelAnimationFrame(id);
  }, [currentDate]);

  // Touch handlers — attached via useEffect (not React's synthetic events) so
  // we can register touchmove as { passive: false } and use preventDefault to
  // suppress native horizontal pan during a swipe.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || snapDirRef.current !== 0) return;
      const t = e.touches[0];
      touchStartRef.current = {
        x: t.clientX,
        y: t.clientY,
        width: container.clientWidth,
      };
      dragLockedRef.current = null;
    };

    const onMove = (e: TouchEvent) => {
      const start = touchStartRef.current;
      if (!start) return;
      const t = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;

      if (dragLockedRef.current === null) {
        if (Math.abs(dx) > 12 || Math.abs(dy) > 12) {
          dragLockedRef.current =
            Math.abs(dx) > Math.abs(dy) * 1.2 ? 'horizontal' : 'vertical';
        } else {
          return;
        }
      }

      if (dragLockedRef.current === 'horizontal') {
        if (e.cancelable) e.preventDefault();
        // Direct DOM update — no React render, no DayView reconciliation.
        setStripTransform(dx, false);
      }
    };

    const onEnd = (e: TouchEvent) => {
      const start = touchStartRef.current;
      touchStartRef.current = null;
      const wasHorizontal = dragLockedRef.current === 'horizontal';
      dragLockedRef.current = null;
      if (!start || !wasHorizontal) return;

      const dx = e.changedTouches[0].clientX - start.x;
      const threshold = Math.min(60, start.width * 0.2);
      if (Math.abs(dx) >= threshold) {
        const dir: -1 | 1 = dx < 0 ? 1 : -1;
        snapDirRef.current = dir;
        // Animate the rest of the way to the slide end.
        setStripTransform(dir * -start.width, true);
      } else {
        // Spring back to centre with a transition.
        setStripTransform(0, true);
      }
    };

    container.addEventListener('touchstart', onStart, { passive: true });
    container.addEventListener('touchmove', onMove, { passive: false });
    container.addEventListener('touchend', onEnd, { passive: true });
    container.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      container.removeEventListener('touchstart', onStart);
      container.removeEventListener('touchmove', onMove);
      container.removeEventListener('touchend', onEnd);
      container.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  // Slide-to-commit handler — attached to the strip's transitionend. Fires
  // for both the snap-back (springs to 0, ignored) and the slide-to-next
  // (commits the day). The layout effect above handles the centre reset.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const handler = (e: TransitionEvent) => {
      if (e.target !== el || e.propertyName !== 'transform') return;
      if (snapDirRef.current === 0) return;
      const dir = snapDirRef.current;
      snapDirRef.current = 0;
      onSelectDay(addDays(currentDate, dir));
    };
    el.addEventListener('transitionend', handler);
    return () => el.removeEventListener('transitionend', handler);
  }, [currentDate, onSelectDay]);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden [touch-action:pan-y] [overscroll-behavior-x:contain]">
      <MobileWeekDayStrip
        weekDate={currentDate}
        selectedDate={currentDate}
        events={events}
        onSelectDay={onSelectDay}
      />
      <div
        ref={containerRef}
        className="flex-1 min-h-0 relative overflow-hidden [touch-action:pan-y] [overscroll-behavior-x:contain]"
      >
        <div
          ref={stripRef}
          className="absolute inset-0 flex will-change-transform"
          style={{
            width: '300%',
            transform: 'translate3d(calc(-33.3333% + 0px), 0, 0)',
            transition: SLIDE_TRANSITION,
          }}
        >
          <div className="w-1/3 h-full overflow-hidden">
            <DayView currentDate={dayPrev} events={events} hideHeader {...dayProps} />
          </div>
          <div className="w-1/3 h-full overflow-hidden">
            <DayView currentDate={currentDate} events={events} hideHeader {...dayProps} />
          </div>
          <div className="w-1/3 h-full overflow-hidden">
            <DayView currentDate={dayNext} events={events} hideHeader {...dayProps} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Apple-style mobile month — compact grid with event dots (no labels), and
 *  the selected day's events listed in a scrollable section below the grid. */
/** One month's grid inside the continuous-scroll mobile month view. Renders
 *  only the days of `month` — outside-month cells are blank so months read as
 *  separate blocks (matching iPhone Calendar). */
function MobileMonthBlock({
  month,
  currentDate,
  onSelectDay,
}: {
  month: Date;
  currentDate: Date;
  onSelectDay: (d: Date) => void;
}) {
  const start = startOfMonth(month);
  const end = endOfMonth(month);
  const calStart = startOfWeek(start, { weekStartsOn: 1 });
  const calEnd = endOfWeek(end, { weekStartsOn: 1 });
  const weeks: Date[][] = [];
  let d = calStart;
  while (d <= calEnd) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(d);
      d = addDays(d, 1);
    }
    weeks.push(week);
  }
  const monthKey = format(month, 'yyyy-MM');

  return (
    <div data-month-key={monthKey} className="pb-2">
      <div className="px-4 pt-5 pb-2 text-[17px] font-semibold">
        {format(month, 'MMMM')}
        {month.getMonth() === 0 || isSameMonth(month, new Date()) ? (
          <span className="text-muted-foreground font-normal"> {format(month, 'yyyy')}</span>
        ) : null}
      </div>
      <div className="grid">
        {weeks.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7">
            {week.map((day) => {
              const inMonth = isSameMonth(day, month);
              if (!inMonth) {
                // Empty slot for prev/next-month padding — keeps the dates of
                // each month aligned to their true weekday column.
                return <div key={format(day, 'yyyy-MM-dd')} className="h-12" />;
              }
              const today = isToday(day);
              const selected = isSameDay(day, currentDate);
              return (
                <Button
                  variant="ghost"
                  key={format(day, 'yyyy-MM-dd')}
                  type="button"
                  onClick={() => onSelectDay(day)}
                  className="h-12 flex items-start justify-center pt-1.5 focus:outline-none"
                >
                  <span
                    className={cn(
                      'h-8 w-8 flex items-center justify-center rounded-full text-sm transition-colors',
                      !today && !selected && 'text-foreground',
                      today && !selected && 'font-semibold',
                      selected && today && 'text-white',
                      selected && !today && 'bg-foreground text-background',
                    )}
                    style={
                      selected && today
                        ? { backgroundColor: TODAY_BLUE }
                        : today && !selected
                        ? { color: TODAY_BLUE }
                        : undefined
                    }
                  >
                    <span className="translate-y-px">{format(day, 'd')}</span>
                  </span>
                </Button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function MobileMonthView({
  currentDate,
  onSelectDay,
}: {
  currentDate: Date;
  events: CalendarEvent[];
  calendarColorMap: Record<string, string>;
  onSelectEvent: (e: CalendarEvent, mouseEvent: React.MouseEvent) => void;
  onSelectDay: (d: Date) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // A fixed window of months around "now" — frozen at mount so updates to
  // `currentDate` (tapping a date in the scroll) don't shift the list.
  const months = useMemo(() => {
    const anchor = startOfMonth(new Date());
    const list: Date[] = [];
    for (let i = -12; i <= 24; i++) list.push(addMonths(anchor, i));
    return list;
  }, []);

  // On mount, snap the scroll to the current month's block so the user lands
  // on "today" rather than a year ago. Runs once.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const targetKey = format(startOfMonth(new Date()), 'yyyy-MM');
    const el = container.querySelector(`[data-month-key="${targetKey}"]`) as HTMLElement | null;
    if (el) container.scrollTop = el.offsetTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Single-letter weekday header (Mon–Sun).
  const dayLetters = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Sticky weekday header */}
      <div className="grid grid-cols-7 border-b shrink-0 bg-background">
        {dayLetters.map((d, i) => (
          <div
            key={i}
            className="text-center text-[11px] font-medium text-muted-foreground py-2 tracking-wide"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Continuous scroll of months. Auto-scrolled to "this month" on mount. */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto"
      >
        {months.map((m) => (
          <MobileMonthBlock
            key={format(m, 'yyyy-MM')}
            month={m}
            currentDate={currentDate}
            onSelectDay={onSelectDay}
          />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Week View
// ============================================================================

function WeekView({
  currentDate,
  events,
  calendarColorMap,
  onSelectEvent,
  onSelectSlot,
  selectedDate,
  selectedEndDate,
  selectedType,
  selectedColor,
  onEventDrop,
  workingHours,
  onPreviewMouseDown,
  onPreviewResize,
}: {
  currentDate: Date;
  events: CalendarEvent[];
  calendarColorMap: Record<string, string>;
  onSelectEvent: (e: CalendarEvent, mouseEvent: React.MouseEvent) => void;
  onSelectSlot: (start: Date, end: Date, e: React.MouseEvent | MouseEvent, wasDrag?: boolean) => void;
  selectedDate?: Date;
  selectedEndDate?: Date;
  selectedType?: string;
  selectedColor?: string;
  onEventDrop: (event: CalendarEvent, newStart: Date, newEnd: Date) => void;
  workingHours?: WorkingHours | null;
  onPreviewMouseDown?: (e: React.MouseEvent) => void;
  onPreviewResize?: (edge: 'top' | 'bottom', e: React.MouseEvent) => void;
}) {
  const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const containerRef = useRef<HTMLDivElement>(null);
  const [hourHeight, setHourHeight] = useState(48);

  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        const available = containerRef.current.clientHeight;
        const calculated = Math.max(48, Math.floor(available / 24));
        setHourHeight(calculated);
      }
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const { handleCellMouseDown, isSlotDragging, slotSelection } = useSlotDrag({
    hourHeight,
    onSelectSlot,
  });

  const { handleResizeStart, resizeState, isResizing, justResizedRef } = useEventResize({
    hourHeight,
    onResize: onEventDrop,
  });

  const { handleDragStart: handleEventDragStart, dragState, isDragging: isDragActive, justDraggedRef } = useEventDrag({
    hourHeight,
    onDrop: onEventDrop,
  });

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Day headers + time labels: shared primitives so design stays in
          lockstep with the booking calendars. */}
      <WeekDayHeader days={days} />

      <div ref={containerRef} className="flex-1 min-h-0 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        <div className="grid [grid-template-columns:var(--cal-time-label-width,72px)_repeat(7,1fr)] relative" style={{ minHeight: '100%' }}>
          <TimeLabelColumn hourHeight={hourHeight} />

          {/* Day columns */}
          {days.map((day) => {
            const dayKey = format(day, 'yyyy-MM-dd');
            const today = isToday(day);
            const dayEvents = events.filter(
              (e) => format(new Date(e.startTime), 'yyyy-MM-dd') === dayKey && !e.allDay,
            );

            return (
              <div key={dayKey} data-day-col={dayKey} className={cn(
                'border-r border-border last:border-r-0 relative',
                today && 'bg-primary/[0.01]',
              )}>
                {/* Hour lines */}
                {HOURS.map((hour) => (
                  <div
                    key={hour}
                    data-calendar-cell
                    className={cn(
                      'border-b border-border cursor-pointer hover:bg-accent/40 transition-colors',
                      !isWorkingHour(day, hour, workingHours) && 'bg-zinc-50/60 dark:bg-zinc-900/30',
                    )}
                    style={{ height: hourHeight }}
                    onMouseDown={(e) => { if (!dragState && !isResizing) handleCellMouseDown(day, hour, e); }}
                  />
                ))}

                {/* Current time indicator */}
                {today && <CurrentTimeIndicator hourHeight={hourHeight} />}

                {/* Events */}
                {dayEvents.map((evt, i) => {
                  const isDragging = dragState?.event.id === evt.id;
                  const isEventResizing = resizeState?.event.id === evt.id;
                  return (
                    <TimeSlotEvent
                      key={evt.id || i}
                      event={evt}
                      color={getEventColor(evt, calendarColorMap)}
                      onClick={(e) => { if (!dragState && !isSlotDragging && !isResizing && !justDraggedRef.current && !justResizedRef.current) onSelectEvent(evt, e); }}
                      hourHeight={hourHeight}
                      onDragStart={(e) => handleEventDragStart(evt, e)}
                      onResizeTopStart={(e) => handleResizeStart(evt, 'top', e)}
                      onResizeBottomStart={(e) => handleResizeStart(evt, 'bottom', e)}
                      dimmed={isDragging || isEventResizing}
                    />
                  );
                })}

                {/* Drag ghost */}
                {dragState && dragState.ghostDayKey === dayKey && (
                  <DragGhost
                    event={dragState.event}
                    color={getEventColor(dragState.event, calendarColorMap)}
                    top={dragState.ghostTop}
                    duration={dragState.duration}
                    hourHeight={hourHeight}
                  />
                )}

                {/* Resize ghost */}
                {resizeState && resizeState.dayKey === dayKey && (
                  <ResizeGhost
                    event={resizeState.event}
                    color={getEventColor(resizeState.event, calendarColorMap)}
                    top={resizeState.topPx}
                    height={resizeState.heightPx}
                    hourHeight={hourHeight}
                  />
                )}

                {/* Slot-drag selection preview */}
                {slotSelection && slotSelection.dayKey === dayKey && (
                  <SlotDragPreview
                    topPx={slotSelection.topPx}
                    heightPx={slotSelection.heightPx}
                    startTime={slotSelection.startTime}
                    endTime={slotSelection.endTime}
                  />
                )}

                {/* Preview block */}
                {!dragState && !isSlotDragging && !isResizing && selectedDate && isSameDay(day, selectedDate) && (
                  <TimeSlotPreview
                    date={selectedDate}
                    endDate={selectedEndDate}
                    type={selectedType}
                    color={selectedColor}
                    hourHeight={hourHeight}
                    onMouseDown={onPreviewMouseDown}
                    onResize={onPreviewResize}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Day View
// ============================================================================

function DayView({
  currentDate,
  events,
  calendarColorMap,
  onSelectEvent,
  onSelectSlot,
  selectedDate,
  selectedEndDate,
  selectedType,
  selectedColor,
  onEventDrop,
  workingHours,
  onPreviewMouseDown,
  onPreviewResize,
  hideHeader,
}: {
  currentDate: Date;
  events: CalendarEvent[];
  calendarColorMap: Record<string, string>;
  onSelectEvent: (e: CalendarEvent, mouseEvent: React.MouseEvent) => void;
  onSelectSlot: (start: Date, end: Date, e: React.MouseEvent | MouseEvent, wasDrag?: boolean) => void;
  selectedDate?: Date;
  selectedEndDate?: Date;
  selectedType?: string;
  selectedColor?: string;
  onEventDrop: (event: CalendarEvent, newStart: Date, newEnd: Date) => void;
  workingHours?: WorkingHours | null;
  onPreviewMouseDown?: (e: React.MouseEvent) => void;
  onPreviewResize?: (edge: 'top' | 'bottom', e: React.MouseEvent) => void;
  /** Suppress the built-in day header. Used by MobileWeekTimelineView which
   *  renders its own week-strip header above the timeline. */
  hideHeader?: boolean;
}) {
  const dayKey = format(currentDate, 'yyyy-MM-dd');
  const dayEvents = events.filter(
    (e) => format(new Date(e.startTime), 'yyyy-MM-dd') === dayKey && !e.allDay,
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [hourHeight, setHourHeight] = useState(48);

  const { handleCellMouseDown, isSlotDragging, slotSelection } = useSlotDrag({
    hourHeight,
    onSelectSlot,
  });

  const { handleResizeStart: handleDayResizeStart, resizeState: dayResizeState, isResizing: isDayResizing, justResizedRef: justDayResizedRef } = useEventResize({
    hourHeight,
    onResize: onEventDrop,
  });

  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        const available = containerRef.current.clientHeight;
        const calculated = Math.max(48, Math.floor(available / 24));
        setHourHeight(calculated);
      }
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const { handleDragStart: handleEventDragStart, dragState, isDragging: isDayDragActive, justDraggedRef } = useEventDrag({
    hourHeight,
    onDrop: onEventDrop,
  });

  const today = isToday(currentDate);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Day header */}
      {!hideHeader && <WeekDayHeader days={[currentDate]} />}

      {/* Time grid */}
      <div ref={containerRef} className="flex-1 min-h-0 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        <div className="grid [grid-template-columns:var(--cal-time-label-width,72px)_1fr] relative" style={{ minHeight: '100%' }}>
        <TimeLabelColumn hourHeight={hourHeight} />

        {/* Day column */}
        <div className="relative" data-day-col={dayKey}>
          {HOURS.map((hour) => (
            <div
              key={hour}
              data-calendar-cell
              className={cn(
                'border-b border-border cursor-pointer hover:bg-accent/40 transition-colors',
                !isWorkingHour(currentDate, hour, workingHours) && 'bg-zinc-50/60 dark:bg-zinc-900/30',
              )}
              style={{ height: hourHeight }}
              onMouseDown={(e) => { if (!dragState && !isDayResizing) handleCellMouseDown(currentDate, hour, e); }}
            />
          ))}

          {isToday(currentDate) && <CurrentTimeIndicator hourHeight={hourHeight} />}

          {dayEvents.map((evt, i) => {
            const isDragging = dragState?.event.id === evt.id;
            const isEventResizing = dayResizeState?.event.id === evt.id;
            return (
              <TimeSlotEvent
                key={evt.id || i}
                event={evt}
                color={getEventColor(evt, calendarColorMap)}
                onClick={(e) => { if (!dragState && !isSlotDragging && !isDayResizing && !justDraggedRef.current && !justDayResizedRef.current) onSelectEvent(evt, e); }}
                hourHeight={hourHeight}
                onDragStart={(e) => handleEventDragStart(evt, e)}
                onResizeTopStart={(e) => handleDayResizeStart(evt, 'top', e)}
                onResizeBottomStart={(e) => handleDayResizeStart(evt, 'bottom', e)}
                dimmed={isDragging || isEventResizing}
              />
            );
          })}

          {/* Drag ghost */}
          {dragState && (
            <DragGhost
              event={dragState.event}
              color={getEventColor(dragState.event, calendarColorMap)}
              top={dragState.ghostTop}
              duration={dragState.duration}
              hourHeight={hourHeight}
            />
          )}

          {/* Resize ghost */}
          {dayResizeState && (
            <ResizeGhost
              event={dayResizeState.event}
              color={getEventColor(dayResizeState.event, calendarColorMap)}
              top={dayResizeState.topPx}
              height={dayResizeState.heightPx}
              hourHeight={hourHeight}
            />
          )}

          {/* Slot-drag selection preview */}
          {slotSelection && (
            <SlotDragPreview
              topPx={slotSelection.topPx}
              heightPx={slotSelection.heightPx}
              startTime={slotSelection.startTime}
              endTime={slotSelection.endTime}
            />
          )}

          {/* Preview block */}
          {!dragState && !isSlotDragging && !isDayResizing && selectedDate && isSameDay(currentDate, selectedDate) && (
            <TimeSlotPreview
              date={selectedDate}
              endDate={selectedEndDate}
              type={selectedType}
              color={selectedColor}
              hourHeight={hourHeight}
              onMouseDown={onPreviewMouseDown}
              onResize={onPreviewResize}
            />
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

// ============================================================================
// Agenda View
// ============================================================================

function AgendaView({
  currentDate,
  events,
  calendarColorMap,
  onSelectEvent,
}: {
  currentDate: Date;
  events: CalendarEvent[];
  calendarColorMap: Record<string, string>;
  onSelectEvent: (e: CalendarEvent, mouseEvent: React.MouseEvent) => void;
}) {
  const t = getTranslations('weldcalendar');
  // Group events by day
  const grouped = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {};
    const sorted = [...events].sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
    );
    for (const evt of sorted) {
      const key = format(new Date(evt.startTime), 'yyyy-MM-dd');
      if (!map[key]) map[key] = [];
      map[key].push(evt);
    }
    return Object.entries(map);
  }, [events]);

  if (grouped.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        {t.calendarView.noEventsThirtyDays}
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      {grouped.map(([dateKey, dayEvents]) => {
        const date = new Date(dateKey);
        return (
          <div key={dateKey}>
            <div className="flex items-center gap-3 mb-2">
              <div
                className={cn(
                  'w-12 h-12 rounded-xl flex flex-col items-center justify-center',
                  isToday(date) ? 'bg-primary text-primary-foreground' : 'bg-muted',
                )}
              >
                <span className="text-[10px] font-medium leading-none">{format(date, 'EEE')}</span>
                <span className="text-lg font-bold leading-none">{format(date, 'd')}</span>
              </div>
              <div>
                <p className="text-sm font-medium">{format(date, 'EEEE, MMMM d')}</p>
                <p className="text-xs text-muted-foreground">{dayEvents.length} event{dayEvents.length !== 1 ? 's' : ''}</p>
              </div>
            </div>
            <div className="ml-[60px] space-y-1.5">
              {dayEvents.map((evt, i) => {
                const color = getEventColor(evt, calendarColorMap);
                return (
                  <Button
                    variant="ghost"
                    key={evt.id || i}
                    className="w-full flex items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-accent/50 transition-colors"
                    onClick={(e) => onSelectEvent(evt, e)}
                  >
                    <div className="w-1 h-8 rounded-full shrink-0" style={{ backgroundColor: color }} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{evt.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {evt.allDay
                          ? t.calendarView.allDay
                          : `${format(new Date(evt.startTime), 'h:mm a')}${evt.endTime ? ` – ${format(new Date(evt.endTime), 'h:mm a')}` : ''}`}
                        {evt.location ? ` · ${evt.location}` : ''}
                      </p>
                    </div>
                  </Button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// Shared Components
// ============================================================================

function TimeSlotEvent({
  event,
  color,
  onClick,
  hourHeight = 48,
  onDragStart,
  onResizeTopStart,
  onResizeBottomStart,
  dimmed,
}: {
  event: CalendarEvent;
  color: string;
  onClick: (e: React.MouseEvent) => void;
  hourHeight?: number;
  onDragStart?: (e: React.MouseEvent) => void;
  onResizeTopStart?: (e: React.MouseEvent) => void;
  onResizeBottomStart?: (e: React.MouseEvent) => void;
  dimmed?: boolean;
}) {
  const startDate = new Date(event.startTime);
  const endDate = event.endTime ? new Date(event.endTime) : new Date(startDate.getTime() + 60 * 60 * 1000);
  const startHour = startDate.getHours() + startDate.getMinutes() / 60;
  const duration = differenceInMinutes(endDate, startDate);
  const topPx = startHour * hourHeight;
  // Events live in their START day's column, so an event that runs past
  // midnight (or is simply very long) must be clamped to the bottom of the
  // 24-hour grid — otherwise it spills below the final 12 AM gridline and out
  // of the calendar. Keep at least the 22px min so a sliver near midnight stays
  // clickable.
  const maxHeightPx = Math.max(24 * hourHeight - topPx, 22);
  const heightPx = Math.min(Math.max((duration / 60) * hourHeight, 22), maxHeightPx);

  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);
  const holdCleanupRef = useRef<(() => void) | null>(null);

  return (
    <div
      className={cn(
        "absolute left-[3px] right-[3px] rounded-[6px] px-2.5 py-1.5 text-white text-[12px] leading-tight overflow-hidden hover:brightness-95 transition-[filter,opacity] z-[2] border border-white/10 text-left items-start justify-start select-none group/event",
        dimmed && "opacity-40 pointer-events-none",
      )}
      style={{
        backgroundColor: color,
        top: `${topPx}px`,
        height: `${heightPx}px`,
        minHeight: '22px',
        cursor: 'pointer',
      }}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        mouseDownPos.current = { x: e.clientX, y: e.clientY };

        if (!onDragStart) return;
        // Hold-to-drag: release within 150ms = click, hold longer + move = drag
        const origEvent = e;
        let armed = false;
        const holdTimer = setTimeout(() => { armed = true; }, 150);
        const onMove = (me: MouseEvent) => {
          if (!armed) return;
          const dx = Math.abs(me.clientX - (mouseDownPos.current?.x ?? 0));
          const dy = Math.abs(me.clientY - (mouseDownPos.current?.y ?? 0));
          if (dx + dy > 5) {
            cleanupHold();
            mouseDownPos.current = null;
            onDragStart(origEvent);
          }
        };
        const onUp = () => { cleanupHold(); };
        const cleanupHold = () => {
          clearTimeout(holdTimer);
          holdCleanupRef.current = null;
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        holdCleanupRef.current = cleanupHold;
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      }}
      onMouseUp={(e) => {
        // Always clean up hold-to-drag listeners first
        holdCleanupRef.current?.();
        if (!mouseDownPos.current) return;
        e.stopPropagation();
        onClick(e);
        mouseDownPos.current = null;
      }}
    >
      {/* Resize handle at top edge */}
      {onResizeTopStart && heightPx >= 22 && (
        <div
          className="absolute top-0 left-0 right-0 h-2.5 cursor-ns-resize z-10"
          onMouseDown={(e) => {
            e.stopPropagation();
            mouseDownPos.current = null;
            onResizeTopStart(e);
          }}
        >
          <div className="absolute top-1 left-1/2 -translate-x-1/2 w-8 h-[3px] rounded-full bg-white/30 opacity-0 group-hover/event:opacity-100 transition-opacity" />
        </div>
      )}
      {/* Auto-schedule / pin state indicator */}
      {(event.sourceType === 'task' || event.sourceType === 'activity') && (
        <span className="absolute top-1 right-1.5 opacity-70" aria-hidden>
          {event.autoScheduled === false ? (
            <Pin className="h-2.5 w-2.5 text-white" />
          ) : event.autoScheduled === true ? (
            <Sparkles className="h-2.5 w-2.5 text-white" />
          ) : null}
        </span>
      )}
      <span className="font-semibold truncate block pr-4">{event.title}</span>
      {heightPx > 30 && (
        <span className="text-white/70 text-[12px] block mt-[3px]">
          {format(startDate, 'h:mm a')} – {format(endDate, 'h:mm a')}
        </span>
      )}
      {/* Resize handle at bottom edge */}
      {onResizeBottomStart && heightPx >= 22 && (
        <div
          className="absolute bottom-0 left-0 right-0 h-2.5 cursor-ns-resize z-10"
          onMouseDown={(e) => {
            e.stopPropagation();
            mouseDownPos.current = null;
            onResizeBottomStart(e);
          }}
        >
          <div className="absolute bottom-1 left-1/2 -translate-x-1/2 w-8 h-[3px] rounded-full bg-white/30 opacity-0 group-hover/event:opacity-100 transition-opacity" />
        </div>
      )}
    </div>
  );
}

function DragGhost({
  event,
  color,
  top,
  duration,
  hourHeight,
}: {
  event: CalendarEvent;
  color: string;
  top: number;
  duration: number;
  hourHeight: number;
}) {
  const heightPx = Math.max((duration / 60) * hourHeight, 22);
  const hours = Math.floor(top / hourHeight);
  const minutes = Math.round(((top % hourHeight) / hourHeight) * 60 / 15) * 15;
  const ghostDate = new Date();
  ghostDate.setHours(hours, minutes, 0, 0);

  const ghostEnd = new Date(ghostDate.getTime() + duration * 60000);

  return (
    <div
      className="absolute left-[3px] right-[3px] rounded-[6px] px-2.5 py-1.5 text-white text-[12px] leading-tight overflow-hidden z-[4] shadow-lg border-2 border-white/30 pointer-events-none"
      style={{
        backgroundColor: color,
        top: `${top}px`,
        height: `${heightPx}px`,
        minHeight: '22px',
        opacity: 0.85,
      }}
    >
      <span className="font-semibold truncate block">{event.title}</span>
      {heightPx > 30 && (
        <span className="text-white/70 text-[12px] block mt-[3px]">
          {format(ghostDate, 'h:mm a')} – {format(ghostEnd, 'h:mm a')}
        </span>
      )}
    </div>
  );
}

function ResizeGhost({
  event,
  color,
  top,
  height,
  hourHeight,
}: {
  event: CalendarEvent;
  color: string;
  top: number;
  height: number;
  hourHeight: number;
}) {
  const heightPx = Math.max(height, 22);
  const startMinutes = Math.round(((top / hourHeight) * 60) / 15) * 15;
  const endMinutes =
    Math.round((((top + height) / hourHeight) * 60) / 15) * 15;
  const startDate = new Date();
  startDate.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
  const endDate = new Date();
  endDate.setHours(Math.floor(endMinutes / 60), endMinutes % 60, 0, 0);

  return (
    <div
      className="absolute left-[3px] right-[3px] rounded-[6px] px-2.5 py-1.5 text-white text-[12px] leading-tight overflow-hidden z-[4] shadow-lg border-2 border-white/30 pointer-events-none"
      style={{
        backgroundColor: color,
        top: `${top}px`,
        height: `${heightPx}px`,
        minHeight: '22px',
        opacity: 0.85,
      }}
    >
      <span className="font-semibold truncate block">{event.title}</span>
      {heightPx > 30 && (
        <span className="text-white/70 text-[12px] block mt-[3px]">
          {format(startDate, 'h:mm a')} – {format(endDate, 'h:mm a')}
        </span>
      )}
    </div>
  );
}

function CurrentTimeIndicator({ hourHeight = 48 }: { hourHeight?: number }) {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const hours = now.getHours() + now.getMinutes() / 60;
  const topPx = hours * hourHeight;

  return (
    <div
      className="absolute left-0 right-0 z-[3] pointer-events-none"
      style={{ top: `${topPx}px` }}
    >
      <div className="flex items-center">
        <div className="w-2.5 h-2.5 rounded-full bg-red-500 -ml-[5px]" />
        <div className="flex-1 h-[2px] bg-red-500" />
      </div>
    </div>
  );
}

// ============================================================================
// WeldMeet brand glyph — inlined from public/assets/images/weldmeet/icon.svg
// so the field-row component can pass it as a React component (same signature
// as the lucide icons it sits beside). Uses `currentColor` so it picks up the
// `text-muted-foreground` class from the row, matching every other icon.
// ============================================================================

function WeldMeetIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 226.81 136.55"
      className={cn(className, 'opacity-70')}
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M184,49.96l28.37-25.69c5.55-5.03,14.44-1.09,14.44,6.4v75.21c0,7.49-8.88,11.43-14.44,6.4l-28.37-25.69c-1.5-1.36-2.35-3.28-2.35-5.31v-26.03c0-2.02.85-3.95,2.35-5.31Z"
      />
      <rect fill="currentColor" x="0" y="0" width="167.65" height="136.55" rx="36.74" ry="36.74" />
    </svg>
  );
}

// ============================================================================
// Event Detail Panel — slide-in panel matching TaskDetailPanel design.
// Same shell as <TaskDetailPanel>: fixed-right 480px, top-3 right-3 absolute
// header buttons (3-dots menu + close), editable title, description, then
// field rows using the icon + w-32 muted label + value-with-hover-ring pattern
// from TaskDetailContent.
// ============================================================================

function EventDetailPanel({
  event,
  isOpen,
  calendars,
  calendarColorMap,
  width,
  onClose,
  onEdit,
}: {
  event: CalendarEvent | null;
  isOpen: boolean;
  calendars: UserCalendar[];
  calendarColorMap: Record<string, string>;
  width: number;
  onClose: () => void;
  onEdit: () => void;
}) {
  const t = getTranslations('weldcalendar');
  const deleteEvent = useDeleteCalendarEvent();
  const updateEvent = useUpdateCalendarEvent();
  const { createMeetingAndGetUrl, isPending: isCreatingMeeting } = useAutoCreateWeldMeeting();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // Local mirror of the title — we want optimistic updates and to keep the
  // editable cell stable while the API request is in-flight. The prop-sync
  // effect ONLY re-runs when the underlying prop changes (not when isEditing
  // flips), so flipping out of edit mode doesn't clobber the just-typed text
  // before the mutation result lands. Mirrors EditableTitle in TaskDetailPanel.
  const [titleDraft, setTitleDraft] = useState(event?.title ?? '');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const titleRef = useRef<HTMLDivElement>(null);
  const isEditingTitleRef = useRef(isEditingTitle);
  useEffect(() => { isEditingTitleRef.current = isEditingTitle; }, [isEditingTitle]);
  useEffect(() => {
    if (isEditingTitleRef.current) return;
    setTitleDraft(event?.title ?? '');
  }, [event?.title]);

  // Seed + focus + caret-at-end the moment we flip into edit mode. Layout
  // effect (not regular effect) so it runs synchronously after the DOM commit
  // and the user's first click actually lands the caret — no need to click
  // twice.
  useLayoutEffect(() => {
    if (!isEditingTitle) return;
    const el = titleRef.current;
    if (!el) return;
    el.textContent = titleDraft;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditingTitle]);

  const handleTitleSave = useCallback(() => {
    const next = (titleRef.current?.textContent ?? titleDraft).trim();
    setIsEditingTitle(false);
    if (!event?.id || !next || next === event.title) {
      if (titleRef.current) titleRef.current.textContent = event?.title ?? '';
      return;
    }
    setTitleDraft(next);
    updateEvent.mutate({ id: event.id, data: { title: next } });
  }, [event, titleDraft, updateEvent]);

  // Description: same optimistic-edit pattern as the title — click to enter
  // edit mode, Enter or blur to commit, Escape to cancel. Mirrors the task
  // panel's DescriptionField visually (same wrapper + text classes) so the
  // sizing and spacing match exactly. The prop-sync effect uses an isEditing
  // ref instead of a dep so committing the edit (which flips isEditing to
  // false) doesn't immediately clobber the typed text with the stale prop.
  const [descriptionDraft, setDescriptionDraft] = useState(event?.description ?? '');
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const descriptionRef = useRef<HTMLDivElement>(null);
  const isEditingDescriptionRef = useRef(isEditingDescription);
  useEffect(() => { isEditingDescriptionRef.current = isEditingDescription; }, [isEditingDescription]);
  useEffect(() => {
    if (isEditingDescriptionRef.current) return;
    setDescriptionDraft(event?.description ?? '');
  }, [event?.description]);

  // Seed the editor and place caret at end the moment we flip into edit mode.
  // useLayoutEffect runs synchronously after DOM commit so the caret lands on
  // the user's first click — no need to click twice to start typing.
  useLayoutEffect(() => {
    if (!isEditingDescription) return;
    const el = descriptionRef.current;
    if (!el) return;
    el.textContent = descriptionDraft;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditingDescription]);

  const handleDescriptionSave = useCallback(() => {
    const next = (descriptionRef.current?.textContent ?? descriptionDraft).trim();
    setIsEditingDescription(false);
    if (!event?.id || next === (event.description ?? '')) {
      if (descriptionRef.current) descriptionRef.current.textContent = event?.description ?? '';
      return;
    }
    setDescriptionDraft(next);
    updateEvent.mutate({ id: event.id, data: { description: next } });
  }, [event, descriptionDraft, updateEvent]);

  if (!event) {
    return (
      <div
        className={cn(
          'fixed bg-background z-50 flex flex-col border-l border-border',
          'inset-0 md:inset-auto md:right-0 md:top-[60px] md:bottom-0',
          'transition-transform duration-300 ease-[cubic-bezier(0.25,0.1,0.25,1)]',
          isOpen ? 'translate-x-0' : 'translate-x-full',
          !isOpen && 'pointer-events-none',
        )}
        style={{ width }}
      />
    );
  }

  const color = getEventColor(event, calendarColorMap);
  const calendar = calendars.find((c) => c.id === event.calendarId);
  const hasAttendees = !!event.attendees?.length;

  const handleDelete = async (sendNotification?: boolean) => {
    if (event.id) {
      await deleteEvent.mutateAsync({ id: event.id, sendNotification });
      onClose();
    }
  };

  return (
    <div
      className={cn(
        'fixed bg-background z-50 flex flex-col border-l border-border overflow-x-hidden',
        'inset-0 w-full',
        'md:inset-auto md:right-0 md:top-[60px] md:bottom-0 md:w-[var(--event-panel-width)]',
        'transition-transform duration-300 ease-[cubic-bezier(0.25,0.1,0.25,1)]',
        isOpen ? 'translate-x-0' : 'translate-x-full',
        !isOpen && 'pointer-events-none',
      )}
      style={{ ['--event-panel-width' as any]: `${width}px` }}
    >
      <EventNotificationDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        onConfirm={async (sendNotification) => {
          await handleDelete(sendNotification);
          setShowDeleteDialog(false);
        }}
        isPending={deleteEvent.isPending}
        variant="delete"
      />

      {/* Header — title + actions (3-dots dropdown + close X). Mirrors
          TaskDetailPanel's header geometry so both panels feel identical. */}
      <div className="group/header relative px-3 md:px-4 py-3 flex-shrink-0">
        <div className="absolute top-3 right-3 md:right-4 flex items-center gap-0.5 md:gap-1 flex-shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="p-1.5 hover:bg-muted data-[state=open]:bg-muted rounded-md transition-colors focus:outline-none focus-visible:outline-none">
                <EllipsisVertical className="h-4 w-4 text-gray-500" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="h-4 w-4 mr-0.5" />
                {t.eventPreview.editEvent}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950"
                onClick={() => hasAttendees ? setShowDeleteDialog(true) : handleDelete()}
              >
                <Trash2 className="h-4 w-4 mr-0.5 text-red-600" />
                {t.eventPreview.deleteEvent}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            className="p-1.5 hover:bg-muted rounded-md transition-colors"
            onClick={onClose}
            title={t.misc.close}
          >
            <X className="h-4 w-4 text-gray-500" />
          </Button>
        </div>

        {/* Title row — color accent dot + editable title.
            pr-20 reserves space for the absolute-positioned action buttons. */}
        <div className="flex items-start gap-2 pr-20 min-w-0">
          <div
            className="h-3 w-3 rounded-[4px] shrink-0 mt-1.5"
            style={{ backgroundColor: color }}
          />
          <div
            ref={titleRef}
            contentEditable={isEditingTitle}
            suppressContentEditableWarning
            onClick={() => { if (!isEditingTitle) setIsEditingTitle(true); }}
            onBlur={handleTitleSave}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.target as HTMLDivElement).blur();
              }
              if (e.key === 'Escape') {
                if (titleRef.current) titleRef.current.textContent = event.title;
                setIsEditingTitle(false);
              }
            }}
            className={cn(
              'text-[15px] font-medium leading-normal text-foreground break-words min-w-0 rounded-md px-1.5 py-0.5 -mx-1.5 -my-0.5 border outline-none focus:outline-none focus-visible:outline-none whitespace-pre-wrap flex-1 transition-colors',
              isEditingTitle
                ? 'border-gray-400 dark:border-gray-500 cursor-text'
                : 'border-transparent hover:border-gray-200 dark:hover:border-gray-700 cursor-text',
            )}
          >
            {titleDraft}
          </div>
        </div>
      </div>

      {/* Description under title — matches TaskDetailPanel's DescriptionField
          display state: same outer wrapper padding, same hover-border affordance,
          same text sizing. Click anywhere on the box to edit inline; Enter or
          blur commits; Escape cancels. */}
      <div className="px-1 md:px-2 -mt-2 pb-3">
        <div
          className={cn(
            'relative w-full rounded-md border transition-colors overflow-hidden',
            isEditingDescription
              ? 'border-gray-400 dark:border-gray-500'
              : 'border-transparent hover:border-gray-200 dark:hover:border-gray-700 cursor-pointer',
          )}
          onClick={() => { if (!isEditingDescription) setIsEditingDescription(true); }}
        >
          <div
            ref={descriptionRef}
            contentEditable={isEditingDescription}
            suppressContentEditableWarning
            onBlur={handleDescriptionSave}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                if (descriptionRef.current) descriptionRef.current.textContent = event.description ?? '';
                setIsEditingDescription(false);
              }
              // Enter inserts newlines (descriptions support multi-line) — only
              // Cmd/Ctrl+Enter commits early.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                (e.target as HTMLDivElement).blur();
              }
            }}
            className="w-full text-sm leading-[1.5] px-2 py-1.5 bg-transparent outline-none break-words whitespace-pre-wrap min-h-[32px] text-muted-foreground"
          >
            {isEditingDescription ? null : (descriptionDraft || t.eventPreview.addDescription)}
          </div>
        </div>
      </div>

      {/* Tabs + content. Mirrors TaskDetailContent's layout: PageTabs row at the
          top with the field-visibility gear at the right, then the field rows
          below in a `space-y-1` stack. */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="overflow-hidden min-w-0">
          <PageTabs
            tabs={[
              { id: 'details', label: t.eventPreview.tabDetails, icon: ListCollapse },
            ]}
            activeTab="details"
            className="border-border"
            innerClassName="px-4"
          />

          <div className="p-4">
            <div className="space-y-1">
              {/* Type — popover selector */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 w-32 flex-shrink-0">
                  <CircleDot className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">{t.eventPreview.fieldType}</span>
                </div>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" className="h-8 text-sm text-left cursor-pointer inline-flex items-center self-start group/field">
                      <span
                        className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none capitalize ring-1 ring-transparent group-hover/field:ring-gray-300 dark:group-hover/field:ring-gray-600 transition-shadow"
                        style={{ backgroundColor: `${color}20`, color }}
                      >
                        {event.type}
                      </span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-1" align="start">
                    {EVENT_TYPE_OPTIONS.map(({ label, value }) => (
                      <Button
                        variant="ghost"
                        key={value}
                        onClick={() => event.id && updateEvent.mutate({ id: event.id, data: { type: value as any } })}
                        className="flex items-center justify-between w-full px-1.5 py-1.5 text-sm text-left hover:bg-muted rounded gap-3 min-w-[140px]"
                      >
                        <span>{label}</span>
                        {event.type === value && <Check className="h-3.5 w-3.5 text-primary" />}
                      </Button>
                    ))}
                  </PopoverContent>
                </Popover>
              </div>

              {/* Calendar — popover selector */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 w-32 flex-shrink-0">
                  <CalendarDays className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">{t.eventPreview.fieldCalendar}</span>
                </div>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" className="h-8 text-sm text-left cursor-pointer inline-flex items-center self-start group/field">
                      {calendar ? (
                        <span className="inline-flex items-center gap-2 px-1.5 -mx-1.5 rounded ring-1 ring-transparent group-hover/field:ring-gray-300 dark:group-hover/field:ring-gray-600 h-[22px] transition-shadow">
                          <div
                            className="h-2.5 w-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: calendar.color || '#3b82f6' }}
                          />
                          <span>{calendar.name}</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground group-hover/field:underline">{t.eventPreview.setCalendar}</span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-1" align="start">
                    {calendars.map((cal) => (
                      <Button
                        variant="ghost"
                        key={cal.id}
                        onClick={() => event.id && updateEvent.mutate({ id: event.id, data: { calendarId: cal.id } as any })}
                        className="flex items-center justify-between w-full px-1.5 py-1.5 text-sm text-left hover:bg-muted rounded gap-3 min-w-[160px]"
                      >
                        <span className="inline-flex items-center gap-2">
                          <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: cal.color || '#3b82f6' }} />
                          {cal.name}
                        </span>
                        {event.calendarId === cal.id && <Check className="h-3.5 w-3.5 text-primary" />}
                      </Button>
                    ))}
                  </PopoverContent>
                </Popover>
              </div>

              {/* When — date/time editing is complex; click opens the full EventDialog */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 w-32 flex-shrink-0">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">{t.eventPreview.fieldWhen}</span>
                </div>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={onEdit}
                  className="h-8 text-sm inline-flex items-center self-start group/field text-left"
                >
                  <span className="px-1.5 -mx-1.5 rounded ring-1 ring-transparent group-hover/field:ring-gray-300 dark:group-hover/field:ring-gray-600 h-[22px] inline-flex items-center transition-shadow">
                    {event.allDay
                      ? format(new Date(event.startTime), 'EEEE, MMMM d')
                      : `${format(new Date(event.startTime), 'EEE, MMM d · h:mm a')}${event.endTime ? ` – ${format(new Date(event.endTime), 'h:mm a')}` : ''}`}
                  </span>
                </Button>
              </div>

              {/* Priority — popover selector */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 w-32 flex-shrink-0">
                  <Flag className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">{t.eventPreview.fieldPriority}</span>
                </div>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" className="h-8 text-sm text-left cursor-pointer inline-flex items-center self-start group/field">
                      {event.priority && event.priority !== 'normal' ? (
                        <span className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none bg-muted capitalize ring-1 ring-transparent group-hover/field:ring-gray-300 dark:group-hover/field:ring-gray-600 transition-shadow">
                          {event.priority}
                        </span>
                      ) : (
                        <span className="text-muted-foreground group-hover/field:underline">{t.eventPreview.setPriority}</span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-1" align="start">
                    {EVENT_PRIORITY_OPTIONS.map(({ label, value }) => (
                      <Button
                        variant="ghost"
                        key={value}
                        onClick={() => event.id && updateEvent.mutate({ id: event.id, data: { priority: value as any } })}
                        className="flex items-center justify-between w-full px-1.5 py-1.5 text-sm text-left hover:bg-muted rounded gap-3 min-w-[140px]"
                      >
                        <span>{label}</span>
                        {event.priority === value && <Check className="h-3.5 w-3.5 text-primary" />}
                      </Button>
                    ))}
                  </PopoverContent>
                </Popover>
              </div>

              {/* Location — inline text editor */}
              <EventInlineTextField
                icon={MapPin}
                label={t.eventPreview.fieldLocation}
                value={event.location ?? ''}
                placeholder={t.eventPreview.setLocation}
                onSave={(next) => event.id && updateEvent.mutate({ id: event.id, data: { location: next || undefined } as any })}
              />

              {/* Meeting — empty-state click auto-generates a WeldMeet link
                  and saves it to the event. When filled, the value renders as
                  a clickable link that opens in a new tab. */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 w-32 flex-shrink-0">
                  <WeldMeetIcon className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">{t.eventPreview.fieldMeeting}</span>
                </div>
                <div className="h-8 text-sm inline-flex items-center self-start group/field min-w-0">
                  {event.meetingUrl ? (
                    <a
                      href={event.meetingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline truncate px-1.5 -mx-1.5 rounded ring-1 ring-transparent group-hover/field:ring-gray-300 dark:group-hover/field:ring-gray-600 h-[22px] inline-flex items-center transition-shadow max-w-full"
                    >
                      {event.meetingUrl}
                    </a>
                  ) : (
                    <Button
                      variant="ghost"
                      type="button"
                      disabled={isCreatingMeeting || !event.id}
                      onClick={async () => {
                        if (!event.id) return;
                        const result = await createMeetingAndGetUrl(event.title || t.misc.newMeetingTitle);
                        if (result) {
                          updateEvent.mutate({
                            id: event.id,
                            data: { meetingUrl: result.url, isVirtual: true } as any,
                          });
                        }
                      }}
                      className="text-muted-foreground group-hover/field:underline disabled:opacity-50 disabled:cursor-wait inline-flex items-center gap-1.5"
                    >
                      {isCreatingMeeting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {isCreatingMeeting ? t.eventPreview.generatingLink : t.eventPreview.generateWeldMeet}
                    </Button>
                  )}
                </div>
              </div>

              {/* Attendees — popover with the same GuestSearchInput as the
                  quick-create card. Add via search; remove with the X chip. */}
              <EventAttendeesField
                attendees={event.attendees ?? []}
                onChange={(next) => event.id && updateEvent.mutate({
                  id: event.id,
                  data: { attendees: next.length ? next : undefined } as any,
                })}
              />

              {/* Created */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 w-32 flex-shrink-0">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">{t.eventPreview.fieldCreated}</span>
                </div>
                <div className="flex-1 h-8 text-sm rounded-md px-2 -mx-2 flex items-center">
                  <span className="text-muted-foreground">
                    {event.createdAt ? format(new Date(event.createdAt), 'MMM d, yyyy') : '—'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// EventInlineTextField — single-row text field used in the EventDetailPanel
// for fields like Location and Meeting URL. Click to enter edit mode (input
// appears in place), Enter or blur commits, Escape cancels. Mirrors the same
// optimistic-edit pattern used by the title/description fields above.
// ============================================================================

function EventInlineTextField({
  icon: Icon,
  label,
  value,
  placeholder,
  renderDisplay,
  onSave,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  placeholder: string;
  renderDisplay?: (value: string) => React.ReactNode;
  onSave: (next: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync from prop only when the prop itself changes — flipping edit mode off
  // shouldn't blow away the optimistic value before the mutation lands.
  const isEditingRef = useRef(isEditing);
  useEffect(() => { isEditingRef.current = isEditing; }, [isEditing]);
  useEffect(() => {
    if (isEditingRef.current) return;
    setDraft(value);
  }, [value]);

  // Focus + select on entering edit mode (sync, so the user's first click
  // lands the caret).
  useLayoutEffect(() => {
    if (!isEditing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [isEditing]);

  const handleSave = () => {
    const next = draft.trim();
    setIsEditing(false);
    if (next === value) {
      setDraft(value);
      return;
    }
    setDraft(next);
    onSave(next);
  };

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2 w-32 flex-shrink-0">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      {isEditing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === 'Escape') {
              setDraft(value);
              setIsEditing(false);
            }
          }}
          placeholder={placeholder}
          className="flex-1 h-8 text-sm rounded-md border border-gray-400 dark:border-gray-500 bg-transparent px-2 -mx-2 outline-none focus:outline-none"
        />
      ) : (
        <Button
          variant="ghost"
          type="button"
          onClick={() => setIsEditing(true)}
          className="h-8 text-sm inline-flex items-center self-start group/field min-w-0 text-left flex-1"
        >
          {value ? (
            <span className="px-1.5 -mx-1.5 rounded ring-1 ring-transparent group-hover/field:ring-gray-300 dark:group-hover/field:ring-gray-600 h-[22px] inline-flex items-center transition-shadow truncate max-w-full">
              {renderDisplay ? renderDisplay(value) : value}
            </span>
          ) : (
            <span className="text-muted-foreground group-hover/field:underline">{placeholder}</span>
          )}
        </Button>
      )}
    </div>
  );
}

// ============================================================================
// EventAttendeesField — Attendees row in the EventDetailPanel. Mirrors the
// Assignees field in TaskDetailContent: vertical stack of avatar+name rows
// each with a hover X, a trailing + button on group-hover, and a Command
// picker inside a Popover with avatar+name+check rows. No separate dialog.
// ============================================================================

const ATTENDEE_AVATAR_PALETTE = [
  '#0d9488', '#16a34a', '#2563eb', '#7c3aed', '#db2777',
  '#dc2626', '#ea580c', '#ca8a04', '#0891b2', '#4f46e5',
];

function attendeeFallbackColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return ATTENDEE_AVATAR_PALETTE[Math.abs(hash) % ATTENDEE_AVATAR_PALETTE.length]!;
}

function AttendeeAvatar({
  email,
  name,
  avatar,
  className,
}: {
  email: string;
  name?: string;
  avatar?: string;
  className?: string;
}) {
  const seed = email || name || '?';
  const bg = attendeeFallbackColor(seed);
  const initial = (name || email || '?').charAt(0).toUpperCase();
  return (
    <Avatar className={cn('h-5 w-5 rounded-[7px]', className)}>
      <AvatarImage src={avatar} className="rounded-[7px]" />
      <AvatarFallback
        className="text-[10px] rounded-[7px] text-white font-medium"
        style={{ backgroundColor: bg }}
      >
        {initial}
      </AvatarFallback>
    </Avatar>
  );
}

function EventAttendeesField({
  attendees,
  onChange,
}: {
  attendees: { email: string; name?: string; status?: string; role?: string }[];
  onChange: (next: { email: string; name?: string }[]) => void;
}) {
  const t = getTranslations('weldcalendar');
  const { data: peopleData } = usePeople({ limit: 50 });
  const { data: membersData } = useWorkspaceMembers(1, 50);
  const contacts = (peopleData?.data || []) as Person[];
  const members = (membersData?.data || []) as any[];

  // Unified list of pickable people: workspace members first, then contacts.
  // Dedupe by lower-cased email — when the same person is both a member and a
  // contact, two CommandItems with the same `value` confuse cmdk's filter and
  // make clicks misfire.
  const options = useMemo(() => {
    const seen = new Set<string>();
    const items: { id: string; name: string; email: string; avatar?: string }[] = [];
    for (const m of members) {
      const name = m.name || [m.firstName, m.lastName].filter(Boolean).join(' ').trim() || m.email || '';
      const email = (m.email || '').toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      items.push({ id: `member-${m.id}`, name: name || m.email, email: m.email, avatar: m.picture });
    }
    for (const c of contacts) {
      const email = (c.email || '').toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      const name = c.fullName || `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || c.email || '';
      items.push({ id: `contact-${c.id}`, name, email: c.email ?? '' });
    }
    return items;
  }, [members, contacts]);

  const isSelected = (email: string) =>
    attendees.some((a) => a.email.toLowerCase() === email.toLowerCase());

  const toggle = (email: string, name: string) => {
    if (isSelected(email)) {
      onChange(
        attendees
          .filter((a) => a.email.toLowerCase() !== email.toLowerCase())
          .map((a) => ({ email: a.email, name: a.name })),
      );
    } else {
      onChange([
        ...attendees.map((a) => ({ email: a.email, name: a.name })),
        { email, name },
      ]);
    }
  };

  const removeOne = (email: string) => {
    onChange(
      attendees
        .filter((a) => a.email.toLowerCase() !== email.toLowerCase())
        .map((a) => ({ email: a.email, name: a.name })),
    );
  };

  const hasAny = attendees.length > 0;

  return (
    <div className="flex items-start gap-3 group/assignees">
      <div className="flex items-center gap-2 w-32 flex-shrink-0 h-8">
        <Users className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t.eventPreview.fieldAttendees}</span>
      </div>
      <div className="flex-1 min-w-0">
        <Popover>
          <PopoverTrigger asChild>
            <div
              role="button"
              tabIndex={0}
              className={cn(
                'text-sm cursor-pointer flex justify-between gap-2 self-start outline-none focus-visible:ring-2 focus-visible:ring-ring w-full group/field',
                // Single-line empty state: center vertically inside h-8 so it
                // sits on the same baseline as the "Attendees" label.
                // Filled state: top-align so the avatar stack can grow downward.
                hasAny ? 'items-start min-h-8' : 'items-center h-8',
              )}
            >
              {hasAny ? (
                <>
                  <div className="flex flex-col gap-1 min-w-0">
                    {attendees.map((a) => (
                      <div
                        key={a.email}
                        className="flex items-center gap-2 pl-0.5 pr-1.5 py-0.5 -ml-0.5 rounded-[6px] group/assignee"
                      >
                        <AttendeeAvatar email={a.email} name={a.name} />
                        <span className="text-sm text-gray-600 dark:text-muted-foreground truncate max-w-[150px]">
                          {a.name || a.email}
                        </span>
                        <Button
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            removeOne(a.email);
                          }}
                          className="inline-flex items-center justify-center h-6 w-6 -ml-1 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground opacity-0 group-hover/assignee:opacity-100 transition-[opacity,color,background-color]"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <span
                    className="inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-[opacity,color,background-color] flex-shrink-0 opacity-0 group-hover/field:opacity-100"
                    aria-label={t.eventPreview.addAttendee}
                  >
                    <Plus className="h-4 w-4" />
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground group-hover/field:underline">{t.eventPreview.addAttendees}</span>
              )}
            </div>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-0" align="start">
            <Command>
              <CommandInput placeholder={t.eventPreview.searchAttendees} />
              <CommandList className="max-h-[260px] p-1">
                <CommandEmpty>{t.eventPreview.noPeopleFound}</CommandEmpty>
                {options.map((o) => {
                  const selected = isSelected(o.email);
                  return (
                    <CommandItem
                      key={o.id}
                      value={`${o.name} ${o.email}`}
                      onSelect={() => toggle(o.email, o.name)}
                      className="flex items-center justify-between gap-2 px-1.5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <AttendeeAvatar email={o.email} name={o.name} avatar={o.avatar} />
                        <span className="truncate">{o.name}</span>
                      </div>
                      {selected && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                    </CommandItem>
                  );
                })}
                {hasAny && (
                  <>
                    <div className="h-px bg-border my-1" />
                    <CommandItem
                      value="__clear__"
                      onSelect={() => onChange([])}
                      className="px-1.5 text-red-600 data-[selected=true]:text-red-600 data-[selected=true]:bg-red-50 dark:data-[selected=true]:bg-red-950"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="h-5 w-5 flex items-center justify-center shrink-0">
                          <Trash2 className="h-3.5 w-3.5 text-red-600" />
                        </div>
                        <span>{t.eventPreview.clearAll}</span>
                      </div>
                    </CommandItem>
                  </>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

// ============================================================================
// Guest Search Input (search contacts by name/email)
// ============================================================================

interface GuestResult {
  id: string;
  name: string;
  email: string;
  initial: string;
  type: 'member' | 'contact';
}

function GuestSearchInput({
  value,
  onChange,
  selectedIds,
  onSelect,
  onBlurAway,
}: {
  value: string;
  onChange: (v: string) => void;
  selectedIds: string[];
  onSelect: (guest: { id: string; name: string; email: string }) => void;
  /** Called when focus leaves the input (click away) — collapses the row. */
  onBlurAway?: () => void;
}) {
  const t = getTranslations('weldcalendar');
  const [open, setOpen] = useState(false);

  const { data: peopleData } = usePeople(
    value.length >= 1 ? { search: value, limit: 6 } : { limit: 6 },
  );
  const { data: membersData } = useWorkspaceMembers(1, 50);

  const contacts = (peopleData?.data || []) as Person[];
  const members = (membersData?.data || []) as any[];

  // Build unified results
  const results = useMemo(() => {
    const search = value.toLowerCase();
    const items: GuestResult[] = [];

    // Team members first
    for (const m of members) {
      if (selectedIds.includes(`member-${m.id}`)) continue;
      const name = m.name || m.email || '';
      const email = m.email || '';
      if (search && !name.toLowerCase().includes(search) && !email.toLowerCase().includes(search)) continue;
      items.push({
        id: `member-${m.id}`,
        name,
        email,
        initial: (name[0] || email[0] || '?').toUpperCase(),
        type: 'member',
      });
    }

    // Then contacts
    for (const c of contacts) {
      if (selectedIds.includes(`contact-${c.id}`)) continue;
      const name = c.fullName || `${c.firstName} ${c.lastName}`.trim();
      items.push({
        id: `contact-${c.id}`,
        name,
        email: c.email ?? '',
        initial: (c.firstName?.[0] || c.email?.[0] || '?').toUpperCase(),
        type: 'contact',
      });
    }

    return items.slice(0, 8);
  }, [contacts, members, selectedIds, value]);

  const showDropdown = open && value.length >= 1 && results.length > 0;
  const hasMembers = results.some((r) => r.type === 'member');
  const hasContacts = results.some((r) => r.type === 'contact');

  return (
    <div className="relative">
      <Input
        placeholder={t.eventPreview.searchMembersContacts}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => { setOpen(false); onBlurAway?.(); }, 150)}
        className="h-7 text-sm shadow-none border-0 px-0 focus-visible:ring-0"
        autoFocus
      />
      {showDropdown && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-popover border rounded-lg shadow-lg z-50 max-h-[240px] overflow-y-auto">
          {hasMembers && (
            <div className="px-3 pt-2 pb-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{t.eventPreview.teamMembersGroup}</span>
            </div>
          )}
          {results.filter((r) => r.type === 'member').map((item) => (
            <Button
              variant="ghost"
              key={item.id}
              className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-accent transition-colors"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect({ id: item.id, name: item.name, email: item.email });
                setOpen(false);
              }}
            >
              <div className="h-[24px] w-[24px] rounded-[5.5px] bg-blue-500/10 flex items-center justify-center shrink-0">
                <span className="text-xs font-medium text-blue-600">{item.initial}</span>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{item.name}</p>
                <p className="text-xs text-muted-foreground truncate">{item.email}</p>
              </div>
            </Button>
          ))}
          {hasMembers && hasContacts && <Separator />}
          {hasContacts && (
            <div className="px-3 pt-2 pb-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{t.eventPreview.contactsGroup}</span>
            </div>
          )}
          {results.filter((r) => r.type === 'contact').map((item) => (
            <Button
              variant="ghost"
              key={item.id}
              className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-accent transition-colors"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect({ id: item.id, name: item.name, email: item.email });
                setOpen(false);
              }}
            >
              <div className="h-[24px] w-[24px] rounded-[5.5px] bg-primary/10 flex items-center justify-center shrink-0">
                <span className="text-xs font-medium text-primary">{item.initial}</span>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{item.name}</p>
                <p className="text-xs text-muted-foreground truncate">{item.email}</p>
              </div>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Date Picker Field (shadcn Calendar popover)
// ============================================================================

function formatDateDisplay(date: Date | undefined) {
  if (!date) return '';
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  });
}

function DatePickerField({
  value,
  onChange,
}: {
  value: Date;
  onChange: (date: Date) => void;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState<Date | undefined>(value);

  useEffect(() => {
    setMonth(value);
  }, [value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          type="button"
          className="h-[34px] flex-1 text-sm font-normal text-left rounded-md border border-input bg-background px-2.5 hover:bg-accent/50 transition-colors focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {formatDateDisplay(value)}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto overflow-hidden p-0 z-[80]"
        align="start"
        sideOffset={4}
      >
        <Calendar
          mode="single"
          selected={value}
          month={month}
          onMonthChange={setMonth}
          onSelect={(date) => {
            if (date) onChange(date);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

// ============================================================================
// Inline Select Row (Popover-based select for quick-create card)
// ============================================================================

function InlineSelectRow({
  icon,
  value,
  displayValue,
  options,
  onChange,
}: {
  icon: React.ReactNode;
  value: string;
  displayValue: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const handleClick = () => {
    if (rowRef.current) {
      const rect = rowRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left + 44 });
    }
    setOpen(!open);
  };

  return (
    <>
      <div
        ref={rowRef}
        className="flex items-center gap-3 px-4 py-[10px] cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={handleClick}
      >
        {icon}
        <span className="text-sm text-foreground h-7 flex items-center">{displayValue}</span>
      </div>
      {open && (
        <>
          <div className="fixed inset-0 z-[79]" onClick={() => setOpen(false)} />
          <div
            className="fixed z-[80] w-[160px] p-1 bg-popover border rounded-md shadow-md animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150"
            style={{ top: pos.top, left: pos.left }}
          >
            {options.map((opt) => (
              <Button
                variant="ghost"
                key={opt.value}
                className={cn(
                  'w-full text-left text-sm px-3 py-1.5 rounded-md transition-colors',
                  value === opt.value ? 'bg-accent font-medium' : 'hover:bg-accent/50',
                )}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

// ============================================================================
// Inline Date/Time Row (fixed dropdown with calendar + time input)
// ============================================================================

function InlineDateTimeRow({
  icon,
  date,
  time,
  onDateChange,
  onTimeChange,
  placeholder,
}: {
  icon: React.ReactNode;
  date?: Date;
  time: string;
  onDateChange: (d: Date) => void;
  onTimeChange: (t: string) => void;
  placeholder: string;
}) {
  const t = getTranslations('weldcalendar');
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState<Date | undefined>(date || new Date());
  const rowRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (date) setMonth(date);
  }, [date]);

  const handleClick = () => {
    if (rowRef.current) {
      const rect = rowRef.current.getBoundingClientRect();
      let top = rect.bottom + 4;
      let left = rect.left + 44;
      // Keep within viewport
      if (top + 340 > window.innerHeight) top = rect.top - 344;
      if (left + 280 > window.innerWidth) left = window.innerWidth - 290;
      setPos({ top, left });
    }
    setOpen(!open);
  };

  return (
    <>
      <div
        ref={rowRef}
        className="flex items-center gap-3 px-4 py-[10px] cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={handleClick}
      >
        {icon}
        <span className="text-sm text-foreground h-7 flex items-center">
          {date ? format(date, 'EEEE, MMM d') : placeholder}
          {time && <span className="text-muted-foreground ml-1">· {time}</span>}
        </span>
      </div>
      {open && (
        <>
          <div className="fixed inset-0 z-[79]" onClick={() => setOpen(false)} />
          <div
            className="fixed z-[80] bg-popover border rounded-md shadow-md animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150 overflow-hidden"
            style={{ top: pos.top, left: pos.left }}
          >
            <Calendar
              mode="single"
              selected={date}
              month={month}
              onMonthChange={setMonth}
              onSelect={(d) => {
                if (d) onDateChange(d);
              }}
            />
            <div className="border-t px-3 py-2.5 flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                type="time"
                value={time}
                onChange={(e) => onTimeChange(e.target.value)}
                className="text-sm bg-transparent focus:outline-none flex-1"
                placeholder={t.misc.addTime}
              />
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ============================================================================
// Calendar Select Row (pick which calendar to save to)
// ============================================================================

function CalendarSelectRow({
  calendars,
  selectedId,
  onChange,
}: {
  calendars: any[];
  selectedId?: string;
  onChange: (id: string) => void;
}) {
  const t = getTranslations('weldcalendar');
  const [open, setOpen] = useState(false);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const selected = calendars.find((c) => c.id === selectedId) || calendars[0];

  const handleClick = () => {
    if (rowRef.current) {
      const rect = rowRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left + 44 });
    }
    setOpen(!open);
  };

  return (
    // Single wrapper so the open dropdown's fixed overlay/popover don't become
    // extra `divide-y` siblings in the parent card (which would draw a stray
    // divider line under this row while the menu is open).
    <div>
      <div
        ref={rowRef}
        className="flex items-center gap-3 px-4 py-[10px] cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={handleClick}
      >
        <div className="h-3 w-3 rounded-[4px] shrink-0" style={{ backgroundColor: selected?.color || '#3b82f6' }} />
        <div className="h-7 flex items-center gap-2">
          <span className="text-sm">{selected?.name || t.misc.defaultCalendar}</span>
        </div>
      </div>
      {open && (
        <>
          <div className="fixed inset-0 z-[79]" onClick={() => setOpen(false)} />
          <div
            className="fixed z-[80] w-[200px] p-1 bg-popover border rounded-md shadow-md animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150"
            style={{ top: pos.top, left: pos.left }}
          >
            {calendars.map((cal) => (
              <Button
                variant="ghost"
                key={cal.id}
                className={cn(
                  'w-full text-left text-sm px-3 py-1.5 rounded-md transition-colors flex items-center gap-2',
                  selectedId === cal.id ? 'bg-accent font-medium' : 'hover:bg-accent/50',
                )}
                onClick={() => {
                  onChange(cal.id);
                  setOpen(false);
                }}
              >
                <div className="h-3 w-3 rounded-[4px] shrink-0" style={{ backgroundColor: cal.color || '#3b82f6' }} />
                {cal.name}
              </Button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================================
// 4 Day View
// ============================================================================

function FourDayView({
  currentDate,
  events,
  calendarColorMap,
  onSelectEvent,
  onSelectSlot,
  selectedDate,
  selectedEndDate,
  selectedType,
  selectedColor,
  onEventDrop,
  workingHours,
  onPreviewMouseDown,
  onPreviewResize,
}: {
  currentDate: Date;
  events: CalendarEvent[];
  calendarColorMap: Record<string, string>;
  onSelectEvent: (e: CalendarEvent, mouseEvent: React.MouseEvent) => void;
  onSelectSlot: (start: Date, end: Date, e: React.MouseEvent | MouseEvent, wasDrag?: boolean) => void;
  selectedDate?: Date;
  selectedEndDate?: Date;
  selectedType?: string;
  selectedColor?: string;
  onEventDrop: (event: CalendarEvent, newStart: Date, newEnd: Date) => void;
  workingHours?: WorkingHours | null;
  onPreviewMouseDown?: (e: React.MouseEvent) => void;
  onPreviewResize?: (edge: 'top' | 'bottom', e: React.MouseEvent) => void;
}) {
  const days = Array.from({ length: 4 }, (_, i) => addDays(currentDate, i));
  const containerRef = useRef<HTMLDivElement>(null);
  const [hourHeight, setHourHeight] = useState(48);

  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        const available = containerRef.current.clientHeight;
        const calculated = Math.max(48, Math.floor(available / 24));
        setHourHeight(calculated);
      }
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const { handleCellMouseDown, isSlotDragging, slotSelection } = useSlotDrag({
    hourHeight,
    onSelectSlot,
  });

  const { handleResizeStart: handleFourDayResizeStart, resizeState: fourDayResizeState, isResizing: isFourDayResizing, justResizedRef: justFourDayResizedRef } = useEventResize({
    hourHeight,
    onResize: onEventDrop,
  });

  const { handleDragStart: handleEventDragStart, dragState, isDragging: isFourDayDragActive, justDraggedRef } = useEventDrag({
    hourHeight,
    onDrop: onEventDrop,
  });

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <WeekDayHeader days={days} />
      <div ref={containerRef} className="flex-1 min-h-0 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        <div className="grid [grid-template-columns:var(--cal-time-label-width,72px)_repeat(4,1fr)] relative" style={{ minHeight: '100%' }}>
          <TimeLabelColumn hourHeight={hourHeight} />
          {days.map((day) => {
            const dayKey = format(day, 'yyyy-MM-dd');
            const today = isToday(day);
            const dayEvents = events.filter(
              (e) => format(new Date(e.startTime), 'yyyy-MM-dd') === dayKey && !e.allDay,
            );
            return (
              <div key={dayKey} data-day-col={dayKey} className={cn('border-r border-border last:border-r-0 relative', today && 'bg-primary/[0.01]')}>
                {HOURS.map((hour) => (
                  <div
                    key={hour}
                    data-calendar-cell
                    className={cn(
                      'border-b border-border cursor-pointer hover:bg-accent/40 transition-colors',
                      !isWorkingHour(day, hour, workingHours) && 'bg-zinc-50/60 dark:bg-zinc-900/30',
                    )}
                    style={{ height: hourHeight }}
                    onMouseDown={(e) => { if (!dragState && !isFourDayResizing) handleCellMouseDown(day, hour, e); }}
                  />
                ))}
                {today && <CurrentTimeIndicator hourHeight={hourHeight} />}
                {dayEvents.map((evt, i) => {
                  const isDragging = dragState?.event.id === evt.id;
                  const isEventResizing = fourDayResizeState?.event.id === evt.id;
                  return (
                    <TimeSlotEvent
                      key={evt.id || i}
                      event={evt}
                      color={getEventColor(evt, calendarColorMap)}
                      onClick={(e) => { if (!dragState && !isSlotDragging && !isFourDayResizing && !justDraggedRef.current && !justFourDayResizedRef.current) onSelectEvent(evt, e); }}
                      hourHeight={hourHeight}
                      onDragStart={(e) => handleEventDragStart(evt, e)}
                      onResizeTopStart={(e) => handleFourDayResizeStart(evt, 'top', e)}
                      onResizeBottomStart={(e) => handleFourDayResizeStart(evt, 'bottom', e)}
                      dimmed={isDragging || isEventResizing}
                    />
                  );
                })}

                {/* Drag ghost */}
                {dragState && dragState.ghostDayKey === dayKey && (
                  <DragGhost
                    event={dragState.event}
                    color={getEventColor(dragState.event, calendarColorMap)}
                    top={dragState.ghostTop}
                    duration={dragState.duration}
                    hourHeight={hourHeight}
                  />
                )}

                {/* Resize ghost */}
                {fourDayResizeState && fourDayResizeState.dayKey === dayKey && (
                  <ResizeGhost
                    event={fourDayResizeState.event}
                    color={getEventColor(fourDayResizeState.event, calendarColorMap)}
                    top={fourDayResizeState.topPx}
                    height={fourDayResizeState.heightPx}
                    hourHeight={hourHeight}
                  />
                )}

                {/* Slot-drag selection preview */}
                {slotSelection && slotSelection.dayKey === dayKey && (
                  <SlotDragPreview
                    topPx={slotSelection.topPx}
                    heightPx={slotSelection.heightPx}
                    startTime={slotSelection.startTime}
                    endTime={slotSelection.endTime}
                  />
                )}

                {/* Preview block */}
                {!dragState && !isSlotDragging && !isFourDayResizing && selectedDate && isSameDay(day, selectedDate) && (
                  <TimeSlotPreview
                    date={selectedDate}
                    endDate={selectedEndDate}
                    type={selectedType}
                    color={selectedColor}
                    hourHeight={hourHeight}
                    onMouseDown={onPreviewMouseDown}
                    onResize={onPreviewResize}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Year View
// ============================================================================

function YearView({
  currentDate,
  events,
  onDateClick,
}: {
  currentDate: Date;
  events: CalendarEvent[];
  onDateClick: (date: Date) => void;
}) {
  const year = currentDate.getFullYear();
  const months = Array.from({ length: 12 }, (_, i) => new Date(year, i, 1));

  const eventDays = useMemo(() => {
    const set = new Set<string>();
    for (const evt of events) {
      set.add(format(new Date(evt.startTime), 'yyyy-MM-dd'));
    }
    return set;
  }, [events]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3 md:p-6">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-4 md:gap-x-10 gap-y-6 md:gap-y-8 max-w-6xl mx-auto">
        {months.map((month) => (
          <YearMonth key={month.getMonth()} month={month} eventDays={eventDays} onDateClick={onDateClick} />
        ))}
      </div>
    </div>
  );
}

function YearMonth({
  month,
  eventDays,
  onDateClick,
}: {
  month: Date;
  eventDays: Set<string>;
  onDateClick: (date: Date) => void;
}) {
  const monthEnd = endOfMonth(month);
  const calStart = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });

  const weeks: Date[][] = [];
  let day = calStart;
  while (day <= monthEnd || weeks.length < 5) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(day);
      day = addDays(day, 1);
    }
    weeks.push(week);
    if (day > monthEnd && weeks.length >= 5) break;
  }

  return (
    <div>
      <h3 className="text-sm font-semibold mb-2 pl-2.5">{format(month, 'MMMM')}</h3>
      <div className="grid grid-cols-7 gap-0">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <div key={i} className="text-[10px] text-muted-foreground text-center py-0.5">{d}</div>
        ))}
        {weeks.map((week, wi) =>
          week.map((d, di) => {
            const inMonth = isSameMonth(d, month);
            const today = isToday(d);
            const hasEvents = eventDays.has(format(d, 'yyyy-MM-dd'));
            return (
              <Button
                variant="ghost"
                key={`${wi}-${di}`}
                onClick={() => onDateClick(d)}
                className={cn(
                  'relative text-[12px] font-medium h-8 w-full flex items-center justify-center transition-colors',
                  !inMonth && 'text-muted-foreground/50',
                  inMonth && !today && 'text-foreground',
                )}
              >
                <span className={cn(
                  'inline-block w-7 h-7 text-center leading-7 tabular-nums rounded-[9px] transition-colors',
                  today && 'bg-foreground text-background font-semibold',
                  !today && inMonth && 'hover:bg-accent',
                )}>
                  {format(d, 'd')}
                </span>
              </Button>
            );
          }),
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Schedule View (Google Calendar style list)
// ============================================================================

interface ScheduleItem {
  id: string;
  title: string;
  type: string;
  time: string;
  date: string;
  dateLabel: string;
  dateGroup: string;
  color: string;
  isToday: boolean;
  allDay: boolean;
  location?: string;
  event: CalendarEvent;
}

function getDateGroup(date: Date): string {
  if (isYesterday(date)) return 'yesterday';
  if (isToday(date)) return 'today';
  if (isTomorrow(date)) return 'tomorrow';
  if (isThisWeek(date, { weekStartsOn: 1 })) return 'this_week';
  const nextWeekStart = addDays(endOfWeek(new Date(), { weekStartsOn: 1 }), 1);
  const nextWeekEnd = addDays(nextWeekStart, 6);
  if (date >= nextWeekStart && date <= nextWeekEnd) return 'next_week';
  if (isSameMonth(date, new Date())) return 'this_month';
  return 'later';
}

function ScheduleView({
  currentDate,
  events,
  calendarColorMap,
  onSelectEvent,
}: {
  currentDate: Date;
  events: CalendarEvent[];
  calendarColorMap: Record<string, string>;
  onSelectEvent: (e: CalendarEvent, mouseEvent: React.MouseEvent) => void;
}) {
  const t = getTranslations('weldcalendar');
  const items: ScheduleItem[] = useMemo(() => {
    const sorted = [...events].sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
    );
    return sorted.map((evt) => {
      const start = new Date(evt.startTime);
      const end = evt.endTime ? new Date(evt.endTime) : null;
      return {
        id: evt.id || `${evt.startTime}-${evt.title}`,
        title: evt.title || t.misc.noTitle,
        type: evt.type,
        date: format(start, 'yyyy-MM-dd'),
        dateLabel: `${format(start, 'd')} ${format(start, 'MMM, EEE').toUpperCase()}`,
        dateGroup: getDateGroup(start),
        time: evt.allDay ? t.calendarView.allDay : end
          ? `${format(start, 'h:mma').toLowerCase()} – ${format(end, 'h:mma').toLowerCase()}`
          : format(start, 'h:mma').toLowerCase(),
        color: getEventColor(evt, calendarColorMap),
        isToday: isToday(start),
        allDay: evt.allDay || false,
        location: evt.location,
        event: evt,
      };
    });
  }, [events, calendarColorMap]);

  const headerColumns: HeaderColumn[] = [
    { id: 'color', header: '', width: '24px' },
    { id: 'time', header: t.scheduleView.colTime, width: 'w-[150px]' },
    { id: 'title', header: t.scheduleView.colTitle, width: 'flex-1 min-w-0' },
    { id: 'type', header: t.scheduleView.colType, width: 'w-[100px]' },
    { id: 'location', header: t.scheduleView.colLocation, width: 'w-[140px]' },
  ];

  const filterConfigs: FilterConfig[] = [
    {
      field: 'type',
      label: t.calendarView.filterType,
      options: [
        { value: 'meeting', label: t.calendarView.filterTypeMeeting },
        { value: 'event', label: t.calendarView.filterTypeEvent },
        { value: 'reminder', label: t.scheduleView.filterTypeTask },
        { value: 'appointment', label: t.calendarView.filterTypeAppointment },
        { value: 'call', label: t.calendarView.filterTypeCall },
        { value: 'other', label: t.calendarView.filterTypeOther },
      ],
    },
    {
      field: 'allDay',
      label: t.calendarView.filterAllDay,
      options: [
        { value: 'true', label: t.calendarView.filterAllDayYes },
        { value: 'false', label: t.calendarView.filterAllDayNo },
      ],
    },
  ];

  const today = new Date();
  const groupConfigs: GroupConfig<ScheduleItem>[] = useMemo(() => {
    const yesterday = addDays(today, -1);
    const tomorrow = addDays(today, 1);
    return [
      { id: 'yesterday', label: `${t.scheduleView.groupYesterday} · ${format(yesterday, 'EEEE, MMMM d')}`, sortOrder: 1, filter: (i: ScheduleItem) => i.dateGroup === 'yesterday' },
      { id: 'today', label: `${t.scheduleView.groupToday} · ${format(today, 'EEEE, MMMM d')}`, sortOrder: 2, filter: (i: ScheduleItem) => i.dateGroup === 'today' },
      { id: 'tomorrow', label: `${t.scheduleView.groupTomorrow} · ${format(tomorrow, 'EEEE, MMMM d')}`, sortOrder: 3, filter: (i: ScheduleItem) => i.dateGroup === 'tomorrow' },
      { id: 'this_week', label: t.scheduleView.groupThisWeek, sortOrder: 4, filter: (i: ScheduleItem) => i.dateGroup === 'this_week' },
      { id: 'next_week', label: t.scheduleView.groupNextWeek, sortOrder: 5, filter: (i: ScheduleItem) => i.dateGroup === 'next_week' },
      { id: 'this_month', label: format(today, 'MMMM'), sortOrder: 6, filter: (i: ScheduleItem) => i.dateGroup === 'this_month' },
      { id: 'later', label: t.scheduleView.groupLater, sortOrder: 7, filter: (i: ScheduleItem) => i.dateGroup === 'later' },
    ];
  }, []);

  const renderRow = useCallback((item: ScheduleItem) => {

    return (
      <div
        key={item.id}
        className="flex items-center gap-2 md:gap-4 px-2 md:px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group"
        onClick={(e) => onSelectEvent(item.event, e)}
      >
        {/* Color dot */}
        <div className="w-[16px] md:w-[24px] shrink-0 flex justify-center">
          <div className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
        </div>

        {/* Time */}
        <div className="w-[110px] md:w-[150px] shrink-0">
          <span className="text-xs md:text-sm text-muted-foreground whitespace-nowrap">{item.time}</span>
        </div>

        {/* Title */}
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium truncate block">{item.title}</span>
          {/* On mobile, show type + location inline under the title since the
             dedicated columns are hidden. */}
          <span className="md:hidden text-xs text-muted-foreground truncate block">
            {[item.type, item.location].filter(Boolean).join(' · ')}
          </span>
        </div>

        {/* Type — hidden on mobile (shown inline under title above) */}
        <div className="hidden md:block w-[100px] shrink-0">
          <span className="text-xs text-muted-foreground capitalize">{item.type}</span>
        </div>

        {/* Location — hidden on mobile (shown inline under title above) */}
        <div className="hidden md:block w-[140px] shrink-0">
          {item.location ? (
            <span className="text-sm text-muted-foreground truncate block">{item.location}</span>
          ) : (
            <span className="text-sm text-gray-400">—</span>
          )}
        </div>
      </div>
    );
  }, [onSelectEvent]);

  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <EntityList<ScheduleItem>
        items={items}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={filterConfigs}
        groups={groupConfigs}
        maxFilters={3}
        renderRow={renderRow}
        searchPlaceholder={t.calendarView.searchPlaceholder}
        searchFields={['title', 'type', 'location', 'time']}
        hideTopBar
        emptyState={{
          title: t.scheduleView.noUpcomingEvents,
          description: t.scheduleView.noUpcomingEventsDesc,
        }}
        noResultsState={{
          title: t.scheduleView.noEventsFound,
          description: t.scheduleView.noEventsFoundDesc,
        }}
      />
    </div>
  );
}

// ============================================================================
// Time Slot Preview (colored block on time grid when creating)
// ============================================================================

function TimeSlotPreview({
  date,
  endDate,
  type,
  color: colorOverride,
  hourHeight,
  onMouseDown,
  onResize,
}: {
  date: Date;
  endDate?: Date;
  type?: string;
  /** Explicit color (e.g. resolved calendar color). Takes precedence over the
      type-derived color so the preview matches the saved event's color and
      doesn't flicker on save. */
  color?: string;
  hourHeight: number;
  onMouseDown?: (e: React.MouseEvent) => void;
  onResize?: (edge: 'top' | 'bottom', e: React.MouseEvent) => void;
}) {
  const t = getTranslations('weldcalendar');
  const color = colorOverride || (type ? (EVENT_TYPE_COLORS[type] || '#3b82f6') : '#3b82f6');
  const startHour = date.getHours() + date.getMinutes() / 60;
  const topPx = startHour * hourHeight;
  const durationHours = endDate
    ? (endDate.getTime() - date.getTime()) / (1000 * 60 * 60)
    : 1;
  const heightPx = Math.max(durationHours, 0.25) * hourHeight;

  return (
    <div
      onMouseDown={onMouseDown}
      className="absolute left-[3px] right-[3px] rounded-[6px] px-2.5 py-1.5 text-white text-[12px] leading-tight overflow-hidden z-[2] opacity-70 animate-in fade-in-50 cursor-grab active:cursor-grabbing"
      style={{
        backgroundColor: color,
        top: `${topPx}px`,
        height: `${heightPx}px`,
      }}
    >
      {onResize && (
        <div
          onMouseDown={(e) => onResize('top', e)}
          className="absolute top-0 left-0 right-0 h-2 cursor-ns-resize z-[3]"
        />
      )}
      <span className="font-semibold block">{t.misc.noTitle}</span>
      <span className="text-white/70 text-[12px] block mt-[3px]">
        {endDate
          ? `${format(date, 'h:mm a')} – ${format(endDate, 'h:mm a')}`
          : format(date, 'h:mm a')}
      </span>
      {onResize && (
        <div
          onMouseDown={(e) => onResize('bottom', e)}
          className="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize z-[3]"
        />
      )}
    </div>
  );
}

function SlotDragPreview({
  topPx,
  heightPx,
  startTime,
  endTime,
}: {
  topPx: number;
  heightPx: number;
  startTime: Date;
  endTime: Date;
}) {
  return (
    <div
      className="absolute left-[3px] right-[3px] rounded-[6px] px-2.5 py-1.5 text-primary text-[11px] leading-tight overflow-hidden z-[1] pointer-events-none bg-primary/15 border border-primary/40"
      style={{
        top: `${topPx}px`,
        height: `${heightPx}px`,
      }}
    >
      <span className="font-semibold block">
        {format(startTime, 'h:mm a')} – {format(endTime, 'h:mm a')}
      </span>
    </div>
  );
}
