
import { useState, useEffect, useMemo, useCallback, useId, useRef } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useParams } from '@/lib/router';
import { formatLocalized as format } from '@/lib/i18n/date-locale';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { Calendar } from '@weldsuite/ui/components/calendar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  Play,
  Square,
  Loader2,
  AlertCircle,
  X,
  Trash2,
  Check,
  Search,
  Link2,
  FileText,
  Pencil,
  DollarSign,
} from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { timeEntriesApi, tasksApi, membersApi } from '@/app/weldflow/lib/api-client';
import { TaskDialog } from '@/app/weldcrm/task-dialog';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import { PageLoader } from '@/components/page-loader';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { formatTaskNumber, taskNumberMatches } from '@/lib/task-number';
import { formatHoursDecimalAsHm, formatHoursMinutes } from '@/lib/format-hours';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  TimerAlreadyRunningError,
  useDiscardTimer,
  useElapsedSeconds,
  useRunningTimer,
  useStartTimer,
  useStopTimer,
} from '@/hooks/queries/use-timer-queries';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { TeamTimesheetView } from './team-timesheet-view';

interface TimeEntry {
  id: string;
  taskId?: string;
  taskName?: string;
  description?: string;
  date: Date;
  duration: number; // minutes
  /** Optional clock times — set when logged via a range or by the timer. */
  startTime?: string | null;
  endTime?: string | null;
  userId: string;
  userName?: string;
  billable: boolean;
  status: string;
  task?: {
    id: string;
    title: string;
  };
  user?: {
    id: string;
    name: string;
    email: string;
  };
}

interface ProjectTask {
  id: string;
  title: string;
  /** Workspace-wide task number, shown so same-titled tasks can be told apart. */
  number?: number | null;
  status?: string;
}

// Raw shapes as returned by the app-api time-entries / tasks endpoints
interface RawTimeEntry {
  id: string;
  taskId?: string;
  description?: string;
  date: string;
  duration?: number;
  durationMinutes?: number;
  startTime?: string | null;
  endTime?: string | null;
  userId: string;
  billable?: boolean;
  isBillable?: boolean;
  status?: string;
  task?: { id: string; title: string };
  user?: { id: string; name: string; email: string };
}

interface RawProjectTask {
  id: string;
  title: string;
  number?: number | null;
  status?: string;
}

interface ProjectMember {
  id: string;
  userId: string;
  role: string;
  user?: {
    id: string;
    name: string;
    email: string;
    avatar?: string;
  };
}

interface WeekDay {
  date: Date;
  dayName: string;
  dayNumber: number;
  monthName: string;
  isToday: boolean;
  isWeekend: boolean;
}

const ROUND_TO_VALUES = ['none', '5', '10', '15', '30', '60'] as const;

/** A calendar day holds 24h; the API rejects any day that would total more. */
const MAX_DAY_MINUTES = 24 * 60;
/** Soft threshold: past this a day total is probably a typo (30 instead of 3). */
const LONG_DAY_MINUTES = 12 * 60;

/** Minutes already logged on `date` by the entries in view, `excludeId` aside. */
function minutesLoggedOnDay(entries: TimeEntry[], date: Date, excludeId?: string | null): number {
  const key = format(date, 'yyyy-MM-dd');
  return entries.reduce(
    (sum, e) => (e.id !== excludeId && format(e.date, 'yyyy-MM-dd') === key ? sum + e.duration : sum),
    0,
  );
}

/** Hours rounded to 2dp for display in messages. */
function hoursLabel(minutes: number): string {
  return String(Math.round((minutes / 60) * 100) / 100);
}

/** Format elapsed seconds as HH:MM:SS. */
function formatTimer(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Minutes between two "HH:mm" clock times, or null when either is missing or
 * the range is not positive. An end before the start is rejected rather than
 * wrapped past midnight — the entry is anchored to a single calendar date.
 */
function minutesFromRange(start: string, end: string): number | null {
  if (!start || !end) return null;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if ([sh, sm, eh, em].some((n) => !Number.isFinite(n))) return null;
  const minutes = eh * 60 + em - (sh * 60 + sm);
  return minutes > 0 ? minutes : null;
}

/** "HH:mm" on the given date as an ISO string, or undefined when unset. */
function combineDateAndTime(date: Date, time: string): string | undefined {
  if (!time) return undefined;
  const [h, m] = time.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return undefined;
  const combined = new Date(date);
  combined.setHours(h, m, 0, 0);
  return combined.toISOString();
}

/** Entry length in minutes: the clock range wins, else the hours/minutes inputs. */
function resolveEntryMinutes(hours: string, minutes: string, startTime: string, endTime: string): number {
  return (
    minutesFromRange(startTime, endTime) ??
    (Number.parseInt(hours || '0', 10) || 0) * 60 + (Number.parseInt(minutes || '0', 10) || 0)
  );
}

function formatDurationLabel(total: number, emptyLabel: string): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h && !m) return emptyLabel;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function filterTasksByQuery(tasks: ProjectTask[], query: string): ProjectTask[] {
  if (!query.trim()) return tasks;
  return tasks.filter(
    (task) =>
      task.title.toLowerCase().includes(query.toLowerCase()) || taskNumberMatches(task.number, query),
  );
}

/** Task row in the Log time / Start timer pickers: number + title + status. */
function TaskPickerLabel({ task }: Readonly<{ task: ProjectTask }>) {
  const number = formatTaskNumber(task.number);
  const status = task.status ? task.status.replace(/_/g, ' ') : null;
  return (
    <>
      {number && <span className="mr-1.5 flex-shrink-0 font-mono text-xs text-muted-foreground">{number}</span>}
      <span className="truncate">{task.title}</span>
      {status && <span className="ml-2 flex-shrink-0 text-xs capitalize text-muted-foreground">{status}</span>}
    </>
  );
}

/** Ref callback that focuses an element as it mounts (stable identity, runs once per mount). */
function focusOnMount(el: HTMLElement | null) {
  el?.focus();
}

function RoundToPopover({ value, onChange }: Readonly<{ value: string; onChange: (value: string) => void }>) {
  const tt = useI18n().t.projects.projectTimesheets;
  const roundOptions = ROUND_TO_VALUES.map((optionValue) => ({
    value: optionValue,
    label:
      optionValue === 'none'
        ? tt.roundNone
        : optionValue === '60'
          ? tt.roundOneHour
          : tt.roundMinutes.replace('{count}', optionValue),
  }));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-7 text-xs font-normal",
            value !== 'none' && "bg-orange-100 text-orange-800 border-orange-200 hover:bg-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800"
          )}
        >
          {value !== 'none' ? tt.roundValue.replace('{minutes}', value) : tt.roundLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-1" align="start">
        {roundOptions.map((opt) => (
          <Button
            key={opt.value}
            variant="ghost"
            onClick={() => onChange(opt.value)}
            className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-secondary rounded h-auto font-normal"
          >
            <span>{opt.label}</span>
            {value === opt.value && <Check className="h-3.5 w-3.5 text-primary" />}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function BillableToggle({ billable, onToggle }: Readonly<{ billable: boolean; onToggle: () => void }>) {
  const st = useTranslations();
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        "h-7 text-xs font-normal",
        billable && "bg-green-100 text-green-800 border-green-200 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800"
      )}
      onClick={onToggle}
    >
      {billable ? st('sweep.weldflow.timesheetPage.billable') : st('sweep.weldflow.timesheetPage.notBillable')}
    </Button>
  );
}

function DurationPopover({
  hours,
  minutes,
  startTime,
  endTime,
  onHoursChange,
  onMinutesChange,
}: Readonly<{
  hours: string;
  minutes: string;
  startTime: string;
  endTime: string;
  onHoursChange: (value: string) => void;
  onMinutesChange: (value: string) => void;
}>) {
  const tt = useI18n().t.projects.projectTimesheets;
  const derivedFromRange = minutesFromRange(startTime, endTime) !== null;
  const idPrefix = useId();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-7 text-xs font-normal',
            (hours || minutes) &&
              'bg-emerald-100 text-emerald-800 border-emerald-200 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800',
          )}
        >
          {formatDurationLabel(resolveEntryMinutes(hours, minutes, startTime, endTime), tt.durationFieldLabel)}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start">
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${idPrefix}-hours`} className="text-xs font-medium text-muted-foreground">{tt.hoursLabel}</label>
            <Input
              id={`${idPrefix}-hours`}
              type="number"
              min="0"
              max="24"
              step="1"
              placeholder="0"
              value={hours}
              onChange={(e) => onHoursChange(e.target.value)}
              className="w-20 h-8 text-sm"
              disabled={derivedFromRange}
              ref={focusOnMount}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${idPrefix}-minutes`} className="text-xs font-medium text-muted-foreground">{tt.minutesLabel}</label>
            <Input
              id={`${idPrefix}-minutes`}
              type="number"
              min="0"
              max="59"
              step="1"
              placeholder="0"
              value={minutes}
              onChange={(e) => onMinutesChange(e.target.value)}
              className="w-20 h-8 text-sm"
              disabled={derivedFromRange}
            />
          </div>
        </div>
        {derivedFromRange && (
          <p className="mt-2 text-xs text-muted-foreground">
            {tt.durationFromRange}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

function TimeRangePopover({
  startTime,
  endTime,
  onStartTimeChange,
  onEndTimeChange,
}: Readonly<{
  startTime: string;
  endTime: string;
  onStartTimeChange: (value: string) => void;
  onEndTimeChange: (value: string) => void;
}>) {
  const tt = useI18n().t.projects.projectTimesheets;
  const hasBoth = !!startTime && !!endTime;
  const idPrefix = useId();
  const label = hasBoth ? `${startTime} – ${endTime}` : startTime || endTime || tt.startEndRange;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-7 text-xs font-normal',
            (startTime || endTime) &&
              'bg-sky-100 text-sky-800 border-sky-200 hover:bg-sky-200 dark:bg-sky-900/30 dark:text-sky-400 dark:border-sky-800',
          )}
        >
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start">
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${idPrefix}-start`} className="text-xs font-medium text-muted-foreground">{tt.startTimeLabel}</label>
            <Input
              id={`${idPrefix}-start`}
              type="time"
              value={startTime}
              onChange={(e) => onStartTimeChange(e.target.value)}
              className="w-28 h-8 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${idPrefix}-end`} className="text-xs font-medium text-muted-foreground">{tt.endTimeLabel}</label>
            <Input
              id={`${idPrefix}-end`}
              type="time"
              value={endTime}
              onChange={(e) => onEndTimeChange(e.target.value)}
              className="w-28 h-8 text-sm"
            />
          </div>
        </div>
        {hasBoth && minutesFromRange(startTime, endTime) === null && (
          <p className="mt-2 text-xs text-destructive">{tt.endAfterStart}</p>
        )}
        {(startTime || endTime) && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 h-7 w-full justify-start px-2 text-xs font-normal text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
            onClick={() => {
              onStartTimeChange('');
              onEndTimeChange('');
            }}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            {tt.clearTimes}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function TimesheetSearchBox({
  searchOpen,
  setSearchOpen,
  searchQuery,
  setSearchQuery,
  searchInputRef,
}: Readonly<{
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}>) {
  const st = useTranslations();
  return (
    <div className="relative flex items-center">
      <div
        className={cn(
          "flex items-center transition-all duration-200 ease-out",
          searchOpen ? "w-48" : "w-8"
        )}
      >
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
          searchOpen ? "opacity-100 w-48" : "opacity-0 w-0 pointer-events-none"
        )}>
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder={st('sweep.weldflow.timesheetPage.searchEntriesPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onBlur={() => !searchQuery && setSearchOpen(false)}
            className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
          />
        </div>
      </div>
    </div>
  );
}

function DeleteEntryDescription({ entry }: Readonly<{ entry: TimeEntry }>) {
  const st = useTranslations();
  let deleteTargetLabel: React.ReactNode = null;
  if (entry.task?.title) {
    deleteTargetLabel = (
      <>
        {' '}{st('sweep.weldflow.timesheetPage.onConnector')} <span className="font-medium">{entry.task.title}</span>
      </>
    );
  } else if (entry.description) {
    deleteTargetLabel = <> — <span className="font-medium">{entry.description}</span></>;
  }
  return (
    <>
      {st('sweep.weldflow.timesheetPage.deleteTimeEntryWillRemove')}{' '}
      <span className="font-medium">
        {formatHoursMinutes(entry.duration)}
      </span>
      {deleteTargetLabel}
      {' '}({format(entry.date, 'EEE, MMM d')}). {st('sweep.weldflow.timesheetPage.actionCannotBeUndone')}
    </>
  );
}

function renderCellContent(hours: number, isHovered: boolean) {
  if (hours > 0) {
    return (
      <span className="text-[13px] font-medium tabular-nums text-[#111] dark:text-[#eee]">
        {formatHoursDecimalAsHm(hours)}
      </span>
    );
  }
  if (isHovered) {
    return <Plus className="h-4 w-4 text-[#bbb] dark:text-[#555]" />;
  }
  return null;
}

function monthDayNumberClass(isToday: boolean, isCurrentMonth: boolean): string {
  if (isToday) {
    return "text-white bg-blue-600 dark:bg-blue-500 w-6 h-6 rounded-full flex items-center justify-center";
  }
  return isCurrentMonth ? "text-[#111] dark:text-[#eee]" : "text-[#bbb] dark:text-[#555]";
}

type OpenAddDialogForCell = (taskId: string, taskName: string, date: Date) => void;

function TimesheetWeekView({
  weekDays,
  uniqueTaskNames,
  deletingEntryId,
  getEntriesForCell,
  getTotalHoursForTask,
  openAddDialogForCell,
  openBlankAddDialog,
  openEditDialog,
  setEntryToDelete,
}: Readonly<{
  weekDays: WeekDay[];
  uniqueTaskNames: { id: string; name: string; taskId: string | null; hasTask: boolean }[];
  deletingEntryId: string | null;
  getEntriesForCell: (rowKey: string, date: Date) => TimeEntry[];
  getTotalHoursForTask: (taskId: string, taskName: string) => number;
  openAddDialogForCell: OpenAddDialogForCell;
  openBlankAddDialog: () => void;
  openEditDialog: (entry: TimeEntry) => void;
  setEntryToDelete: (entry: TimeEntry) => void;
}>) {
  const st = useTranslations();
  const tt = useI18n().t.projects.projectTimesheets;
  const [hoveredCell, setHoveredCell] = useState<{ task: string; day: number } | null>(null);
  return (
    <div className="min-w-[900px]">
      {/* Header Row */}
      <div
        className="grid grid-cols-[240px_repeat(7,1fr)_80px] sticky top-0 bg-background border-b border-border z-10"
        style={{ height: '78.5px' }}
      >
        <div className="px-5 flex items-center text-[13px] font-mono font-medium text-[#666] dark:text-[#888] uppercase tracking-wide">
          {st('sweep.weldflow.timesheetPage.task')}
        </div>
        {weekDays.map((day) => (
          <div
            key={day.date.getTime()}
            className={cn(
              "text-center flex flex-col items-center justify-center border-l border-border",
              day.isToday && "bg-zinc-50/60 dark:bg-zinc-900/30"
            )}
          >
            <div
              className={cn(
                "text-[11px] font-medium uppercase tracking-wide",
                day.isToday ? "font-semibold" : "text-muted-foreground"
              )}
              style={day.isToday ? { color: '#3073f1' } : undefined}
            >
              {day.dayName}
            </div>
            <div
              className={cn(
                "text-[22px] font-medium leading-tight mt-1",
                day.isToday ? "font-semibold" : "text-foreground"
              )}
              style={day.isToday ? { color: '#3073f1' } : undefined}
            >
              {day.dayNumber}
            </div>
          </div>
        ))}
        <div className="flex items-center justify-center border-l border-border bg-background">
          <p className="text-[13px] font-mono font-medium text-[#999] uppercase tracking-wide">{tt.totalLabel}</p>
        </div>
      </div>

      {/* Task Rows */}
      {uniqueTaskNames.map((task) => (
          <div
            key={task.id}
            className="grid grid-cols-[240px_repeat(7,1fr)_80px] border-b border-[#e5e5e5] dark:border-[#222] hover:bg-[#fafafa] dark:hover:bg-[#0f0f0f] transition-colors"
          >
            <div className="px-5 py-3 flex items-center gap-2 min-w-0">
              {task.hasTask ? (
                <>
                  <Link2 className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
                  <span
                    className="text-[13px] font-medium text-[#111] dark:text-[#eee] truncate"
                    title={task.name}
                  >
                    {task.name}
                  </span>
                </>
              ) : (
                <>
                  <FileText className="h-3.5 w-3.5 text-[#bbb] dark:text-[#555] shrink-0" />
                  <span
                    className="text-[13px] italic text-[#666] dark:text-[#888] truncate"
                    title={task.name}
                  >
                    {task.name}
                  </span>
                  <Badge variant="secondary" className="h-4 px-1 text-[9px] font-medium shrink-0">
                    {st('sweep.weldflow.timesheetPage.noTask')}
                  </Badge>
                </>
              )}
            </div>
            {weekDays.map((day, dayIndex) => {
              const cellEntries = getEntriesForCell(task.id, day.date);
              const hours = cellEntries.reduce((s, e) => s + e.duration / 60, 0);
              const isHovered = hoveredCell?.task === task.id && hoveredCell?.day === dayIndex;

              const cellClass = cn(
                "px-2 py-2 flex items-center justify-center border-l border-[#e5e5e5] dark:border-[#222] min-h-[48px] cursor-pointer transition-colors",
                day.isToday && "bg-blue-50/30 dark:bg-blue-900/5",
                day.isWeekend && !day.isToday && "bg-[#fafafa] dark:bg-[#0a0a0a]",
                isHovered && "bg-[#f0f0f0] dark:bg-[#1a1a1a]"
              );
              const cellContent = renderCellContent(hours, isHovered);

              if (cellEntries.length === 0) {
                return (
                  <button
                    key={day.date.getTime()}
                    type="button"
                    className={cellClass}
                    onMouseEnter={() => setHoveredCell({ task: task.id, day: dayIndex })}
                    onMouseLeave={() => setHoveredCell(null)}
                    onClick={() => openAddDialogForCell(task.taskId || '', task.name, day.date)}
                  >
                    {cellContent}
                  </button>
                );
              }

              return (
                <Popover key={day.date.getTime()}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cellClass}
                      onMouseEnter={() => setHoveredCell({ task: task.id, day: dayIndex })}
                      onMouseLeave={() => setHoveredCell(null)}
                    >
                      {cellContent}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="center" className="w-80 p-0">
                    <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium truncate">{task.name}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {format(day.date, 'EEE, MMM d')} · {formatHoursDecimalAsHm(hours)} total
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[12px]"
                        onClick={() => openAddDialogForCell(task.taskId || '', task.name, day.date)}
                      >
                        <Plus className="h-3.5 w-3.5 mr-1" />
                        {st('sweep.weldflow.timesheetPage.add')}
                      </Button>
                    </div>
                    <div className="max-h-64 overflow-y-auto divide-y divide-border">
                      {cellEntries.map((entry) => (
                        <div key={entry.id} className="px-3 py-2 flex items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] font-semibold tabular-nums">
                                {formatHoursMinutes(entry.duration)}
                              </span>
                              {entry.billable && (
                                <DollarSign className="h-3 w-3 text-emerald-600" />
                              )}
                              {entry.status && entry.status !== 'draft' && (
                                <Badge variant="outline" className="h-4 px-1 text-[9px]">
                                  {entry.status}
                                </Badge>
                              )}
                            </div>
                            {entry.description && (
                              <div className="text-[12px] text-muted-foreground mt-0.5 break-words">
                                {entry.description}
                              </div>
                            )}
                            {entry.userName && (
                              <div className="text-[11px] text-muted-foreground mt-0.5">
                                {st('sweep.weldflow.timesheetPage.byUser', { name: entry.userName })}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title={st('sweep.weldflow.edit')}
                              onClick={() => openEditDialog(entry)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-red-600 hover:text-red-700"
                              title={st('sweep.weldflow.delete')}
                              disabled={deletingEntryId === entry.id}
                              onClick={() => setEntryToDelete(entry)}
                            >
                              {deletingEntryId === entry.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              );
            })}
            <div className="px-2 py-3 flex items-center justify-center border-l border-[#e5e5e5] dark:border-[#222] bg-white dark:bg-[#111]">
              <span className="text-[13px] font-semibold text-[#111] dark:text-[#eee] tabular-nums">
                {formatHoursDecimalAsHm(getTotalHoursForTask(task.id, task.name))}
              </span>
            </div>
          </div>
        ))}

      {/* Add Task Row */}
      <div className="grid grid-cols-[240px_repeat(7,1fr)_80px] border-b border-[#e5e5e5] dark:border-[#222]">
        <Button
          type="button"
          variant="ghost"
          onClick={openBlankAddDialog}
          className="flex items-center gap-1.5 w-full px-5 py-3 text-left text-[13px] text-[#999] hover:text-foreground hover:bg-muted/50 transition-colors h-auto justify-start rounded-none"
        >
          <Plus className="h-3.5 w-3.5" />
          {st('sweep.weldflow.timesheetPage.addEntry')}
        </Button>
        {weekDays.map((day) => (
          <div
            key={day.date.getTime()}
            className={cn(
              "border-l border-[#e5e5e5] dark:border-[#222]",
              day.isToday && "bg-blue-50/30 dark:bg-blue-900/5",
              day.isWeekend && !day.isToday && "bg-[#fafafa] dark:bg-[#0a0a0a]"
            )}
          />
        ))}
        <div className="border-l border-[#e5e5e5] dark:border-[#222] bg-white dark:bg-[#111]" />
      </div>
    </div>
  );
}

function TimesheetMonthView({
  monthWeeks,
  currentMonth,
  entries,
  getTotalHoursForDate,
  openAddDialogForDate,
}: Readonly<{
  monthWeeks: WeekDay[][];
  currentMonth: Date;
  entries: TimeEntry[];
  getTotalHoursForDate: (date: Date) => number;
  openAddDialogForDate: (date: Date) => void;
}>) {
  return (
    <div className="flex flex-col h-full">
      {/* Calendar Header - Desktop */}
      <div className="hidden md:grid grid-cols-7 border-b border-[#e5e5e5] dark:border-[#222]">
        {[0, 1, 2, 3, 4, 5, 6].map((weekdayOffset) => format(new Date(2024, 0, 1 + weekdayOffset), 'EEE')).map((day, index) => (
          <div
            key={day}
            className={cn(
              "text-center py-2 text-[11px] font-medium uppercase tracking-wide",
              index >= 5 ? "text-[#bbb] dark:text-[#555]" : "text-[#666] dark:text-[#888]",
              index > 0 && "border-l border-[#e5e5e5] dark:border-[#222]"
            )}
          >
            {day}
          </div>
        ))}
      </div>

      {/* Calendar Grid - Desktop */}
      <div className="hidden md:flex flex-1 flex-col bg-white dark:bg-[#111]">
        {monthWeeks.map((week, weekIndex) => (
          <div
            key={week[0].date.getTime()}
            className={cn(
              "grid grid-cols-7 flex-1",
              weekIndex > 0 && "border-t border-[#e5e5e5] dark:border-[#222]"
            )}
          >
            {week.map((day, dayIndex) => {
              const isCurrentMonth = day.date.getMonth() === currentMonth.getMonth();
              const totalHours = getTotalHoursForDate(day.date);
              const dayEntries = entries.filter(entry => {
                const entryDate = new Date(entry.date);
                entryDate.setHours(0, 0, 0, 0);
                const targetDate = new Date(day.date);
                targetDate.setHours(0, 0, 0, 0);
                return entryDate.getTime() === targetDate.getTime();
              });

              return (
                <button
                  type="button"
                  key={day.date.getTime()}
                  className={cn(
                    "px-2.5 py-2 w-full h-full text-left cursor-pointer transition-colors group flex flex-col",
                    dayIndex > 0 && "border-l border-[#e5e5e5] dark:border-[#222]",
                    !isCurrentMonth && "bg-[#fafafa] dark:bg-[#0a0a0a]",
                    day.isToday && "bg-blue-50/50 dark:bg-blue-900/10",
                    day.isWeekend && isCurrentMonth && !day.isToday && "bg-[#fcfcfc] dark:bg-[#0d0d0d]",
                    "hover:bg-[#f5f5f5] dark:hover:bg-[#1a1a1a]"
                  )}
                  onClick={() => openAddDialogForDate(day.date)}
                >
                  {/* Day Number */}
                  <div className="flex items-center justify-between mb-2">
                    <span className={cn("text-[13px] font-medium", monthDayNumberClass(day.isToday, isCurrentMonth))}>
                      {day.dayNumber}
                    </span>
                    {totalHours > 0 && (
                      <span className={cn(
                        "text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded",
                        totalHours >= 8
                          ? "text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20"
                          : "text-[#666] dark:text-[#888] bg-[#f0f0f0] dark:bg-[#222]"
                      )}>
                        {formatHoursDecimalAsHm(totalHours)}
                      </span>
                    )}
                  </div>

                  {/* Entries */}
                  <div className="space-y-1">
                    {dayEntries.slice(0, 3).map((entry) => (
                      <div
                        key={entry.id}
                        className={cn(
                          "text-[11px] px-1.5 py-0.5 rounded truncate",
                          entry.duration >= 240
                            ? "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400"
                            : "bg-[#f5f5f5] dark:bg-[#1a1a1a] text-[#666] dark:text-[#888]"
                        )}
                      >
                        <span className="font-medium">{formatHoursMinutes(entry.duration)}</span>
                        <span className="ml-1">{entry.taskName}</span>
                      </div>
                    ))}
                    {dayEntries.length > 3 && (
                      <div className="text-[10px] text-[#999] dark:text-[#666] px-1.5">
                        +{dayEntries.length - 3} more
                      </div>
                    )}
                  </div>

                  {/* Add button on hover */}
                  {dayEntries.length === 0 && (
                    <div className="flex-1 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity mt-4">
                      <Plus className="h-5 w-5 text-[#ccc] dark:text-[#444]" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Mobile Month View - List of days */}
      <div className="md:hidden flex-1 overflow-auto bg-white dark:bg-[#111]">
        {monthWeeks.flat().filter(day => day.date.getMonth() === currentMonth.getMonth()).map((day) => {
          const totalHours = getTotalHoursForDate(day.date);
          const dayEntries = entries.filter(entry => {
            const entryDate = new Date(entry.date);
            entryDate.setHours(0, 0, 0, 0);
            const targetDate = new Date(day.date);
            targetDate.setHours(0, 0, 0, 0);
            return entryDate.getTime() === targetDate.getTime();
          });

          return (
            <button
              type="button"
              key={day.date.getTime()}
              className={cn(
                "block w-full text-left px-4 py-3 border-b border-[#e5e5e5] dark:border-[#222] cursor-pointer",
                day.isToday && "bg-blue-50/50 dark:bg-blue-900/10",
                day.isWeekend && !day.isToday && "bg-[#fafafa] dark:bg-[#0a0a0a]",
                "active:bg-[#f0f0f0] dark:active:bg-[#1a1a1a]"
              )}
              onClick={() => openAddDialogForDate(day.date)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "w-10 h-10 rounded-lg flex flex-col items-center justify-center",
                    day.isToday
                      ? "bg-blue-600 dark:bg-blue-500 text-white"
                      : "bg-[#f5f5f5] dark:bg-[#1a1a1a]"
                  )}>
                    <span className="text-[10px] font-medium uppercase">
                      {format(day.date, 'EEE')}
                    </span>
                    <span className="text-[15px] font-semibold -mt-0.5">
                      {day.dayNumber}
                    </span>
                  </div>
                  <div>
                    <p className={cn(
                      "text-[13px] font-medium",
                      day.isToday ? "text-blue-600 dark:text-blue-400" : "text-[#111] dark:text-[#eee]"
                    )}>
                      {format(day.date, 'MMMM d, yyyy')}
                    </p>
                    {dayEntries.length > 0 && (
                      <p className="text-[12px] text-[#666] dark:text-[#888]">
                        {dayEntries.length} {dayEntries.length === 1 ? 'entry' : 'entries'}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {totalHours > 0 && (
                    <span className={cn(
                      "text-[13px] font-semibold tabular-nums px-2 py-1 rounded",
                      totalHours >= 8
                        ? "text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20"
                        : "text-[#666] dark:text-[#888] bg-[#f0f0f0] dark:bg-[#222]"
                    )}>
                      {formatHoursDecimalAsHm(totalHours)}
                    </span>
                  )}
                  <Plus className="h-4 w-4 text-[#ccc] dark:text-[#555]" />
                </div>
              </div>
              {/* Show entries preview */}
              {dayEntries.length > 0 && (
                <div className="mt-2 pl-[52px] space-y-1">
                  {dayEntries.slice(0, 2).map((entry) => (
                    <div
                      key={entry.id}
                      className={cn(
                        "text-[12px] px-2 py-1 rounded truncate",
                        entry.duration >= 240
                          ? "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400"
                          : "bg-[#f5f5f5] dark:bg-[#1a1a1a] text-[#666] dark:text-[#888]"
                      )}
                    >
                      <span className="font-medium">{formatHoursMinutes(entry.duration)}</span>
                      <span className="ml-1.5">{entry.taskName}</span>
                    </div>
                  ))}
                  {dayEntries.length > 2 && (
                    <p className="text-[11px] text-[#999] dark:text-[#666]">
                      +{dayEntries.length - 2} more
                    </p>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TimesheetWeekFooter({
  weekDays,
  weeklyTotal,
  getTotalHoursForDate,
}: Readonly<{
  weekDays: WeekDay[];
  weeklyTotal: number;
  getTotalHoursForDate: (date: Date) => number;
}>) {
  const tt = useI18n().t.projects.projectTimesheets;
  return (
    <div className="border-t bg-white dark:bg-background">
      <div className="grid grid-cols-[240px_repeat(7,1fr)_80px] min-w-[900px]">
        <div className="px-5 py-2 text-sm text-gray-500 dark:text-muted-foreground">{tt.dailyTotal}</div>
        {weekDays.map((day) => {
          const dayTotal = getTotalHoursForDate(day.date);
          return (
            <div key={day.date.getTime()} className="pl-4 pr-2 py-2 text-sm text-gray-500 dark:text-muted-foreground text-left border-l border-[#e5e5e5] dark:border-[#222]">
              <span className="font-medium">{dayTotal > 0 ? formatHoursDecimalAsHm(dayTotal) : '—'}</span>
            </div>
          );
        })}
        <div className="px-2 py-2 text-sm font-medium text-gray-700 dark:text-muted-foreground text-center border-l border-[#e5e5e5] dark:border-[#222]">
          {formatHoursDecimalAsHm(weeklyTotal)}
        </div>
      </div>
    </div>
  );
}

function TimesheetGrid({
  viewMode,
  weekDays,
  monthWeeks,
  currentMonth,
  entries,
  uniqueTaskNames,
  weeklyTotal,
  deletingEntryId,
  getEntriesForCell,
  getTotalHoursForDate,
  getTotalHoursForTask,
  openAddDialogForCell,
  openAddDialogForDate,
  openBlankAddDialog,
  openEditDialog,
  setEntryToDelete,
}: Readonly<{
  viewMode: 'week' | 'month';
  weekDays: WeekDay[];
  monthWeeks: WeekDay[][];
  currentMonth: Date;
  entries: TimeEntry[];
  uniqueTaskNames: { id: string; name: string; taskId: string | null; hasTask: boolean }[];
  weeklyTotal: number;
  deletingEntryId: string | null;
  getEntriesForCell: (rowKey: string, date: Date) => TimeEntry[];
  getTotalHoursForDate: (date: Date) => number;
  getTotalHoursForTask: (taskId: string, taskName: string) => number;
  openAddDialogForCell: OpenAddDialogForCell;
  openAddDialogForDate: (date: Date) => void;
  openBlankAddDialog: () => void;
  openEditDialog: (entry: TimeEntry) => void;
  setEntryToDelete: (entry: TimeEntry) => void;
}>) {
  return (
    <>
      {/* Timesheet Grid */}
      <div className="flex-1 overflow-auto">
        {viewMode === 'week' ? (
          <TimesheetWeekView
            weekDays={weekDays}
            uniqueTaskNames={uniqueTaskNames}
            deletingEntryId={deletingEntryId}
            getEntriesForCell={getEntriesForCell}
            getTotalHoursForTask={getTotalHoursForTask}
            openAddDialogForCell={openAddDialogForCell}
            openBlankAddDialog={openBlankAddDialog}
            openEditDialog={openEditDialog}
            setEntryToDelete={setEntryToDelete}
          />
        ) : (
          <TimesheetMonthView
            monthWeeks={monthWeeks}
            currentMonth={currentMonth}
            entries={entries}
            getTotalHoursForDate={getTotalHoursForDate}
            openAddDialogForDate={openAddDialogForDate}
          />
        )}
      </div>

      {/* Calculations Footer - Fixed at bottom */}
      {viewMode === 'week' && (
        <TimesheetWeekFooter
          weekDays={weekDays}
          weeklyTotal={weeklyTotal}
          getTotalHoursForDate={getTotalHoursForDate}
        />
      )}
    </>
  );
}

function AddEntryDialog({
  tasks,
  showAddDialog,
  setShowAddDialog,
  editingEntryId,
  setEditingEntryId,
  setShowCreateTaskDialog,
  newEntryDescription,
  setNewEntryDescription,
  newEntryTaskId,
  setNewEntryTaskId,
  newEntryTaskName,
  setNewEntryTaskName,
  newEntryHours,
  setNewEntryHours,
  newEntryMinutes,
  setNewEntryMinutes,
  newEntryStartTime,
  setNewEntryStartTime,
  newEntryEndTime,
  setNewEntryEndTime,
  newEntryRoundTo,
  setNewEntryRoundTo,
  newEntryBillable,
  setNewEntryBillable,
  selectedDate,
  setSelectedDate,
  isSubmitting,
  handleAddEntry,
  otherMinutesOnDay,
}: Readonly<{
  tasks: ProjectTask[];
  showAddDialog: boolean;
  setShowAddDialog: (open: boolean) => void;
  editingEntryId: string | null;
  setEditingEntryId: (id: string | null) => void;
  setShowCreateTaskDialog: (open: boolean) => void;
  newEntryDescription: string;
  setNewEntryDescription: (value: string) => void;
  newEntryTaskId: string;
  setNewEntryTaskId: (value: string) => void;
  newEntryTaskName: string;
  setNewEntryTaskName: (value: string) => void;
  newEntryHours: string;
  setNewEntryHours: (value: string) => void;
  newEntryMinutes: string;
  setNewEntryMinutes: (value: string) => void;
  newEntryStartTime: string;
  setNewEntryStartTime: (value: string) => void;
  newEntryEndTime: string;
  setNewEntryEndTime: (value: string) => void;
  newEntryRoundTo: string;
  setNewEntryRoundTo: (value: string) => void;
  newEntryBillable: boolean;
  setNewEntryBillable: (value: boolean) => void;
  selectedDate: Date | null;
  setSelectedDate: (date: Date | null) => void;
  isSubmitting: boolean;
  handleAddEntry: () => void;
  /** Minutes already logged on the selected date, excluding the entry being edited. */
  otherMinutesOnDay: number;
}>) {
  const st = useTranslations();
  const entryMinutes = resolveEntryMinutes(newEntryHours, newEntryMinutes, newEntryStartTime, newEntryEndTime);
  const projectedDayMinutes = otherMinutesOnDay + entryMinutes;
  const exceedsDayLimit = entryMinutes > 0 && projectedDayMinutes > MAX_DAY_MINUTES;
  const isLongDay = entryMinutes > 0 && !exceedsDayLimit && projectedDayMinutes > LONG_DAY_MINUTES;
  const tt = useI18n().t.projects.projectTimesheets;
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [datePickerMonth, setDatePickerMonth] = useState<Date | undefined>(undefined);
  const [taskSelectorOpen, setTaskSelectorOpen] = useState(false);
  const [taskSearchQuery, setTaskSearchQuery] = useState('');
  const filteredTasks = useMemo(() => filterTasksByQuery(tasks, taskSearchQuery), [tasks, taskSearchQuery]);

  return (
    <Dialog open={showAddDialog} onOpenChange={(open) => {
      setShowAddDialog(open);
      if (!open) setEditingEntryId(null);
    }}>
      <DialogContent className="sm:max-w-[600px] p-0 gap-0 overflow-hidden" showCloseButton={false}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-border">
          <DialogTitle className="text-base font-semibold">{editingEntryId ? tt.editTimeEntry : tt.logTime}</DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 translate-x-[4px] hover:ring-[3px] hover:ring-accent dark:hover:ring-accent"
            onClick={() => setShowAddDialog(false)}
          >
            <X className="h-3.5 w-3.5 !text-gray-500 dark:!text-gray-400" strokeWidth={2.5} />
          </Button>
        </div>

        {/* Description row — prominent, optional (like the title row in Create task). */}
        <div className="pl-4 py-[11px]">
          <textarea
            value={newEntryDescription}
            onChange={(e) => {
              setNewEntryDescription(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const hasDuration =
                  !!newEntryHours ||
                  !!newEntryMinutes ||
                  minutesFromRange(newEntryStartTime, newEntryEndTime) !== null;
                if (hasDuration && selectedDate && !isSubmitting) handleAddEntry();
              }
            }}
            placeholder={st('sweep.weldflow.timesheetPage.addDescriptionPlaceholder')}
            className="w-full pl-0 pr-4 py-0 m-0 text-sm font-medium border-none outline-none bg-transparent placeholder:text-gray-400 resize-none overflow-y-auto max-h-[200px] min-h-[20px] leading-5 align-top block break-words [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-gray-200 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-gray-300 dark:[&::-webkit-scrollbar-thumb]:bg-gray-700"
            rows={1}
            ref={focusOnMount}
          />
        </div>

        <div className="border-b border-gray-100 dark:border-border" />

        {/* Task selector row — optional secondary link (like the description row in Create task). */}
        <div className="px-4 py-[11px] group relative min-w-0">
          <Popover
            open={taskSelectorOpen}
            onOpenChange={(open) => {
              setTaskSelectorOpen(open);
              if (!open) setTaskSearchQuery('');
            }}
          >
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className={cn(
                  'w-full text-left text-sm text-gray-600 dark:text-muted-foreground border-none outline-none bg-transparent block break-words truncate leading-5 min-h-[20px] h-auto p-0 font-normal justify-start',
                  !newEntryTaskName && 'text-gray-400',
                )}
              >
                {newEntryTaskName || tt.linkTaskOptional}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[280px] p-0" align="start">
              <div className="flex items-center border-b px-3">
                <Search className="mr-0.5 h-4 w-4 shrink-0 opacity-50" />
                <input
                  placeholder={st('sweep.weldflow.tasksView.searchPlaceholder')}
                  value={taskSearchQuery}
                  onChange={(e) => setTaskSearchQuery(e.target.value)}
                  className="flex h-9 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
              <div
                className="max-h-[200px] overflow-y-auto p-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent"
                onWheel={(e) => e.stopPropagation()}
              >
                {filteredTasks.length === 0 ? (
                  <div className="py-4 text-center text-sm text-muted-foreground">{tt.noTasksFound}</div>
                ) : (
                  filteredTasks.map((task) => (
                    <button
                      type="button"
                      key={task.id}
                      onClick={() => {
                        setNewEntryTaskId(task.id);
                        setNewEntryTaskName(task.title);
                        setTaskSelectorOpen(false);
                        setTaskSearchQuery('');
                      }}
                      className={cn(
                        'relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent',
                        newEntryTaskId === task.id && 'bg-accent text-accent-foreground',
                      )}
                    >
                      <TaskPickerLabel task={task} />
                      {newEntryTaskId === task.id && (
                        <Check className="ml-auto h-4 w-4 flex-shrink-0" />
                      )}
                    </button>
                  ))
                )}
              </div>
              <div className="border-t border-gray-200 dark:border-border p-1">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setTaskSelectorOpen(false);
                    setShowAddDialog(false);
                    setShowCreateTaskDialog(true);
                  }}
                  className="flex items-center w-full px-2 py-1.5 text-sm text-left hover:bg-accent rounded gap-1.5 h-auto justify-start font-normal"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {st('sweep.weldflow.timesheetPage.createNewTask')}
                </Button>
              </div>
              {newEntryTaskId && (
                <div className="border-t border-gray-200 dark:border-border p-1">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setNewEntryTaskId('');
                      setNewEntryTaskName('');
                    }}
                    className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded h-auto justify-start font-normal"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    {st('sweep.weldflow.timesheetPage.clear')}
                  </Button>
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {/* Daily-total guard: hard stop past 24h, soft warning past 12h. */}
        {selectedDate && (exceedsDayLimit || isLongDay) && (
          <div
            role={exceedsDayLimit ? 'alert' : 'status'}
            className={cn(
              'flex items-start gap-1.5 px-4 py-2 border-t text-xs',
              exceedsDayLimit
                ? 'border-red-100 bg-red-50 text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-400'
                : 'border-amber-100 bg-amber-50 text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-400',
            )}
          >
            <AlertCircle className="h-3.5 w-3.5 mt-px shrink-0" />
            <span>
              {st(
                exceedsDayLimit
                  ? 'sweep.weldflow.timesheetPage.dayLimitExceeded'
                  : 'sweep.weldflow.timesheetPage.dayLongWarning',
                { date: format(selectedDate, 'EEE, MMM d'), hours: hoursLabel(projectedDayMinutes) },
              )}
            </span>
          </div>
        )}

        {/* Bottom Bar */}
        <div className="flex items-end justify-between px-4 py-2 border-t border-gray-100 dark:border-border gap-2 w-full">
          <div className="flex items-center gap-1 flex-wrap min-w-0 flex-shrink py-2.5">
                {/* Duration (hours + minutes) */}
                <DurationPopover
                  hours={newEntryHours}
                  minutes={newEntryMinutes}
                  startTime={newEntryStartTime}
                  endTime={newEntryEndTime}
                  onHoursChange={setNewEntryHours}
                  onMinutesChange={setNewEntryMinutes}
                />

                {/* Start / end clock times. Optional — leave blank to log a
                    bare duration. Setting both drives the duration instead. */}
                <TimeRangePopover
                  startTime={newEntryStartTime}
                  endTime={newEntryEndTime}
                  onStartTimeChange={setNewEntryStartTime}
                  onEndTimeChange={setNewEntryEndTime}
                />

                {/* Date */}
                <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-7 text-xs font-normal">
                      {selectedDate ? format(selectedDate, 'MMM d') : 'Date'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={selectedDate || undefined}
                      captionLayout="dropdown"
                      month={datePickerMonth || selectedDate || new Date()}
                      onMonthChange={setDatePickerMonth}
                      onSelect={(date) => {
                        setSelectedDate(date || null);
                        setDatePickerOpen(false);
                      }}
                    />
                    {selectedDate && (
                      <div className="p-1 border-t border-gray-200 dark:border-border">
                        <Button
                          variant="ghost"
                          onClick={() => setSelectedDate(null)}
                          className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded h-auto justify-start font-normal"
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-2" />
                          {st('sweep.weldflow.timesheetPage.clear')}
                        </Button>
                      </div>
                    )}
                  </PopoverContent>
                </Popover>

                {/* Round to */}
                <RoundToPopover value={newEntryRoundTo} onChange={setNewEntryRoundTo} />

                {/* Billable */}
                <BillableToggle billable={newEntryBillable} onToggle={() => setNewEntryBillable(!newEntryBillable)} />
              </div>

              <div className="flex items-center gap-2 flex-shrink-0 py-2.5">
                {(() => {
                  const missing: string[] = [];
                  const mins = resolveEntryMinutes(newEntryHours, newEntryMinutes, newEntryStartTime, newEntryEndTime);
                  if (!mins) missing.push(tt.durationFieldLabel);
                  if (!selectedDate) missing.push(tt.dateLabel);
                  const disabled = isSubmitting || !mins || !selectedDate || exceedsDayLimit;
                  const btn = (
                    <Button
                      size="sm"
                      onClick={handleAddEntry}
                      disabled={disabled}
                      className="h-[30px] text-xs px-3 bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                      {isSubmitting ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : editingEntryId ? (
                        st('sweep.weldflow.timesheetPage.save')
                      ) : (
                        st('sweep.weldflow.timesheetPage.logTime')
                      )}
                    </Button>
                  );
                  if (missing.length === 0) return btn;
                  // Radix tooltip doesn't hover over disabled elements, so
                  // wrap the button in a span (the trigger) to capture the
                  // pointer events.
                  return (
                    <Tooltip delayDuration={300}>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">{btn}</span>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={6}>
                        {tt.missingLabel} {missing.join(', ')}
                      </TooltipContent>
                    </Tooltip>
                  );
                })()}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StartTimerDialog({
  tasks,
  showTimerDialog,
  setShowTimerDialog,
  timerDescription,
  setTimerDescription,
  timerTaskId,
  setTimerTaskId,
  timerTaskName,
  setTimerTaskName,
  timerRoundTo,
  setTimerRoundTo,
  timerBillable,
  setTimerBillable,
  startTimer,
}: Readonly<{
  tasks: ProjectTask[];
  showTimerDialog: boolean;
  setShowTimerDialog: (open: boolean) => void;
  timerDescription: string;
  setTimerDescription: (value: string) => void;
  timerTaskId: string;
  setTimerTaskId: (value: string) => void;
  timerTaskName: string;
  setTimerTaskName: (value: string) => void;
  timerRoundTo: string;
  setTimerRoundTo: (value: string) => void;
  timerBillable: boolean;
  setTimerBillable: (value: boolean) => void;
  startTimer: () => void;
}>) {
  const st = useTranslations();
  const tt = useI18n().t.projects.projectTimesheets;
  // A timer needs something to say what it is for: a linked task or a description.
  const canStartTimer = Boolean(timerTaskName || timerTaskId || timerDescription.trim());
  const [timerTaskSelectorOpen, setTimerTaskSelectorOpen] = useState(false);
  const [timerTaskSearchQuery, setTimerTaskSearchQuery] = useState('');
  const filteredTimerTasks = useMemo(
    () => filterTasksByQuery(tasks, timerTaskSearchQuery),
    [tasks, timerTaskSearchQuery],
  );

  return (
    <Dialog open={showTimerDialog} onOpenChange={setShowTimerDialog}>
      <DialogContent className="sm:max-w-[600px] p-0 gap-0 overflow-hidden" showCloseButton={false}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-border">
          <DialogTitle className="text-base font-semibold">{tt.startTimer}</DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setShowTimerDialog(false)}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Content */}
        <div className="px-4 pt-3 pb-[7px]">
          <textarea
            value={timerDescription}
            onChange={(e) => {
              setTimerDescription(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (canStartTimer) startTimer();
              }
            }}
            placeholder={st('sweep.weldflow.timesheetPage.addDescriptionPlaceholder')}
            className="w-full text-sm text-gray-600 dark:text-muted-foreground border-none outline-none bg-transparent placeholder:text-gray-400 resize-none overflow-y-auto max-h-[200px] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-gray-200 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-gray-300 dark:[&::-webkit-scrollbar-thumb]:bg-gray-700"
            rows={2}
            ref={focusOnMount}
          />
        </div>

        {/* Bottom Bar */}
        <div className="flex items-center justify-between px-4 pt-0 pb-0 border-t border-gray-100 dark:border-border gap-2 w-full overflow-hidden">
          <div className="flex items-center gap-1 overflow-x-auto min-w-0 flex-shrink pb-7 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:bg-gray-200 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent [&>*]:flex-shrink-0 [&>*]:translate-y-[14px]">
            {/* Task */}
            <Popover open={timerTaskSelectorOpen} onOpenChange={(open) => {
              setTimerTaskSelectorOpen(open);
              if (!open) setTimerTaskSearchQuery('');
            }}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-7 text-xs font-normal max-w-[160px] truncate",
                    timerTaskName && "bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800"
                  )}
                >
                  {timerTaskName || tt.taskFallback}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[280px] p-0" align="start">
                <div className="flex items-center border-b px-3">
                  <Search className="mr-0.5 h-4 w-4 shrink-0 opacity-50" />
                  <input
                    placeholder={st('sweep.weldflow.tasksView.searchPlaceholder')}
                    value={timerTaskSearchQuery}
                    onChange={(e) => setTimerTaskSearchQuery(e.target.value)}
                    className="flex h-9 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
                  />
                </div>
                <div
                  className="max-h-[200px] overflow-y-auto p-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent"
                  onWheel={(e) => e.stopPropagation()}
                >
                  {filteredTimerTasks.length === 0 ? (
                    <div className="py-4 text-center text-sm text-muted-foreground">{tt.noTasksFound}</div>
                  ) : (
                    filteredTimerTasks.map((task) => (
                      <button
                        type="button"
                        key={task.id}
                        onClick={() => {
                          setTimerTaskId(task.id);
                          setTimerTaskName(task.title);
                          setTimerTaskSelectorOpen(false);
                          setTimerTaskSearchQuery('');
                        }}
                        className={cn(
                          "relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent",
                          timerTaskId === task.id && "bg-accent text-accent-foreground"
                        )}
                      >
                        <TaskPickerLabel task={task} />
                        {timerTaskId === task.id && (
                          <Check className="ml-auto h-4 w-4 flex-shrink-0" />
                        )}
                      </button>
                    ))
                  )}
                </div>
                {timerTaskId && (
                  <div className="border-t border-gray-200 dark:border-border p-1">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setTimerTaskId('');
                        setTimerTaskName('');
                      }}
                      className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded h-auto justify-start font-normal"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-2" />
                      {st('sweep.weldflow.timesheetPage.clear')}
                    </Button>
                  </div>
                )}
              </PopoverContent>
            </Popover>

            {/* Round to */}
            <RoundToPopover value={timerRoundTo} onChange={setTimerRoundTo} />

            {/* Billable */}
            <BillableToggle billable={timerBillable} onToggle={() => setTimerBillable(!timerBillable)} />
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <span title={canStartTimer ? undefined : tt.timerNeedsTaskOrDescription}>
              <Button
                size="sm"
                onClick={startTimer}
                disabled={!canStartTimer}
                aria-describedby={canStartTimer ? undefined : 'start-timer-hint'}
                className="h-7 text-xs px-3 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {st('sweep.weldflow.timesheetPage.startTimer')}
              </Button>
            </span>
            {!canStartTimer && (
              <span id="start-timer-hint" className="sr-only">
                {tt.timerNeedsTaskOrDescription}
              </span>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function TimesheetPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [currentWeekStart, setCurrentWeekStart] = useState<Date>(() => {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(today);
    monday.setDate(today.getDate() + diff);
    monday.setHours(0, 0, 0, 0);
    return monday;
  });
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [newEntryTaskId, setNewEntryTaskId] = useState('');
  const [newEntryTaskName, setNewEntryTaskName] = useState('');
  const [newEntryHours, setNewEntryHours] = useState('');
  const [newEntryMinutes, setNewEntryMinutes] = useState('');
  const [newEntryDescription, setNewEntryDescription] = useState('');
  const [newEntryBillable, setNewEntryBillable] = useState(true);
  const [newEntryRoundTo, setNewEntryRoundTo] = useState('none');
  // Optional clock times ("HH:mm"). When both are set the duration is derived
  // from them and the hours/minutes inputs become read-only mirrors.
  const [newEntryStartTime, setNewEntryStartTime] = useState('');
  const [newEntryEndTime, setNewEntryEndTime] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [deletingEntryId, setDeletingEntryId] = useState<string | null>(null);
  const [entryToDelete, setEntryToDelete] = useState<TimeEntry | null>(null);

  const tt = useI18n().t.projects.projectTimesheets;
  const st = useTranslations();

  // Timer state. The running timer itself lives on the server (one per user),
  // so it survives refresh and navigation; only the compose-time fields below
  // are local. `timerSeconds` is derived from the server's startedAt rather
  // than counted up locally, so a backgrounded tab still shows the truth.
  const { data: runningTimer } = useRunningTimer();
  const startTimerMutation = useStartTimer();
  const stopTimerMutation = useStopTimer();
  const discardTimerMutation = useDiscardTimer();
  // Only surface the in-page control for a timer belonging to THIS project —
  // a timer running against another project is the global widget's business,
  // and stopping it from here would silently log time to the wrong project.
  const isTimerRunning = !!runningTimer && runningTimer.projectId === projectId;
  const timerSeconds = useElapsedSeconds(runningTimer?.startedAt);
  const [timerTaskId, setTimerTaskId] = useState('');
  const [timerTaskName, setTimerTaskName] = useState('');
  const [timerDescription, setTimerDescription] = useState('');
  const [timerBillable, setTimerBillable] = useState(true);
  const [showTimerDialog, setShowTimerDialog] = useState(false);
  const [timerRoundTo, setTimerRoundTo] = useState('none');

  const [viewMode, setViewMode] = useState<'week' | 'month'>('week');

  // Own timesheet vs. the whole project team. Only project managers/owners get
  // the toggle; the server enforces the same boundary on /team-summary, so
  // hiding it here is the affordance, not the guard.
  const { isAdmin, isLoading: permissionsLoading } = useProjectPermissions();
  const canSeeTeam = !permissionsLoading && isAdmin;
  const [audience, setAudience] = useState<'mine' | 'team'>('mine');
  // Losing the grant mid-session (role change, project switch) must not strand
  // the user on a view they can no longer read.
  const showTeamView = audience === 'team' && canSeeTeam;

  // Filter and search state
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [headerDatePickerOpen, setHeaderDatePickerOpen] = useState(false);

  // Create-task popup (uses the shared TaskDialog used on the tasks page).
  const [showCreateTaskDialog, setShowCreateTaskDialog] = useState(false);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [currentMonth, setCurrentMonth] = useState<Date>(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });

  // Focus search input when opened
  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  // Filter configurations for timesheet entries
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'billable',
      label: st('sweep.weldflow.timesheetPage.billable'),
      filterType: 'boolean' as const,
      options: [
        { value: 'true', label: st('sweep.weldflow.timesheetPage.yes') },
        { value: 'false', label: st('sweep.weldflow.timesheetPage.no') },
      ],
    },
    {
      field: 'task',
      label: st('sweep.weldflow.timesheetPage.task'),
      options: tasks.map(t => ({ value: t.id, label: t.title })),
    },
    {
      field: 'member',
      label: st('sweep.weldflow.timesheetPage.member'),
      options: projectMembers
        .filter(m => m.user?.name)
        .map(m => ({ value: m.userId, label: m.user!.name })),
    },
  ], [tasks, projectMembers, st]);

  // Load data
  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const [entriesResult, tasksResult, membersResult] = await Promise.all([
        timeEntriesApi.list(projectId, { limit: 500 }),
        tasksApi.list(projectId),
        membersApi.list(projectId),
      ]);

      if (entriesResult.success) {
        const rawEntries = (Array.isArray(entriesResult.data)
          ? entriesResult.data
          : entriesResult.data?.items || []) as unknown as RawTimeEntry[];
        // The list payload nests `task` / `user`, but resolve against the
        // project's task and member lists too so a row is never labelled with an
        // entry description or "Unknown" when the lookup is simply absent.
        const taskTitleById = new Map(
          (tasksResult.success ? ((tasksResult.data || []) as RawProjectTask[]) : []).map((tk) => [tk.id, tk.title]),
        );
        const memberNameById = new Map(
          (membersResult.success ? ((membersResult.data || []) as ProjectMember[]) : [])
            .filter((m) => m.user?.name)
            .map((m) => [m.userId, m.user!.name]),
        );
        const transformedEntries = rawEntries.map((entry) => {
          const taskTitle = entry.task?.title || (entry.taskId ? taskTitleById.get(entry.taskId) : undefined);
          return {
            id: entry.id,
            taskId: entry.taskId,
            // An entry linked to a task is labelled by that task, never by its own
            // description (which differs per entry and would rename the row).
            taskName: taskTitle || (entry.taskId ? undefined : entry.description) || tt.untitled,
            description: entry.description,
            date: new Date(String(entry.date).substring(0, 10) + 'T00:00:00'),
            duration: Number(entry.duration) || entry.durationMinutes || 0,
            startTime: entry.startTime ?? null,
            endTime: entry.endTime ?? null,
            userId: entry.userId,
            // Left undefined when unresolvable: the popover then omits the "by …"
            // line instead of printing a misleading "by Unknown".
            userName: entry.user?.name || memberNameById.get(entry.userId),
            billable: entry.billable ?? entry.isBillable ?? true,
            status: entry.status || 'draft',
            task: entry.task ?? (entry.taskId && taskTitle ? { id: entry.taskId, title: taskTitle } : undefined),
            user: entry.user,
          };
        });
        setEntries(transformedEntries);
      } else {
        setError(entriesResult.error || tt.failedToLoadEntries);
      }

      if (tasksResult.success) {
        setTasks(((tasksResult.data || []) as RawProjectTask[]).map((task) => ({
          id: task.id,
          title: task.title,
          number: task.number ?? null,
          status: task.status,
        })));
      }

      if (membersResult.success) {
        setProjectMembers(membersResult.data || []);
      }
    } catch (err) {
      console.error('Error loading data:', err);
      setError(tt.failedToLoadData);
    } finally {
      setIsLoading(false);
    }
    // The copy (`tt`) is deliberately not a dependency: a language switch must
    // re-translate the labels, not refetch every time entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Generate week days
  const weekDays = useMemo((): WeekDay[] => {
    const days: WeekDay[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < 7; i++) {
      const date = new Date(currentWeekStart);
      date.setDate(currentWeekStart.getDate() + i);

      days.push({
        date,
        dayName: format(date, 'EEE'),
        dayNumber: date.getDate(),
        monthName: format(date, 'MMM'),
        isToday: date.getTime() === today.getTime(),
        isWeekend: date.getDay() === 0 || date.getDay() === 6,
      });
    }
    return days;
  }, [currentWeekStart]);

  // Get unique task names from entries
  const uniqueTaskNames = useMemo(() => {
    const taskMap = new Map<string, { name: string; taskId: string | null }>();
    entries.forEach(e => {
      const key = e.taskId || `desc:${e.description || e.taskName || 'other'}`;
      if (!taskMap.has(key)) {
        taskMap.set(key, {
          name: e.task?.title || e.taskName || e.description || tt.untitled,
          taskId: e.taskId || null,
        });
      }
    });
    return Array.from(taskMap.entries()).map(([id, v]) => ({
      id,
      name: v.name,
      taskId: v.taskId,
      hasTask: !!v.taskId,
    }));
  }, [entries, tt.untitled]);

  // Get entries matching a row key (real taskId or description-only) for a given date
  const getEntriesForCell = (rowKey: string, date: Date): TimeEntry[] => {
    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);
    return entries.filter(entry => {
      const entryDate = new Date(entry.date);
      entryDate.setHours(0, 0, 0, 0);
      if (entryDate.getTime() !== targetDate.getTime()) return false;
      if (rowKey.startsWith('desc:')) {
        const desc = rowKey.slice(5);
        return !entry.taskId && (entry.description || entry.taskName || 'other') === desc;
      }
      return entry.taskId === rowKey;
    });
  };

  // Get hours for a specific date and task row
  const getHoursForCell = (rowKey: string, _taskName: string, date: Date): number => {
    return getEntriesForCell(rowKey, date).reduce((sum, entry) => sum + (entry.duration / 60), 0);
  };

  // Calculate total hours for a date
  const getTotalHoursForDate = useCallback((date: Date): number => {
    return entries
      .filter(entry => {
        const entryDate = new Date(entry.date);
        entryDate.setHours(0, 0, 0, 0);
        const targetDate = new Date(date);
        targetDate.setHours(0, 0, 0, 0);
        return entryDate.getTime() === targetDate.getTime();
      })
      .reduce((sum, entry) => sum + (entry.duration / 60), 0);
  }, [entries]);

  // Calculate total hours for a task in current week
  const getTotalHoursForTask = (taskId: string, taskName: string): number => {
    return weekDays.reduce((sum, day) => sum + getHoursForCell(taskId, taskName, day.date), 0);
  };

  // Calculate weekly total
  const weeklyTotal = useMemo(() => {
    return weekDays.reduce((sum, day) => sum + getTotalHoursForDate(day.date), 0);
  }, [weekDays, getTotalHoursForDate]);

  // Navigate weeks
  const goToPreviousWeek = () => {
    const newStart = new Date(currentWeekStart);
    newStart.setDate(newStart.getDate() - 7);
    setCurrentWeekStart(newStart);
  };

  const goToNextWeek = () => {
    const newStart = new Date(currentWeekStart);
    newStart.setDate(newStart.getDate() + 7);
    setCurrentWeekStart(newStart);
  };

  const goToToday = () => {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(today);
    monday.setDate(today.getDate() + diff);
    monday.setHours(0, 0, 0, 0);
    setCurrentWeekStart(monday);
  };

  // Handle add entry
  const handleAddEntry = async () => {
    if (!selectedDate) return;
    const submitDate = selectedDate;

    // Clock times win when both are supplied — the duration inputs mirror them.
    const rangeMinutes = minutesFromRange(newEntryStartTime, newEntryEndTime);
    if (newEntryStartTime && newEntryEndTime && rangeMinutes === null) {
      toast.error(tt.endAfterStart);
      return;
    }

    const totalMinutesRaw =
      rangeMinutes ??
      (Number.parseInt(newEntryHours || '0', 10) || 0) * 60 +
        (Number.parseInt(newEntryMinutes || '0', 10) || 0);
    if (!totalMinutesRaw) return;

    let totalMinutes = totalMinutesRaw;

    // Round time if enabled
    if (newEntryRoundTo !== 'none') {
      const roundToMinutes = Number.parseInt(newEntryRoundTo);
      totalMinutes = Math.round(totalMinutes / roundToMinutes) * roundToMinutes;
    }

    // Mirror of the API's 24h/day cap (it also counts entries from other
    // projects, which are not loaded here), so a typo fails fast and readable.
    const projectedDayMinutes = minutesLoggedOnDay(entries, submitDate, editingEntryId) + totalMinutes;
    if (projectedDayMinutes > MAX_DAY_MINUTES) {
      toast.error(
        st('sweep.weldflow.timesheetPage.dayLimitExceeded', {
          date: format(submitDate, 'EEE, MMM d'),
          hours: hoursLabel(projectedDayMinutes),
        }),
      );
      return;
    }

    setIsSubmitting(true);
    try {
      const payload = {
        taskId: newEntryTaskId || undefined,
        description: newEntryDescription || newEntryTaskName || undefined,
        date: format(submitDate, 'yyyy-MM-dd'),
        durationMinutes: totalMinutes,
        isBillable: newEntryBillable,
        startTime: combineDateAndTime(submitDate, newEntryStartTime),
        endTime: combineDateAndTime(submitDate, newEntryEndTime),
      };
      const result = editingEntryId
        ? await timeEntriesApi.update(projectId, editingEntryId, payload)
        : await timeEntriesApi.create(projectId, payload);

      if (result.success) {
        toast.success(editingEntryId ? st('sweep.weldflow.timesheetPage.timeEntryUpdated') : st('sweep.weldflow.timesheetPage.timeEntryCreated'));
        setShowAddDialog(false);
        setEditingEntryId(null);
        setNewEntryTaskId('');
        setNewEntryTaskName('');
        setNewEntryHours('');
        setNewEntryMinutes('');
        setNewEntryDescription('');
        setNewEntryBillable(true);
        setNewEntryRoundTo('none');
        setNewEntryStartTime('');
        setNewEntryEndTime('');
        setSelectedDate(null);
        loadData();
      } else {
        toast.error(result.error || st('sweep.weldflow.timesheetPage.saveFailed'));
      }
    } catch {
      toast.error(st('sweep.weldflow.timesheetPage.saveFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Open add dialog in edit mode for an existing entry
  const openEditDialog = (entry: TimeEntry) => {
    setEditingEntryId(entry.id);
    setNewEntryTaskId(entry.taskId || '');
    setNewEntryTaskName(entry.task?.title || '');
    setNewEntryDescription(entry.description || '');
    const minutes = Math.max(0, Math.round(entry.duration));
    setNewEntryHours(String(Math.floor(minutes / 60)));
    setNewEntryMinutes(String(minutes % 60));
    setNewEntryBillable(entry.billable);
    setNewEntryStartTime(entry.startTime ? format(new Date(entry.startTime), 'HH:mm') : '');
    setNewEntryEndTime(entry.endTime ? format(new Date(entry.endTime), 'HH:mm') : '');
    setSelectedDate(new Date(entry.date));
    setShowAddDialog(true);
  };

  // Delete an entry
  const handleDeleteEntry = async (entryId: string) => {
    setDeletingEntryId(entryId);
    try {
      const result = await timeEntriesApi.delete(projectId, entryId);
      if (result.success) {
        toast.success(st('sweep.weldflow.timesheetPage.timeEntryDeleted'));
        loadData();
      } else {
        toast.error(result.error || st('sweep.weldflow.timesheetPage.deleteFailed'));
      }
    } catch {
      toast.error(st('sweep.weldflow.timesheetPage.deleteFailed'));
    } finally {
      setDeletingEntryId(null);
    }
  };

  const resetTimerFields = () => {
    setTimerTaskId('');
    setTimerTaskName('');
    setTimerDescription('');
  };

  // Start timer after dialog confirmation. The server owns the timer, so a
  // 409 here means one is already running (possibly started on another device).
  const startTimer = async () => {
    if (!timerTaskName && !timerTaskId && !timerDescription.trim()) {
      toast.error(tt.timerNeedsTaskOrDescription);
      return;
    }
    try {
      await startTimerMutation.mutateAsync({
        projectId,
        taskId: timerTaskId || undefined,
        description: timerDescription || timerTaskName || undefined,
        billable: timerBillable,
      });
      setShowTimerDialog(false);
      toast.success(tt.timerStarted);
    } catch (err) {
      if (err instanceof TimerAlreadyRunningError) {
        setShowTimerDialog(false);
        toast.error(tt.timerAlreadyRunning);
        return;
      }
      toast.error(tt.failedToStartTimer);
    }
  };

  // Stop the timer. The server derives the duration from startedAt and writes
  // the entry, so the elapsed time is authoritative even if this tab slept.
  const stopTimerAndSave = async () => {
    try {
      const entry = await stopTimerMutation.mutateAsync({});
      let durationMinutes = Math.max(1, Math.round(Number(entry.duration)));

      // Rounding is a client-side preference, so it's applied as a follow-up
      // edit to the entry the server just created.
      if (timerRoundTo !== 'none') {
        const roundTo = Number.parseInt(timerRoundTo);
        const rounded = Math.max(roundTo, Math.round(durationMinutes / roundTo) * roundTo);
        if (rounded !== durationMinutes) {
          durationMinutes = rounded;
          await timeEntriesApi.update(projectId, entry.id, { durationMinutes: rounded });
        }
      }

      toast.success(tt.loggedDuration.replace('{duration}', formatHoursMinutes(durationMinutes)));
      resetTimerFields();
      loadData();
    } catch {
      toast.error(st('sweep.weldflow.timesheetPage.saveFailed'));
    }
  };

  // Throw the running timer away without recording anything.
  const discardTimer = async () => {
    try {
      await discardTimerMutation.mutateAsync();
      resetTimerFields();
      toast.success(tt.timerDiscarded);
    } catch {
      toast.error(tt.failedToDiscardTimer);
    }
  };

  // Create a new task via the shared TaskDialog and auto-select it into the
  // log-time form.
  const handleTaskDialogSave = async (data: {
    title: string;
    description?: string;
    status: 'todo' | 'in_progress' | 'done' | string;
    priority?: 'low' | 'medium' | 'high';
    assigneeId?: string;
    assigneeIds?: string[];
    dueDate?: Date;
  }) => {
    setIsCreatingTask(true);
    try {
      const result = await tasksApi.create(projectId, {
        title: data.title,
        description: data.description || undefined,
        status: (data.status as 'todo' | 'in_progress' | 'done') ?? 'todo',
        priority: data.priority ?? 'medium',
        assigneeId: data.assigneeId ?? data.assigneeIds?.[0] ?? undefined,
        dueDate: data.dueDate?.toISOString(),
      });

      if (result.success && result.data) {
        const newTask = result.data;
        setTasks((prev) => [...prev, { id: newTask.id, title: newTask.title }]);
        setNewEntryTaskId(newTask.id);
        setNewEntryTaskName(newTask.title);
        setShowCreateTaskDialog(false);
        setShowAddDialog(true);
        toast.success(st('sweep.weldflow.timesheetPage.taskCreated'));
      } else {
        toast.error(result.error || st('sweep.weldflow.timesheetPage.taskCreateFailed'));
      }
    } catch {
      toast.error(st('sweep.weldflow.timesheetPage.taskCreateFailed'));
    } finally {
      setIsCreatingTask(false);
    }
  };

  // Week range display
  const weekRangeDisplay = useMemo(() => {
    const endOfWeek = new Date(currentWeekStart);
    endOfWeek.setDate(currentWeekStart.getDate() + 6);

    const startMonth = format(currentWeekStart, 'MMM');
    const endMonth = format(endOfWeek, 'MMM');
    const year = currentWeekStart.getFullYear();

    if (startMonth === endMonth) {
      return `${startMonth} ${currentWeekStart.getDate()} - ${endOfWeek.getDate()}, ${year}`;
    }
    return `${startMonth} ${currentWeekStart.getDate()} - ${endMonth} ${endOfWeek.getDate()}, ${year}`;
  }, [currentWeekStart]);

  // Month display
  const monthDisplay = useMemo(() => {
    return format(currentMonth, 'MMMM yyyy');
  }, [currentMonth]);

  // The active range as inclusive `yyyy-MM-dd` bounds, so the team view follows
  // the same week/month navigation the personal grid uses. Formatted from local
  // parts (not toISOString) — a UTC conversion shifts the boundary a day for
  // anyone east of GMT and would silently drop entries from the edges.
  const teamRange = useMemo(() => {
    const start =
      viewMode === 'week'
        ? currentWeekStart
        : new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
    const end =
      viewMode === 'week'
        ? new Date(currentWeekStart.getFullYear(), currentWeekStart.getMonth(), currentWeekStart.getDate() + 6)
        : new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0);
    return {
      fromDate: format(start, 'yyyy-MM-dd'),
      toDate: format(end, 'yyyy-MM-dd'),
      label: viewMode === 'week' ? format(start, 'yyyy-MM-dd') : format(start, 'yyyy-MM'),
    };
  }, [viewMode, currentWeekStart, currentMonth]);

  // Generate month weeks for calendar view
  const monthWeeks = useMemo(() => {
    const weeks: WeekDay[][] = [];
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);

    const startDate = new Date(firstDay);
    const dayOfWeek = firstDay.getDay();
    const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    startDate.setDate(firstDay.getDate() + diff);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    while (startDate <= lastDay || weeks.length === 0) {
      const week: WeekDay[] = [];
      for (let i = 0; i < 7; i++) {
        const date = new Date(startDate);
        date.setDate(startDate.getDate() + i);
        week.push({
          date,
          dayName: format(date, 'EEE'),
          dayNumber: date.getDate(),
          monthName: format(date, 'MMM'),
          isToday: date.getTime() === today.getTime(),
          isWeekend: date.getDay() === 0 || date.getDay() === 6,
        });
      }
      weeks.push(week);
      startDate.setDate(startDate.getDate() + 7);

      if (weeks.length > 6) break;
    }

    return weeks;
  }, [currentMonth]);

  // Navigate months
  const goToPreviousMonth = () => {
    const newMonth = new Date(currentMonth);
    newMonth.setMonth(newMonth.getMonth() - 1);
    setCurrentMonth(newMonth);
  };

  const goToNextMonth = () => {
    const newMonth = new Date(currentMonth);
    newMonth.setMonth(newMonth.getMonth() + 1);
    setCurrentMonth(newMonth);
  };

  // Open add dialog for specific cell
  const openAddDialogForCell = (taskId: string, taskName: string, date: Date) => {
    setSelectedDate(date);
    setNewEntryTaskId(taskId);
    setNewEntryTaskName(taskName);
    setShowAddDialog(true);
  };

  // Open add dialog for a specific day with no task preselected
  const openAddDialogForDate = (date: Date) => {
    setSelectedDate(date);
    setShowAddDialog(true);
  };

  // Open add dialog for today with no task preselected
  const openBlankAddDialog = () => {
    setSelectedDate(new Date());
    setNewEntryTaskId('');
    setNewEntryTaskName('');
    setShowAddDialog(true);
  };

  // Loading state
  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  // Error state
  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4">
          <AlertCircle className="h-12 w-12 text-red-400" />
          <p className="text-lg font-medium">{error}</p>
          <Button onClick={loadData}>{st('sweep.weldflow.timesheetPage.retry')}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-[53px] border-b border-border bg-background">
        <div className="flex items-center gap-2">
          {/* Mine / Team — only for project managers and owners. */}
          {canSeeTeam && (
            <div className="flex items-center rounded-md border border-border p-0.5">
              {(
                [
                  ['mine', st('sweep.weldflow.timesheetPage.audienceMine')],
                  ['team', st('sweep.weldflow.timesheetPage.audienceTeam')],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  variant="ghost"
                  size="sm"
                  onClick={() => setAudience(value)}
                  className={cn(
                    'h-7 px-2.5 text-sm shadow-none',
                    audience === value
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                </Button>
              ))}
            </div>
          )}

          {/* Filter Pills — the grid's own filters; the team view has none yet. */}
          {!showTeamView && (
            <div className="hidden md:flex items-center">
              <FilterPills
                filters={activeFilters}
                filterConfigs={filterConfigs}
                maxFilters={5}
                onFiltersChange={setActiveFilters}
              />
            </div>
          )}

          {/* View Mode Select */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 w-[90px] justify-between shadow-none text-sm text-muted-foreground">
                {{ week: tt.viewWeek, month: tt.viewMonth }[viewMode]}
                <ChevronDown className="h-3.5 w-3.5 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[90px] p-1">
              {([['week', tt.viewWeek], ['month', tt.viewMonth]] as const).map(([value, label]) => (
                <Button
                  key={value}
                  variant="ghost"
                  onClick={() => setViewMode(value)}
                  className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded h-auto"
                >
                  <span>{label}</span>
                  {viewMode === value && <Check className="h-3.5 w-3.5" />}
                </Button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Navigation */}
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={viewMode === 'week' ? goToPreviousWeek : goToPreviousMonth}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={viewMode === 'week' ? goToNextWeek : goToNextMonth}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {/* Date Picker */}
          <Popover open={headerDatePickerOpen} onOpenChange={setHeaderDatePickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 px-1 shadow-none font-medium text-sm -ml-2"
              >
                <span className="hidden md:inline">
                  {viewMode === 'week' ? weekRangeDisplay : monthDisplay}
                </span>
                <span className="md:hidden">
                  {viewMode === 'week'
                    ? `${format(currentWeekStart, 'MMM d')} - ${format(new Date(currentWeekStart.getTime() + 6 * 24 * 60 * 60 * 1000), 'd')}`
                    : format(currentMonth, 'MMM yyyy')
                  }
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start" sideOffset={8}>
              <Calendar
                mode="single"
                selected={viewMode === 'week' ? currentWeekStart : currentMonth}
                month={viewMode === 'week' ? currentWeekStart : currentMonth}
                onMonthChange={(month) => {
                  if (viewMode === 'month') {
                    setCurrentMonth(month);
                  }
                }}
                captionLayout="dropdown"
                onSelect={(date) => {
                  if (!date) return;
                  if (viewMode === 'week') {
                    const dayOfWeek = date.getDay();
                    const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
                    const monday = new Date(date);
                    monday.setDate(date.getDate() + diff);
                    monday.setHours(0, 0, 0, 0);
                    setCurrentWeekStart(monday);
                  } else {
                    setCurrentMonth(new Date(date.getFullYear(), date.getMonth(), 1));
                  }
                  setHeaderDatePickerOpen(false);
                }}
              />
              <div className="border-t px-3 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full h-8 text-sm"
                  onClick={() => {
                    goToToday();
                    if (viewMode === 'month') {
                      setCurrentMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
                    }
                    setHeaderDatePickerOpen(false);
                  }}
                >
                  {st('sweep.weldflow.notesView.today')}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex items-center gap-2">
          <TimesheetSearchBox
            searchOpen={searchOpen}
            setSearchOpen={setSearchOpen}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            searchInputRef={searchInputRef}
          />

          {/* Timer — start, or stop the one already running. The running timer
              is server state, so this reflects timers started elsewhere too. */}
          {isTimerRunning ? (
            <div className="flex items-center gap-1">
              <span className="font-mono text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatTimer(timerSeconds)}
              </span>
              <Button
                size="sm"
                variant="default"
                className="h-8 shadow-none"
                onClick={stopTimerAndSave}
                disabled={stopTimerMutation.isPending}
              >
                <Square className="h-3.5 w-3.5 mr-1 fill-current" />
                <span className="hidden md:inline">{tt.stop}</span>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2 shadow-none"
                onClick={discardTimer}
                disabled={discardTimerMutation.isPending}
                title={tt.discardTimer}
                aria-label={tt.discardTimer}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-8 shadow-none"
              onClick={() => setShowTimerDialog(true)}
            >
              <Play className="h-3.5 w-3.5 mr-1" />
              <span className="hidden md:inline">{tt.startTimer}</span>
            </Button>
          )}

          {/* Add Entry Button */}
          <Button
            size="sm"
            className="h-8 bg-primary text-primary-foreground hover:bg-primary/90 shadow-none"
            onClick={() => {
              setSelectedDate(new Date());
              setShowAddDialog(true);
            }}
          >
            <Plus className="h-4 w-4 mr-0.5" />
            <span className="hidden md:inline">{st('sweep.weldflow.timesheetPage.logTime')}</span>
          </Button>
        </div>
      </div>

      {showTeamView ? (
        <TeamTimesheetView
          projectId={projectId}
          fromDate={teamRange.fromDate}
          toDate={teamRange.toDate}
          rangeLabel={teamRange.label}
        />
      ) : (
        <TimesheetGrid
          viewMode={viewMode}
          weekDays={weekDays}
          monthWeeks={monthWeeks}
          currentMonth={currentMonth}
          entries={entries}
          uniqueTaskNames={uniqueTaskNames}
          weeklyTotal={weeklyTotal}
          deletingEntryId={deletingEntryId}
          getEntriesForCell={getEntriesForCell}
          getTotalHoursForDate={getTotalHoursForDate}
          getTotalHoursForTask={getTotalHoursForTask}
          openAddDialogForCell={openAddDialogForCell}
          openAddDialogForDate={openAddDialogForDate}
          openBlankAddDialog={openBlankAddDialog}
          openEditDialog={openEditDialog}
          setEntryToDelete={setEntryToDelete}
        />
      )}

      <AddEntryDialog
        tasks={tasks}
        showAddDialog={showAddDialog}
        setShowAddDialog={setShowAddDialog}
        editingEntryId={editingEntryId}
        setEditingEntryId={setEditingEntryId}
        setShowCreateTaskDialog={setShowCreateTaskDialog}
        newEntryDescription={newEntryDescription}
        setNewEntryDescription={setNewEntryDescription}
        newEntryTaskId={newEntryTaskId}
        setNewEntryTaskId={setNewEntryTaskId}
        newEntryTaskName={newEntryTaskName}
        setNewEntryTaskName={setNewEntryTaskName}
        newEntryHours={newEntryHours}
        setNewEntryHours={setNewEntryHours}
        newEntryMinutes={newEntryMinutes}
        setNewEntryMinutes={setNewEntryMinutes}
        newEntryStartTime={newEntryStartTime}
        setNewEntryStartTime={setNewEntryStartTime}
        newEntryEndTime={newEntryEndTime}
        setNewEntryEndTime={setNewEntryEndTime}
        newEntryRoundTo={newEntryRoundTo}
        setNewEntryRoundTo={setNewEntryRoundTo}
        newEntryBillable={newEntryBillable}
        setNewEntryBillable={setNewEntryBillable}
        selectedDate={selectedDate}
        setSelectedDate={setSelectedDate}
        isSubmitting={isSubmitting}
        handleAddEntry={handleAddEntry}
        otherMinutesOnDay={selectedDate ? minutesLoggedOnDay(entries, selectedDate, editingEntryId) : 0}
      />

      <StartTimerDialog
        tasks={tasks}
        showTimerDialog={showTimerDialog}
        setShowTimerDialog={setShowTimerDialog}
        timerDescription={timerDescription}
        setTimerDescription={setTimerDescription}
        timerTaskId={timerTaskId}
        setTimerTaskId={setTimerTaskId}
        timerTaskName={timerTaskName}
        setTimerTaskName={setTimerTaskName}
        timerRoundTo={timerRoundTo}
        setTimerRoundTo={setTimerRoundTo}
        timerBillable={timerBillable}
        setTimerBillable={setTimerBillable}
        startTimer={startTimer}
      />

      {/* Create Task Dialog — same shared TaskDialog used on the tasks page. */}
      <TaskDialog
        open={showCreateTaskDialog}
        onOpenChange={(open) => {
          setShowCreateTaskDialog(open);
          if (!open) setShowAddDialog(true);
        }}
        editingTask={null}
        availableAssignees={projectMembers
          .filter((m) => m.user?.name)
          .map((m) => ({ id: m.userId, name: m.user!.name, avatar: m.user?.avatar }))}
        availableCompanies={[]}
        hideRecord
        projectId={projectId}
        onSave={handleTaskDialogSave}
        onUpdate={() => {}}
        isPending={isCreatingTask}
      />

      <ConfirmDialog
        open={!!entryToDelete}
        onOpenChange={(open) => {
          if (!open) setEntryToDelete(null);
        }}
        title={st('sweep.weldflow.timesheetPage.deleteTimeEntryTitle')}
        description={entryToDelete ? <DeleteEntryDescription entry={entryToDelete} /> : null}
        confirmLabel={st('sweep.weldflow.delete')}
        variant="destructive"
        loading={deletingEntryId === entryToDelete?.id}
        onConfirm={async () => {
          if (!entryToDelete) return;
          await handleDeleteEntry(entryToDelete.id);
          setEntryToDelete(null);
        }}
      />
    </div>
  );
}
