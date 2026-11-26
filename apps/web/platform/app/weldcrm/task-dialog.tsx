
import { useState, useRef, useEffect, useLayoutEffect, useCallback, type ComponentProps, type ReactNode } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@weldsuite/ui/components/command';
import { Calendar } from '@weldsuite/ui/components/calendar';
import { PickerCheck, PickerScrollArea, focusPickerList } from '@weldsuite/ui/components/picker-menu';
import {
  X,
  Check,
  Repeat2,
  Loader2,
  Paperclip,
  Upload,
  Github,
  CircleDashed,
  SignalHigh,
  Tag,
  Hourglass,
  CalendarDays,
  Users,
  Link2,
  Plus,
  type LucideIcon,
} from 'lucide-react';
import { ColoredSquareIcon } from '@/components/layout/colored-square-icon';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import type { Task } from '@/hooks/use-crm-tasks';
import { useFileUpload } from '@/hooks/use-file-upload';
import { toast } from 'sonner';
import { useLinkedRepos } from '@/hooks/queries/use-github-queries';
import { getTranslations } from '@/lib/i18n';
import { useTranslations } from '@weldsuite/i18n/client';
import { RepeatConfigMenu, repeatLabel, type RepeatFrequency, type RepeatUnit } from '@/components/tasks/repeat-config';
import { RecordKindBadge } from '@/components/objects/_shared/record-kind-badge';
import { DURATION_PRESETS, formatMinutes } from '@/components/tasks/task-duration';
import { InlineLabelCreator } from '@/components/tasks/inline-label-creator';
import { runEditorCommand } from '@weldsuite/ui/lib/editor-commands';

const statusConfig = {
  'backlog': { label: 'Backlog', color: 'bg-gray-100 text-gray-800 dark:bg-background/30 dark:text-muted-foreground', btnColor: 'bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200 dark:bg-secondary dark:text-muted-foreground dark:border-border' },
  'todo': { label: 'To Do', color: 'bg-gray-100 text-gray-800 dark:bg-background/30 dark:text-muted-foreground', btnColor: 'bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200 dark:bg-secondary dark:text-muted-foreground dark:border-border' },
  'in_progress': { label: 'In Progress', color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400', btnColor: 'bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800' },
  'review': { label: 'In Review', color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400', btnColor: 'bg-yellow-100 text-yellow-800 border-yellow-200 hover:bg-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800' },
  'testing': { label: 'Testing', color: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400', btnColor: 'bg-purple-100 text-purple-800 border-purple-200 hover:bg-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800' },
  'done': { label: 'Done', color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400', btnColor: 'bg-green-100 text-green-800 border-green-200 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800' },
  'cancelled': { label: 'Cancelled', color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400', btnColor: 'bg-red-100 text-red-800 border-red-200 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800' },
};

const priorityConfig = {
  'low': { label: 'Low', color: 'bg-gray-100 text-gray-600 dark:bg-secondary dark:text-muted-foreground', btnColor: 'bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-200 dark:bg-secondary dark:text-muted-foreground dark:border-border' },
  'medium': { label: 'Medium', color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400', btnColor: 'bg-yellow-100 text-yellow-800 border-yellow-200 hover:bg-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800' },
  'high': { label: 'High', color: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400', btnColor: 'bg-orange-100 text-orange-800 border-orange-200 hover:bg-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800' },
  'urgent': { label: 'Urgent', color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400', btnColor: 'bg-red-100 text-red-800 border-red-200 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800' },
};


interface LabelOption {
  id: string;
  name: string;
  color: string;
  projectId?: string | null;
}

// Project labels (created in project settings) store their color as a Tailwind class name (e.g. "bg-blue-500"),
// while labels created inline from this dialog store hex values (e.g. "#3b82f6"). Map both to a CSS color
// so the badge always has a visible background.
const TAILWIND_CLASS_TO_HEX: Record<string, string> = {
  'bg-red-500': '#ef4444',
  'bg-pink-500': '#ec4899',
  'bg-purple-500': '#a855f7',
  'bg-indigo-500': '#6366f1',
  'bg-blue-500': '#3b82f6',
  'bg-cyan-500': '#06b6d4',
  'bg-teal-500': '#14b8a6',
  'bg-green-500': '#22c55e',
  'bg-yellow-500': '#eab308',
  'bg-orange-500': '#f97316',
  'bg-amber-500': '#f59e0b',
  'bg-gray-500': '#6b7280',
};
function resolveLabelColor(color: string | null | undefined): string {
  if (!color) return '#6b7280';
  if (color.startsWith('#')) return color;
  return TAILWIND_CLASS_TO_HEX[color] ?? '#6b7280';
}

/**
 * Pick a readable text color (white or near-black) for a label pill given its
 * background hex. Hardcoding `text-white` everywhere makes light/pastel custom
 * labels (e.g. a near-white background a user picked in settings) unreadable.
 */
function readableLabelTextColor(bgHex: string): string {
  const raw = bgHex.replace('#', '').trim();
  let hex: string | null = null;
  if (raw.length === 3) hex = raw.split('').map((c) => c + c).join('');
  else if (raw.length === 6) hex = raw;
  if (!hex) return '#ffffff';
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return '#ffffff';
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 160 ? '#1f2937' : '#ffffff';
}

interface TaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingTask: Task | null;
  /** `departed`: no longer a workspace member, offered only on a task they are already on. */
  availableAssignees: string[] | { id: string; name: string; avatar?: string; departed?: boolean }[];
  /** `icon` + `iconColor` draw a colored square instead of an avatar (WeldFlow projects). */
  availableCompanies: Array<string | { id: string; name: string; avatar?: string; type?: string; icon?: LucideIcon; iconColor?: string | null }>;
  /** Offered alongside companies in the record picker — a task can link to a person instead. */
  availablePeople?: Array<string | { id: string; name: string; avatar?: string; type?: string }>;
  onRecordSearchChange?: (query: string) => void;
  recordRequired?: boolean;
  availableLabels?: LabelOption[];
  onCreateLabel?: (data: { name: string; color: string }) => Promise<LabelOption | null>;
  defaultRecord?: string;
  defaultAssignee?: string;
  /** Pre-selects the status field — e.g. the column a board "New task" button was clicked in. */
  defaultStatus?: Task['status'];
  recordLabel?: string;
  /** What the record row is called ("Project" in WeldFlow); "Linked to" by default. */
  recordRowLabel?: string;
  /** The record row's icon; a link by default. */
  recordIcon?: LucideIcon;
  /** Lets the record picker create a record by name ("Create project"); returns the new option, or null when it failed. */
  onCreateRecord?: (name: string) => Promise<CompanyOption | null>;
  /** The record picker's create line and the name field's placeholder; needed with `onCreateRecord`. */
  createRecordLabels?: { create: string; namePlaceholder: string };
  /** Override the record picker's search placeholder and empty state when it lists something other than CRM records (WeldFlow projects). */
  recordSearchPlaceholder?: string;
  recordEmptyLabel?: string;
  hideRecord?: boolean;
  /**
   * The record the task belongs to when the dialog is opened from that record
   * (a company or person panel): shown as the selected record and not
   * changeable. The caller links the task to it on save; the dialog's own
   * record field is not used.
   */
  lockedRecord?: { id: string; name: string; avatar?: string };
  projectId?: string;
  // When provided, the status dropdown renders these options (project-specific
  // pipeline stages) instead of the built-in `statusConfig`. Values are stage IDs.
  availableStatuses?: Array<{ id: string; label: string; color?: string }>;
  onSave: (data: {
    title: string;
    description?: string;
    status: Task['status'];
    priority?: PriorityValue;
    assigneeId?: string;
    assigneeIds?: string[];
    dueDate?: Date;
    duration?: number;
    linkedCompanyId?: string;
    personId?: string;
    labels?: string[];
    repeat?: {
      frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom';
      interval?: number;
      unit?: 'days' | 'weeks' | 'months' | 'years';
    };
  }) => void;
  onUpdate: (taskId: string, data: {
    title: string;
    description?: string;
    status: Task['status'];
    priority?: PriorityValue;
    /** The assignees picked in the dialog (empty = none). */
    assigneeIds?: string[];
    /** `null` = the user cleared the due date (`undefined` would be dropped by JSON and keep the stored one). */
    dueDate?: Date | null;
    duration?: number;
    linkedCompany?: { id: string; name: string } | null;
    linkedPerson?: { id: string; name: string } | null;
    /** The labels picked in the dialog; `[]` = none (the caller must send it, not skip it). */
    labels?: string[];
    /** `null` = recurrence removed. */
    repeat?: {
      frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom';
      interval?: number;
      unit?: 'days' | 'weeks' | 'months' | 'years';
    } | null;
  }) => void;
  isPending: boolean;
}

/** Convert markdown image/link syntax to HTML for contentEditable display */
function markdownToHtml(md: string): string {
  return md
    // Images: ![alt](url) → <img>
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;max-height:200px;border-radius:6px;margin:4px 0;display:block;" />')
    // Links: [text](url) → <a>
    .replace(/\[([^[\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:var(--primary);text-decoration:underline;">$1</a>')
    // Newlines to <br>
    .replace(/\n/g, '<br>');
}

/** Convert HTML from contentEditable back to markdown */
function htmlToMarkdown(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;

  function walk(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    if (tag === 'img') {
      const src = el.getAttribute('src') || '';
      const alt = el.getAttribute('alt') || '';
      return `![${alt}](${src})`;
    }
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      const text = el.textContent || '';
      return `[${text}](${href})`;
    }
    if (tag === 'br') return '\n';
    if (tag === 'div' || tag === 'p') {
      const inner = Array.from(el.childNodes).map(walk).join('');
      return inner + '\n';
    }
    return Array.from(el.childNodes).map(walk).join('');
  }

  return Array.from(div.childNodes).map(walk).join('').replace(/\n$/, '');
}


type PriorityValue = 'low' | 'medium' | 'high';
/** What the form can hold: an existing task may carry 'urgent', which the picker only displays and never sends (omitting it keeps the stored value instead of downgrading it). */
type PriorityState = PriorityValue | 'urgent';
type RepeatValue = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom';
type RepeatUnitValue = 'days' | 'weeks' | 'months' | 'years';
type AssigneeOption = { id: string; name: string; avatar?: string; departed?: boolean };
type CompanyOption = { id: string; name: string; avatar?: string; type?: string; icon?: LucideIcon; iconColor?: string | null };

function normalizeAssignee(a: string | AssigneeOption): AssigneeOption {
  return typeof a === 'string' ? { id: a, name: a, avatar: undefined } : a;
}

type RecordType = 'company' | 'person' | null;

/** What kind of record a task is linked to. */
function linkedRecordType(task: { linkedPerson?: unknown; linkedCompany?: unknown }): RecordType {
  if (task.linkedPerson) return 'person';
  if (task.linkedCompany) return 'company';
  return null;
}

/** What kind of record a picked option is (a company unless it says person). */
function optionRecordType(option: CompanyOption | null): RecordType {
  if (!option) return null;
  return option.type === 'person' ? 'person' : 'company';
}

/** The linked record as the API takes it: on the company or on the person side. */
function linkedRecord(record: string | null, recordType: RecordType, name: string) {
  const link = record ? { id: record, name } : null;
  return recordType === 'person' ? { company: null, person: link } : { company: link, person: null };
}

function toggleValue(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function buildRepeatData(repeat: RepeatValue | null, interval: number, unit: RepeatUnitValue) {
  if (!repeat) return undefined;
  return {
    frequency: repeat,
    interval: repeat === 'custom' ? interval : undefined,
    unit: repeat === 'custom' ? unit : undefined,
  };
}

interface TaskFormState {
  title: string;
  description: string;
  status: string;
  priority: PriorityState | null;
  assigneeList: string[];
  dueDate: Date | undefined;
  duration: number | null;
  record: string | null;
  recordName: string | null;
  recordType: 'company' | 'person' | null;
  repeat: RepeatValue | null;
  repeatInterval: number;
  repeatUnit: RepeatUnitValue;
  selectedLabels: string[];
}

/** Initial form values for the dialog: the edited task's fields, or the create defaults. */
function getInitialFormState(
  editingTask: Task | null,
  defaultAssignee: string | undefined,
  defaultRecord: string | undefined,
  defaultStatus: Task['status'] | undefined,
): TaskFormState {
  if (!editingTask) {
    return {
      title: '',
      description: '',
      status: defaultStatus ?? 'todo',
      priority: null,
      assigneeList: defaultAssignee ? [defaultAssignee] : [],
      dueDate: undefined,
      duration: 30,
      record: defaultRecord || null,
      recordName: defaultRecord || null,
      recordType: defaultRecord ? 'company' : null,
      repeat: null,
      repeatInterval: 1,
      repeatUnit: 'days',
      selectedLabels: [],
    };
  }
  return {
    title: editingTask.title,
    description: editingTask.description || '',
    status: editingTask.status,
    priority: editingTask.priority || null,
    assigneeList:
      editingTask.assignees?.map(a => a.id) ||
      (editingTask.assignee?.id ? [editingTask.assignee.id] : []),
    dueDate: editingTask.dueDate,
    duration: editingTask.duration ?? null,
    record: editingTask.linkedPerson?.id || editingTask.linkedCompany?.id || null,
    recordName: editingTask.linkedPerson?.name || editingTask.linkedCompany?.name || null,
    recordType: linkedRecordType(editingTask),
    repeat: editingTask.repeat?.frequency || null,
    repeatInterval: editingTask.repeat?.interval || 1,
    repeatUnit: editingTask.repeat?.unit || 'days',
    selectedLabels: editingTask.labels || [],
  };
}

/** Fields shared by the create and update payloads. */
function buildCommonPayload(form: TaskFormState, description: string) {
  return {
    title: form.title,
    description: description || undefined,
    status: form.status as Task['status'],
    // An urgent task keeps its priority: it is not sent, so the edit cannot
    // downgrade it to "high" (the picker has no urgent option to send).
    priority: form.priority && form.priority !== 'urgent' ? form.priority : undefined,
    dueDate: form.dueDate,
    duration: form.duration ?? undefined,
    labels: form.selectedLabels.length > 0 ? form.selectedLabels : undefined,
    repeat: buildRepeatData(form.repeat, form.repeatInterval, form.repeatUnit),
  };
}

/** Keep the caret in view as the user types past the visible area of the description. */
function scrollCaretIntoView(div: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(false);
  const rects = range.getClientRects();
  const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
  const containerRect = div.getBoundingClientRect();
  if (rect.bottom > containerRect.bottom) {
    div.scrollTop += rect.bottom - containerRect.bottom + 4;
  } else if (rect.top < containerRect.top) {
    div.scrollTop -= containerRect.top - rect.top + 4;
  }
}

// ── Toolbar popovers ─────────────────────────────────────────────────────────

/**
 * One row of the details column: an icon and what it is on the left, the
 * value on the right. The whole row is the button that opens its picker
 * (pass it as a `PopoverTrigger` child).
 */
function DetailRow({ icon: Icon, label, children, className, ...props }: Readonly<ComponentProps<'button'> & { icon: LucideIcon; label: string }>) {
  return (
    <button
      type="button"
      className={cn(
        'flex h-11 w-full min-w-0 items-center justify-between gap-3 border-b border-border px-4 text-left text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 disabled:cursor-default disabled:hover:bg-transparent',
        className,
      )}
      {...props}
    >
      <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
        <Icon className="size-4" />
        {label}
      </span>
      <span className="flex min-w-0 items-center justify-end gap-1.5">{children}</span>
    </button>
  );
}

/** A row's value when nothing is set: "None", "Never", "Unassigned". */
function EmptyValue({ children }: Readonly<{ children: ReactNode }>) {
  return <span className="truncate text-muted-foreground/70">{children}</span>;
}

function StatusPopover({
  status,
  availableStatuses,
  onChange,
}: Readonly<{
  status: string;
  availableStatuses: TaskDialogProps['availableStatuses'];
  onChange: (status: string) => void;
}>) {
  const tCrm = getTranslations('crm');
  // Translated status labels (fall back to statusConfig keys for custom statuses)
  const translatedStatusLabels: Record<string, string> = {
    backlog: tCrm.tasks.status.backlog,
    todo: tCrm.tasks.status.todo,
    in_progress: tCrm.tasks.status.inProgress,
    review: tCrm.tasks.status.inReview,
    testing: tCrm.tasks.status.testing,
    done: tCrm.tasks.status.done,
    cancelled: tCrm.tasks.status.cancelled,
  };
  const currentCustom = availableStatuses?.find(s => s.id === status);
  const builtIn = statusConfig[status as keyof typeof statusConfig];
  const buttonLabel = availableStatuses
    ? (currentCustom?.label ?? tCrm.taskDialog.statusFallback)
    : (translatedStatusLabels[status] || builtIn?.label || tCrm.taskDialog.statusFallback);
  const options = availableStatuses
    ? availableStatuses.map(s => ({ key: s.id, label: s.label, color: s.color }))
    : Object.entries(statusConfig).map(([key, config]) => ({ key, label: translatedStatusLabels[key] || config.label, color: undefined as string | undefined }));

  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <DetailRow icon={CircleDashed} label={tCrm.taskDialog.statusFallback}>
          {currentCustom?.color && <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: currentCustom.color }} />}
          <span className="truncate">{buttonLabel}</span>
        </DetailRow>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-0" align="start" onOpenAutoFocus={focusPickerList}>
        <Command className="outline-hidden">
          <CommandList className="max-h-none overflow-visible">
            <PickerScrollArea>
              <CommandGroup>
                {options.map(({ key, label, color }) => (
                  <CommandItem
                    key={key}
                    value={`${label} ${key}`}
                    onSelect={() => {
                      onChange(key);
                      setOpen(false);
                    }}
                  >
                    {color && <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />}
                    {label}
                    <PickerCheck selected={status === key} />
                  </CommandItem>
                ))}
              </CommandGroup>
            </PickerScrollArea>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function PriorityPopover({
  priority,
  onChange,
}: Readonly<{ priority: PriorityState | null; onChange: (priority: PriorityValue | null) => void }>) {
  const tCrm = getTranslations('crm');
  const translatedPriorityLabels: Record<string, string> = {
    low: tCrm.tasks.priority.low,
    medium: tCrm.tasks.priority.medium,
    high: tCrm.tasks.priority.high,
    urgent: tCrm.tasks.priority.urgent,
  };
  const [open, setOpen] = useState(false);
  const pick = (next: PriorityValue | null) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <DetailRow icon={SignalHigh} label={tCrm.taskDialog.priorityFallback}>
          {priority ? (
            <span className="truncate">{translatedPriorityLabels[priority] || priorityConfig[priority]?.label}</span>
          ) : (
            <EmptyValue>{tCrm.taskDialog.none}</EmptyValue>
          )}
        </DetailRow>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-0" align="start" onOpenAutoFocus={focusPickerList}>
        <Command className="outline-hidden">
          <CommandList>
            <CommandGroup>
              {/* "None" first, as in the duration picker. */}
              <CommandItem value="none" onSelect={() => pick(null)}>
                {tCrm.taskDialog.none}
                <PickerCheck selected={!priority} />
              </CommandItem>
              {Object.entries(priorityConfig).filter(([key]) => key !== 'urgent').map(([key, config]) => (
                <CommandItem key={key} value={key} onSelect={() => pick(key as PriorityValue)}>
                  {translatedPriorityLabels[key] || config.label}
                  <PickerCheck selected={priority === key} />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function LabelsPopover({
  selectedLabels,
  availableLabels,
  activeProjectId,
  onChange,
  onCreateLabel,
}: Readonly<{
  selectedLabels: string[];
  availableLabels: LabelOption[];
  activeProjectId: string | null | undefined;
  onChange: React.Dispatch<React.SetStateAction<string[]>>;
  onCreateLabel?: (data: { name: string; color: string }) => Promise<LabelOption | null>;
}>) {
  const tCrm = getTranslations('crm');
  // Only show labels that belong to the active project (or workspace-wide
  // labels with no projectId).
  const visibleLabels = availableLabels.filter(
    (l) => !l.projectId || l.projectId === activeProjectId,
  );
  const st = useTranslations();
  // "+ Create label" opens the name field under the list.
  const [creating, setCreating] = useState(false);

  return (
    <Popover onOpenChange={(open) => !open && setCreating(false)}>
      <PopoverTrigger asChild>
        <DetailRow icon={Tag} label={tCrm.taskDialog.labelsFallback}>
          {selectedLabels.length > 0 ? (
            <span className="flex items-center gap-1">
              {selectedLabels.slice(0, 2).map((id) => {
                const label = availableLabels.find(l => l.id === id);
                return label ? (
                  <span
                    key={id}
                    className="inline-flex items-center px-1.5 py-px rounded text-[11px] font-medium border-transparent"
                    style={{
                      backgroundColor: resolveLabelColor(label.color),
                      color: readableLabelTextColor(resolveLabelColor(label.color)),
                    }}
                  >
                    {label.name}
                  </span>
                ) : null;
              })}
              {selectedLabels.length > 2 && <span className="text-muted-foreground">+{selectedLabels.length - 2}</span>}
            </span>
          ) : (
            <EmptyValue>{tCrm.taskDialog.none}</EmptyValue>
          )}
        </DetailRow>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-0" align="start" onOpenAutoFocus={focusPickerList}>
        <Command className="outline-hidden">
          <CommandList className="max-h-none overflow-visible">
            <PickerScrollArea>
              {visibleLabels.length > 0 ? (
                <CommandGroup>
                  {/* "None" first, in place of a Clear all at the bottom. */}
                  <CommandItem value="none" onSelect={() => onChange([])}>
                    {tCrm.taskDialog.none}
                    <PickerCheck selected={selectedLabels.length === 0} />
                  </CommandItem>
                  {visibleLabels.map((label) => {
                    const isSelected = selectedLabels.includes(label.id);
                    return (
                      <CommandItem key={label.id} value={`${label.name} ${label.id}`} onSelect={() => onChange((prev) => toggleValue(prev, label.id))}>
                        <span
                          className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border-transparent"
                          style={{
                            backgroundColor: resolveLabelColor(label.color),
                            color: readableLabelTextColor(resolveLabelColor(label.color)),
                          }}
                        >
                          {label.name}
                        </span>
                        <PickerCheck selected={isSelected} />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ) : (
                !onCreateLabel && (
                  <div className="px-2 py-6 text-center text-sm text-muted-foreground">
                    {activeProjectId ? tCrm.taskDialog.noLabelsForProject : tCrm.taskDialog.selectProjectForLabels}
                  </div>
                )
              )}
            </PickerScrollArea>
            {onCreateLabel && (
              <>
                {visibleLabels.length > 0 && <CommandSeparator />}
                <CommandGroup>
                  <CommandItem value="create-label" onSelect={() => setCreating(true)}>
                    <Plus />
                    {st('sweep.shared.createLabel')}
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
        {/* Outside the list, so typing a new label's name is not read as list keys. */}
        {onCreateLabel && creating && (
          <div className="border-t p-1">
            <InlineLabelCreator
              autoFocus
              existingNames={visibleLabels.map((l) => l.name)}
              onCreate={async (data) => {
                const created = await onCreateLabel(data);
                if (created) {
                  onChange((prev) => [...prev, created.id]);
                  setCreating(false);
                }
                return created;
              }}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The duration picker, built like the platform's other field pickers: shadcn's Command list with
 * a check on the right of the chosen line (None, the presets, Custom). Custom keeps the list
 * open and shows a minutes field under it.
 */
function DurationPopover({
  duration,
  onChange,
}: Readonly<{ duration: number | null; onChange: (duration: number | null) => void }>) {
  const tCrm = getTranslations('crm');
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const isCustom = duration != null && !DURATION_PRESETS.includes(duration);
  let selected = 'custom';
  if (duration == null && !customOpen) selected = 'none';
  else if (duration != null && !isCustom && !customOpen) selected = String(duration);
  const pick = (next: number | null) => {
    onChange(next);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setCustomOpen(false);
      }}
    >
      <PopoverTrigger asChild>
        <DetailRow icon={Hourglass} label={tCrm.taskDialog.durationFallback}>
          {duration != null ? <span className="tabular-nums">{formatMinutes(duration)}</span> : <EmptyValue>{tCrm.taskDialog.none}</EmptyValue>}
        </DetailRow>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-0" align="start" onOpenAutoFocus={focusPickerList}>
        <Command>
          <CommandList>
            <CommandGroup>
              <CommandItem value="none" onSelect={() => pick(null)}>
                {tCrm.taskDialog.none}
                <PickerCheck selected={selected === 'none'} />
              </CommandItem>
              {DURATION_PRESETS.map((mins) => (
                <CommandItem key={mins} value={String(mins)} onSelect={() => pick(mins)}>
                  {formatMinutes(mins)}
                  <PickerCheck selected={selected === String(mins)} />
                </CommandItem>
              ))}
              <CommandItem value="custom" onSelect={() => setCustomOpen(true)}>
                {tCrm.taskDialog.custom}
                <PickerCheck selected={selected === 'custom'} />
              </CommandItem>
            </CommandGroup>
          </CommandList>
          {(customOpen || isCustom) && (
            <div className="border-t p-2">
              <Input
                type="number"
                min="0"
                autoFocus={customOpen}
                value={isCustom ? duration : ''}
                onChange={(e) => onChange(e.target.value ? Number.parseInt(e.target.value, 10) : null)}
                // Keep the keys in the field: the list would read Enter and the arrows as its own.
                onKeyDown={(e) => e.stopPropagation()}
                placeholder={tCrm.taskDialog.minutes}
                aria-label={tCrm.taskDialog.customMinutes}
                className="h-8 text-sm"
              />
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function DueDatePopover({
  dueDate,
  onChange,
}: Readonly<{ dueDate: Date | undefined; onChange: (date: Date | undefined) => void }>) {
  const tCrm = getTranslations('crm');
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <DetailRow icon={CalendarDays} label={tCrm.taskDialog.dueDateFallback}>
          {dueDate ? <span className="tabular-nums">{format(dueDate, 'EEE, MMM d')}</span> : <EmptyValue>{tCrm.taskDialog.none}</EmptyValue>}
        </DetailRow>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        {/* "None" first, as in the other pickers, in place of a Clear under the calendar. */}
        <Command className="h-auto rounded-none border-b outline-hidden">
          <CommandList>
            <CommandGroup>
              <CommandItem
                value="none"
                onSelect={() => {
                  onChange(undefined);
                  setOpen(false);
                }}
              >
                {tCrm.taskDialog.none}
                <PickerCheck selected={!dueDate} />
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
        {/* shadcn's calendar with month and year dropdowns: from this year to ten years ahead. */}
        <Calendar
          mode="single"
          captionLayout="dropdown"
          selected={dueDate}
          defaultMonth={dueDate}
          onSelect={onChange}
          startMonth={new Date(new Date().getFullYear(), 0)}
          endMonth={new Date(new Date().getFullYear() + 10, 11)}
          disabled={(date) => {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            return date < today;
          }}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}

function AssigneesButtonContent({ selected }: Readonly<{ selected: AssigneeOption[] }>) {
  const tCrm = getTranslations('crm');
  if (selected.length === 1) {
    const a = selected[0];
    return (
      <>
        <Avatar className="size-[18px]">
          {a.avatar && <AvatarImage src={a.avatar} alt={a.name} />}
          <AvatarFallback className="text-[10px] font-medium bg-blue-200/60 dark:bg-blue-900/60 text-blue-800 dark:text-blue-300">
            {a.name.charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span className="truncate">{a.name}</span>
      </>
    );
  }
  const shown = selected.slice(0, 3);
  return (
    <>
      <span className="flex -space-x-1">
        {shown.map((a) => (
          <Avatar key={a.id} className="size-[18px] ring-1 ring-blue-100 dark:ring-blue-900/30">
            {a.avatar && <AvatarImage src={a.avatar} alt={a.name} />}
            <AvatarFallback className="text-[10px] font-medium bg-blue-200/60 dark:bg-blue-900/60 text-blue-800 dark:text-blue-300">
              {a.name.charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        ))}
      </span>
      <span>{tCrm.taskDialog.assigneeCount.replace('{count}', String(selected.length))}</span>
    </>
  );
}

function AssigneesPopover({
  assigneeList,
  availableAssignees,
  open,
  onOpenChange,
  onChange,
}: Readonly<{
  assigneeList: string[];
  availableAssignees: TaskDialogProps['availableAssignees'];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (assigneeList: string[]) => void;
}>) {
  const tCrm = getTranslations('crm');
  const normalized = availableAssignees.map(normalizeAssignee);
  const selected = assigneeList
    .map((id) => normalized.find(a => a.id === id))
    .filter((a): a is AssigneeOption => Boolean(a));

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <DetailRow icon={Users} label={tCrm.taskDialog.assigneesFallback}>
          {selected.length > 0 ? <AssigneesButtonContent selected={selected} /> : <EmptyValue>{tCrm.taskDialog.unassigned}</EmptyValue>}
        </DetailRow>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-0" align="start" onOpenAutoFocus={focusPickerList}>
        <Command className="outline-hidden">
          <CommandList className="max-h-none overflow-visible">
            <PickerScrollArea>
              <CommandGroup>
                {/* "None" first, in place of a Clear all at the bottom. */}
                <CommandItem
                  value="none"
                  onSelect={() => {
                    onChange([]);
                    onOpenChange(false);
                  }}
                >
                  {tCrm.taskDialog.none}
                  <PickerCheck selected={assigneeList.length === 0} />
                </CommandItem>
                {normalized.map(({ id, name, avatar, departed }) => {
                  const isSelected = assigneeList.includes(id);
                  // Someone who left the workspace can be unassigned, never newly picked.
                  if (departed && !isSelected) return null;
                  return (
                    <CommandItem key={id} value={`${name} ${id}`} onSelect={() => onChange(toggleValue(assigneeList, id))}>
                      <Avatar className="size-5">
                        {avatar && <AvatarImage src={avatar} alt={name} />}
                        <AvatarFallback className="text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                          {name.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="truncate">{name}</span>
                      <PickerCheck selected={isSelected} />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </PickerScrollArea>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function RecordPopover({
  rowLabel,
  rowIcon,
  record,
  companies,
  selectedCompany,
  selectedCompanyLabel,
  defaultLabel,
  searchPlaceholder,
  emptyLabel,
  recordRequired,
  isSearching,
  onSearchChange,
  onChange,
  showKind,
  onCreate,
  createLabels,
}: Readonly<{
  /** What the row says the record is ("Project", "Linked to"). */
  rowLabel: string;
  rowIcon: LucideIcon;
  record: string | null;
  companies: CompanyOption[];
  selectedCompany: CompanyOption | undefined;
  selectedCompanyLabel: string | null;
  defaultLabel: string;
  searchPlaceholder: string | undefined;
  emptyLabel: string | undefined;
  recordRequired: boolean | undefined;
  isSearching: boolean;
  onSearchChange: ((value: string) => void) | undefined;
  onChange: (company: CompanyOption | null) => void;
  /** Badge each option as company/person; off when the caller passes no people (e.g. a project list). */
  showKind: boolean;
  /** Creates a record by name ("Create project"); the picker selects what it returns. */
  onCreate?: (name: string) => Promise<CompanyOption | null>;
  createLabels?: { create: string; namePlaceholder: string };
}>) {
  const tCrm = getTranslations('crm');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // "+ Create …" opens a name field under the list, filled in with the search.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const canCreate = !!onCreate && !!createLabels;
  // Nothing to pick or search yet (no projects at all): the menu is only "+ Create …".
  const nothingYet = canCreate && companies.length === 0 && query === '';
  const submitNew = async () => {
    const name = newName.trim();
    if (!onCreate || !name || busy) return;
    setBusy(true);
    try {
      const created = await onCreate(name);
      if (created) {
        onChange(created);
        setCreating(false);
        setNewName('');
        setOpen(false);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setCreating(false);
      }}
    >
      <PopoverTrigger asChild>
        <DetailRow icon={rowIcon} label={rowLabel}>
          {record && selectedCompany?.icon && (
            <ColoredSquareIcon icon={selectedCompany.icon} color={selectedCompany.iconColor} className="size-[18px] rounded-[7px]" />
          )}
          {record && !selectedCompany?.icon && (
            <Avatar className="h-5 w-5">
              {selectedCompany?.avatar && (
                <AvatarImage src={selectedCompany.avatar} alt={selectedCompanyLabel || ''} />
              )}
              <AvatarFallback className="text-[10px] font-medium bg-purple-200/60 dark:bg-purple-900/60 text-purple-800 dark:text-purple-300">
                {(selectedCompanyLabel || '?').charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          )}
          {record ? (
            <span className="truncate">{selectedCompanyLabel || defaultLabel}</span>
          ) : (
            <EmptyValue>
              {defaultLabel}
              {recordRequired && ' *'}
            </EmptyValue>
          )}
        </DetailRow>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0" align="start" onOpenAutoFocus={nothingYet ? focusPickerList : undefined}>
        <Command>
          {!nothingYet && (
            <CommandInput
              placeholder={searchPlaceholder ?? tCrm.taskDialog.searchRecords}
              className="h-9"
              onValueChange={(value) => {
                setQuery(value);
                onSearchChange?.(value);
              }}
            />
          )}
          <CommandList
            onWheel={(e) => {
              e.currentTarget.scrollTop += e.deltaY;
            }}
          >
            {!nothingYet && (
              <CommandEmpty>{isSearching ? tCrm.taskDialog.searchingRecords : (emptyLabel ?? tCrm.taskDialog.noRecordsFound)}</CommandEmpty>
            )}
            {/* No group at all when there is nothing to list: an empty one still takes 8px. */}
            {companies.length > 0 && (
              <CommandGroup className="px-1 py-1">
                {companies.map((company) => (
                  <CommandItem
                    key={company.id}
                    value={`${company.name} ${company.id}`}
                    onSelect={() => onChange(company.id === record ? null : company)}
                    className="flex items-center justify-between gap-2 px-1.5"
                  >
                    <span className="flex items-center gap-2 min-w-0 flex-1">
                      {company.icon ? (
                        <ColoredSquareIcon icon={company.icon} color={company.iconColor} />
                      ) : (
                        <Avatar className="h-5 w-5 flex-shrink-0">
                          {company.avatar && (
                            <AvatarImage src={company.avatar} alt={company.name} />
                          )}
                          <AvatarFallback className="text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                            {company.name.charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                      )}
                      <span className="truncate">{company.name}</span>
                    </span>
                    {/* Companies and people share this list: say which is which, same as the Notes record picker. */}
                    {showKind && (company.type === 'company' || company.type === 'person') && (
                      <RecordKindBadge kind={company.type} />
                    )}
                    {record === company.id && <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {canCreate && (
              <>
                {companies.length > 0 && <CommandSeparator />}
                {/* Always shown, whatever the search: it is how a first project gets made. */}
                <CommandGroup forceMount>
                  <CommandItem
                    forceMount
                    value="create-record"
                    onSelect={() => {
                      setNewName(query.trim());
                      setCreating(true);
                    }}
                  >
                    <Plus />
                    {createLabels?.create}
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
        {/* Outside the list, so typing the name is not read as list keys. */}
        {canCreate && creating && (
          <div className="grid gap-2 border-t p-2">
            <Input
              autoFocus
              value={newName}
              placeholder={createLabels?.namePlaceholder}
              aria-label={createLabels?.namePlaceholder}
              autoComplete="off"
              className="h-8 text-sm"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submitNew();
                }
              }}
            />
            <Button type="button" size="sm" className="h-8" disabled={!newName.trim() || busy} onClick={() => void submitNew()}>
              {busy ? <Loader2 className="animate-spin" /> : <Plus />}
              {createLabels?.create}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The record row of `RecordPopover` in its selected state, without the picker. */
function LockedRecordRow({ record, rowLabel, rowIcon }: Readonly<{ record: { id: string; name: string; avatar?: string }; rowLabel: string; rowIcon: LucideIcon }>) {
  return (
    <DetailRow icon={rowIcon} label={rowLabel} disabled>
      <Avatar className="h-5 w-5">
        {record.avatar && <AvatarImage src={record.avatar} alt={record.name} />}
        <AvatarFallback className="text-[10px] font-medium bg-purple-200/60 dark:bg-purple-900/60 text-purple-800 dark:text-purple-300">
          {(record.name || '?').charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="truncate">{record.name}</span>
    </DetailRow>
  );
}

function RepeatPopover({
  repeat,
  repeatInterval,
  repeatUnit,
  onRepeatChange,
  onIntervalChange,
  onUnitChange,
}: Readonly<{
  repeat: RepeatValue | null;
  repeatInterval: number;
  repeatUnit: RepeatUnitValue;
  onRepeatChange: (repeat: RepeatValue | null) => void;
  onIntervalChange: (interval: number) => void;
  onUnitChange: (unit: RepeatUnitValue) => void;
}>) {
  const tCrm = getTranslations('crm');
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <DetailRow icon={Repeat2} label={tCrm.taskDialog.repeatFallback}>
          {repeat ? (
            <span className="truncate">{repeatLabel(repeat as RepeatFrequency, repeatInterval, repeatUnit as RepeatUnit)}</span>
          ) : (
            <EmptyValue>{tCrm.taskDialog.never}</EmptyValue>
          )}
        </DetailRow>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start" onOpenAutoFocus={focusPickerList}>
        <RepeatConfigMenu
          repeat={repeat as RepeatFrequency | null}
          repeatInterval={repeatInterval}
          repeatUnit={repeatUnit as RepeatUnit}
          onRepeatChange={(v) => onRepeatChange(v)}
          onIntervalChange={onIntervalChange}
          onUnitChange={(v) => onUnitChange(v)}
          noneLabel={tCrm.taskDialog.never}
          onDone={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

/** GitHub: "Also create on GitHub" checkbox (only when the project has outbound-capable linked repos). */
function GithubCreateOption({
  outboundRepos,
  createOnGithub,
  selectedRepoLinkId,
  onCreateOnGithubChange,
  onRepoLinkChange,
}: Readonly<{
  outboundRepos: Array<{ id: string; repoFullName: string }>;
  createOnGithub: boolean;
  selectedRepoLinkId: string | null;
  onCreateOnGithubChange: (value: boolean) => void;
  onRepoLinkChange: (id: string | null) => void;
}>) {
  const t = getTranslations('settings');
  const github = t.integrations.github;
  return (
    <div className="flex items-center gap-1.5">
      <Checkbox
        id="create-on-github"
        checked={createOnGithub}
        onCheckedChange={(checked) => {
          onCreateOnGithubChange(!!checked);
          if (!checked) onRepoLinkChange(null);
          else if (outboundRepos.length === 1) onRepoLinkChange(outboundRepos[0].id);
        }}
        className="h-3.5 w-3.5"
      />
      <label htmlFor="create-on-github" className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer select-none">
        <Github className="h-3 w-3" />
        {github.taskForm.alsoCreateOnGithub}
      </label>
      {createOnGithub && outboundRepos.length > 1 && (
        <select
          value={selectedRepoLinkId ?? ''}
          onChange={(e) => onRepoLinkChange(e.target.value || null)}
          className="h-6 text-xs border border-border rounded px-1 bg-background text-foreground ml-1"
        >
          <option value="">{github.taskForm.pickRepo}</option>
          {outboundRepos.map((r) => (
            <option key={r.id} value={r.id}>{r.repoFullName}</option>
          ))}
        </select>
      )}
    </div>
  );
}

// Stable default so the record-search effect does not see a new array every render.
const NO_PEOPLE: NonNullable<TaskDialogProps['availablePeople']> = [];

export function TaskDialog({
  open,
  onOpenChange,
  editingTask,
  availableAssignees,
  availableCompanies,
  availablePeople = NO_PEOPLE,
  onRecordSearchChange,
  recordRequired,
  availableLabels = [],
  onCreateLabel,
  defaultRecord,
  defaultAssignee,
  defaultStatus,
  recordLabel = 'Select record',
  recordRowLabel,
  recordIcon = Link2,
  onCreateRecord,
  createRecordLabels,
  recordSearchPlaceholder,
  recordEmptyLabel,
  hideRecord,
  lockedRecord,
  projectId,
  availableStatuses,
  onSave,
  onUpdate,
  isPending,
}: Readonly<TaskDialogProps>) {
  const tCrm = getTranslations('crm');
  const st = useTranslations();
  const effectiveRecordLabel = recordLabel === 'Select record' ? tCrm.taskDialog.selectRecord : recordLabel;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<string>('todo');
  const [priority, setPriority] = useState<PriorityState | null>(null);
  const [assigneeList, setAssigneeList] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState<Date | undefined>(undefined);
  const [record, setRecord] = useState<string | null>(null);
  const [recordName, setRecordName] = useState<string | null>(null);
  const [recordType, setRecordType] = useState<'company' | 'person' | null>(null);
  const [duration, setDuration] = useState<number | null>(30);
  const [repeat, setRepeat] = useState<RepeatValue | null>(null);
  const [repeatInterval, setRepeatInterval] = useState<number>(1);
  const [repeatUnit, setRepeatUnit] = useState<RepeatUnitValue>('days');
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [assigneePopoverOpen, setAssigneePopoverOpen] = useState(false);
  const [isSearchingRecords, setIsSearchingRecords] = useState(false);
  // GitHub integration state
  const [createOnGithub, setCreateOnGithub] = useState(false);
  const [selectedGithubRepoLinkId, setSelectedGithubRepoLinkId] = useState<string | null>(null);

  const buttonContainerRef = useRef<HTMLDivElement>(null);
  const titleTextareaRef = useRef<HTMLTextAreaElement>(null);
  const descriptionRef = useRef<HTMLDivElement>(null);
  const isSubmittingRef = useRef(false);
  // "Create more": after a create the next task starts with the same details.
  const [createMore, setCreateMore] = useState(false);
  // Set by a create with "Create more" on. Callers close the dialog once the task is saved; while
  // this is set the dialog stays on screen, asks to be reopened and keeps the form (name and
  // description emptied) instead of resetting it.
  const carryOverRef = useRef(false);
  const wasOpenRef = useRef(open);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recordSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordSearchSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const availableCompaniesRef = useRef(availableCompanies);
  const availablePeopleRef = useRef(availablePeople);

  const handleRecordSearch = useCallback((value: string) => {
    if (!onRecordSearchChange) return;
    setIsSearchingRecords(true);
    if (recordSearchTimerRef.current) clearTimeout(recordSearchTimerRef.current);
    if (recordSearchSettleTimerRef.current) clearTimeout(recordSearchSettleTimerRef.current);
    recordSearchTimerRef.current = setTimeout(() => {
      onRecordSearchChange(value);
    }, 150);
    // A search that returns the same rows keeps the list references unchanged
    // (React Query structural sharing), so the effect below never fires. Stop
    // the spinner after a short grace period instead of leaving it stuck.
    recordSearchSettleTimerRef.current = setTimeout(() => {
      setIsSearchingRecords(false);
    }, 2000);
  }, [onRecordSearchChange]);

  useEffect(() => {
    if (
      availableCompaniesRef.current !== availableCompanies ||
      availablePeopleRef.current !== availablePeople
    ) {
      availableCompaniesRef.current = availableCompanies;
      availablePeopleRef.current = availablePeople;
      setIsSearchingRecords(false);
    }
  }, [availableCompanies, availablePeople]);

  useEffect(() => () => {
    if (recordSearchTimerRef.current) clearTimeout(recordSearchTimerRef.current);
    if (recordSearchSettleTimerRef.current) clearTimeout(recordSearchSettleTimerRef.current);
  }, []);

  useEffect(() => {
    return () => {
      if (recordSearchTimerRef.current) clearTimeout(recordSearchTimerRef.current);
    };
  }, []);

  const normalizedCompanies: CompanyOption[] = availableCompanies.map((c) =>
    typeof c === 'string' ? { id: c, name: c, avatar: undefined as string | undefined, type: 'company' } : { ...c, type: 'company' }
  );
  const normalizedPeople: CompanyOption[] = availablePeople.map((p) =>
    typeof p === 'string' ? { id: p, name: p, avatar: undefined as string | undefined, type: 'person' } : { ...p, type: 'person' }
  );
  // The record picker offers both — a task can link to either a company or a
  // person, distinguished by `type` on each option (see RecordPopover).
  const recordOptions: CompanyOption[] = [...normalizedCompanies, ...normalizedPeople];
  const selectedCompany = record ? recordOptions.find((c) => c.id === record) : undefined;
  const selectedCompanyLabel = selectedCompany?.name ?? recordName ?? record;

  const { uploadFile, isUploading, progress, currentFileName } = useFileUpload({
    folder: 'projects',
    entityType: 'task',
    onError: (error) => toast.error(error),
  });

  // GitHub: only fetch linked repos when we have a projectId (WeldFlow context) and creating a new task.
  // We pass a sentinel value when disabled so the hook key doesn't conflict.
  const { data: linkedReposResult } = useLinkedRepos(projectId && !editingTask ? projectId : undefined);
  const allLinkedRepos = linkedReposResult?.data ?? [];
  // Only show the checkbox for repos that can push outbound (outbound or bidirectional)
  const outboundRepos = allLinkedRepos.filter(
    (r) => r.projectId === projectId && (r.syncDirection === 'outbound' || r.syncDirection === 'bidirectional'),
  );
  const showGithubCheckbox = !!projectId && !editingTask && outboundRepos.length > 0;

  // Sync contentEditable div from description state
  const syncDescriptionToDiv = useCallback((md: string) => {
    const div = descriptionRef.current;
    if (!div) return;
    if (md) {
      div.innerHTML = markdownToHtml(md);
    } else {
      div.innerHTML = '';
    }
  }, []);

  // Read contentEditable div back to markdown
  const readDescriptionFromDiv = useCallback((): string => {
    const div = descriptionRef.current;
    if (!div) return description;
    return htmlToMarkdown(div.innerHTML);
  }, [description]);

  // Insert HTML at the current cursor position in the contentEditable div
  const insertHtmlAtCursor = useCallback((html: string) => {
    const div = descriptionRef.current;
    if (!div) return;
    div.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const temp = document.createElement('div');
      temp.innerHTML = html;
      const frag = document.createDocumentFragment();
      while (temp.firstChild) {
        frag.appendChild(temp.firstChild);
      }
      // Add a trailing br so cursor moves after
      const br = document.createElement('br');
      frag.appendChild(br);
      range.insertNode(frag);
      // Move cursor after inserted content
      const newRange = document.createRange();
      newRange.setStartAfter(br);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
    } else {
      div.innerHTML += html + '<br>';
    }
    // Update state from div
    setDescription(htmlToMarkdown(div.innerHTML));
  }, []);

  const handleUploadFiles = useCallback(async (files: FileList | null) => {
    if (!files) return;
    const fileArray = Array.from(files);
    for (const file of fileArray) {
      if (file.size > 25 * 1024 * 1024) {
        toast.error(st('sweep.weldcrm.taskDialog.fileSizeExceeds25MB', { fileName: file.name }));
        continue;
      }
      const result = await uploadFile(file);
      if (result) {
        const isImage = result.mimeType.startsWith('image/');
        if (isImage) {
          insertHtmlAtCursor(`<img src="${result.url}" alt="${result.fileName}" style="max-width:100%;max-height:200px;border-radius:6px;margin:4px 0;display:block;" />`);
        } else {
          insertHtmlAtCursor(`<a href="${result.url}" target="_blank" rel="noopener noreferrer" style="color:var(--primary);text-decoration:underline;">${result.fileName}</a>`);
        }
      }
    }
  }, [uploadFile, insertHtmlAtCursor, st]);

  const handleDescriptionPaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      void handleUploadFiles(dt.files);
    } else {
      // For plain text paste, prevent rich HTML paste
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      if (text) {
        runEditorCommand('insertText', text);
      }
    }
  }, [handleUploadFiles]);

  const handleDescriptionDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      setIsDraggingFile(true);
    }
  }, []);

  const handleDescriptionDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(false);
  }, []);

  const handleDescriptionDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(false);
    if (e.dataTransfer?.files?.length) {
      void handleUploadFiles(e.dataTransfer.files);
    }
  }, [handleUploadFiles]);

  // Reset form when dialog opens/closes or editingTask changes
  useEffect(() => {
    if (open && carryOverRef.current) {
      // Reopened after a "Create more" save: keep the details, start the next name.
      carryOverRef.current = false;
      const timer = setTimeout(() => titleTextareaRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
    if (open) {
      isSubmittingRef.current = false;
      const initial = getInitialFormState(editingTask, defaultAssignee, defaultRecord, defaultStatus);
      setTitle(initial.title);
      setDescription(initial.description);
      setStatus(initial.status);
      setPriority(initial.priority);
      setAssigneeList(initial.assigneeList);
      setDueDate(initial.dueDate);
      setDuration(initial.duration);
      setRecord(initial.record);
      setRecordName(initial.recordName);
      setRecordType(initial.recordType);
      setRepeat(initial.repeat);
      setRepeatInterval(initial.repeatInterval);
      setRepeatUnit(initial.repeatUnit);
      setSelectedLabels(initial.selectedLabels);
      // Sync contentEditable div after DOM is ready
      const timer = setTimeout(() => {
        if (titleTextareaRef.current) {
          titleTextareaRef.current.style.height = 'auto';
          titleTextareaRef.current.style.height = Math.min(titleTextareaRef.current.scrollHeight, 200) + 'px';
          const len = titleTextareaRef.current.value.length;
          titleTextareaRef.current.setSelectionRange(len, len);
        }
        syncDescriptionToDiv(initial.description);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [open, editingTask, defaultRecord, defaultAssignee, defaultStatus, syncDescriptionToDiv]);

  // The caller closed the dialog after a "Create more" save: empty the name and description and
  // ask to be opened again (the effect above then keeps the rest of the form).
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (!wasOpen || open || !carryOverRef.current) return;
    isSubmittingRef.current = false;
    setTitle('');
    setDescription('');
    syncDescriptionToDiv('');
    onOpenChange(true);
  }, [open, onOpenChange, syncDescriptionToDiv]);

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setStatus('todo');
    setPriority(null);
    setAssigneeList(defaultAssignee ? [defaultAssignee] : []);
    setDueDate(undefined);
    setRecord(defaultRecord || null);
    setRecordName(defaultRecord || null);
    setRecordType(defaultRecord ? 'company' : null);
    setRepeat(null);
    setRepeatInterval(1);
    setRepeatUnit('days');
    setSelectedLabels([]);
    setCreateOnGithub(false);
    setSelectedGithubRepoLinkId(null);
    if (descriptionRef.current) descriptionRef.current.innerHTML = '';
  };

  const handleClose = () => {
    carryOverRef.current = false;
    onOpenChange(false);
    resetForm();
  };

  const handleSubmit = () => {
    if (!title.trim() || isSubmittingRef.current) return;
    if (recordRequired && !record) return;

    isSubmittingRef.current = true;
    carryOverRef.current = !editingTask && createMore;

    // Read latest description from contentEditable div
    const finalDescription = readDescriptionFromDiv();

    const common = buildCommonPayload(
      {
        title,
        description,
        status,
        priority,
        assigneeList,
        dueDate,
        duration,
        record,
        recordName,
        recordType,
        repeat,
        repeatInterval,
        repeatUnit,
        selectedLabels,
      },
      finalDescription,
    );

    const linked = linkedRecord(record, recordType, selectedCompanyLabel || '');

    if (editingTask) {
      // An edit sends what the form holds, cleared fields included: `undefined`
      // is dropped by JSON, so the caller could not tell "cleared" from "left
      // alone" and the old date / description / labels / recurrence stayed.
      onUpdate(editingTask.id, {
        ...common,
        description: finalDescription,
        dueDate: dueDate ?? null,
        labels: selectedLabels,
        repeat: common.repeat ?? null,
        assigneeIds: assigneeList,
        linkedCompany: linked.company,
        linkedPerson: linked.person,
      });
    } else {
      // TODO (GitHub: task_mo35kz3u7abmh1uo): plumb `createOnGithub` and `githubRepoLinkId` through
      // the task mutation payload once core-api task creation accepts these fields.
      // When createOnGithub is true, the core-api should create a GitHub issue via the
      // outbound sync trigger. See follow-up task filed: "GitHub: plumb `createOnGithub` through
      // task mutation + trigger outbound sync".
      onSave({
        ...common,
        assigneeId: assigneeList[0] || undefined,
        assigneeIds: assigneeList.length > 0 ? assigneeList : undefined,
        linkedCompanyId: linked.company?.id,
        personId: linked.person?.id,
      });
    }
  };

  const handleRecordChange = (company: CompanyOption | null) => {
    setRecord(company?.id ?? null);
    setRecordName(company?.name ?? null);
    setRecordType(optionRecordType(company));
  };

  const resizeTextarea = useCallback((textarea: HTMLTextAreaElement | null, maxHeight: number) => {
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
    }
  }, []);

  useLayoutEffect(() => {
    if (open) resizeTextarea(titleTextareaRef.current, 200);
  }, [open, title, resizeTextarea]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLDivElement>, isTitle: boolean) => {
    // Title: Enter submits (Shift+Enter adds a newline).
    // Description (contentEditable): Enter adds newlines normally, Cmd/Ctrl+Enter submits.
    const isSubmitKey = e.key === 'Enter' && (isTitle ? !e.shiftKey : e.metaKey || e.ctrlKey);
    if (!isSubmitKey) return;
    e.preventDefault();
    if (title.trim() && !isPending && !isSubmittingRef.current) {
      handleSubmit();
    }
  };

  const submitLabel = editingTask ? tCrm.taskDialog.save : tCrm.taskDialog.createTask;

  const rowLabel = recordRowLabel ?? tCrm.taskDialog.recordRow;

  return (
    <Dialog open={open || carryOverRef.current} onOpenChange={handleClose}>
      <DialogContent
        className="sm:max-w-[760px] p-0 gap-0 overflow-hidden"
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          // Focus the task name field when the dialog opens.
          e.preventDefault();
          titleTextareaRef.current?.focus();
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-border">
          <DialogTitle className="text-base font-semibold">{editingTask ? tCrm.taskDialog.titleEdit : tCrm.taskDialog.titleCreate}</DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 translate-x-[4px] hover:ring-[3px] hover:ring-accent dark:hover:ring-accent"
            onClick={handleClose}
            aria-label={tCrm.taskDialog.close}
          >
            <X className="h-3.5 w-3.5 !text-gray-500 dark:!text-gray-400" strokeWidth={2.5} />
          </Button>
        </div>

        {/* The writing on the left, the task's details as rows on the right. */}
        <div className="grid min-h-0 sm:grid-cols-[minmax(0,1fr)_280px]">
          <div className="flex min-w-0 flex-col border-b border-border sm:border-b-0 sm:border-r">
            {/* Task name */}
            <div className="px-4 pt-4 pb-1">
              <textarea
                ref={titleTextareaRef}
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  resizeTextarea(e.target, 200);
                }}
                onKeyDown={(e) => handleKeyDown(e, true)}
                placeholder={tCrm.taskDialog.placeholderTaskName}
                className="w-full text-base font-medium border-none outline-none bg-transparent placeholder:text-gray-400 resize-none overflow-y-auto max-h-[200px] block break-words [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-gray-200 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-gray-300 dark:[&::-webkit-scrollbar-thumb]:bg-gray-700"
                rows={1}
              />
            </div>

            {/* Description: fills the column; files dropped, pasted or attached land in it */}
            <div className="flex min-h-[160px] min-w-0 flex-1 flex-col px-4 pt-1 pb-3">
              <div
                className={cn(
                  'relative flex-1 rounded-md transition-colors',
                  isDraggingFile && 'bg-primary/5 ring-1 ring-primary/30'
                )}
                onDragOver={handleDescriptionDragOver}
                onDragLeave={handleDescriptionDragLeave}
                onDrop={handleDescriptionDrop}
              >
                <div
                  ref={descriptionRef}
                  contentEditable
                  suppressContentEditableWarning
                  role="textbox"
                  aria-multiline="true"
                  aria-label={tCrm.taskDialog.placeholderDescription}
                  tabIndex={0}
                  onInput={() => {
                    const div = descriptionRef.current;
                    if (!div) return;
                    setDescription(htmlToMarkdown(div.innerHTML));
                    scrollCaretIntoView(div);
                  }}
                  onKeyDown={(e) => handleKeyDown(e, false)}
                  onPaste={handleDescriptionPaste}
                  className="h-full w-full text-sm text-gray-600 dark:text-muted-foreground border-none outline-none bg-transparent overflow-y-auto max-h-[350px] min-h-[120px] leading-5 break-words whitespace-pre-wrap [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-gray-200 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-gray-300 dark:[&::-webkit-scrollbar-thumb]:bg-gray-700 [&_img]:max-w-full [&_img]:max-h-[200px] [&_img]:rounded-md [&_img]:my-1 [&_img]:block [&_a]:text-primary [&_a]:underline"
                />
                {!description && (
                  <span className="pointer-events-none absolute left-0 top-0 text-sm text-gray-400 leading-5">
                    {tCrm.taskDialog.placeholderDescription}
                  </span>
                )}
                {isDraggingFile && (
                  <div className="absolute inset-0 flex items-center justify-center bg-primary/5 rounded-md pointer-events-none">
                    <div className="flex items-center gap-1.5 text-xs text-primary">
                      <Upload className="h-3.5 w-3.5" />
                      {tCrm.taskDialog.dropFilesHere}
                    </div>
                  </div>
                )}
              </div>

              {/* Upload Progress */}
              {isUploading && currentFileName && (
                <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />
                  <span className="truncate flex-1">{tCrm.taskDialog.uploadingFile.replace('{fileName}', currentFileName || '')}</span>
                  <div className="w-16 h-1 bg-muted rounded-full overflow-hidden flex-shrink-0">
                    <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              )}

              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={(e) => {
                  void handleUploadFiles(e.target.files);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
                className="hidden"
                accept="*/*"
              />
            </div>
          </div>

          {/* Details: one row per field; a row opens its picker */}
          <div className="flex min-w-0 flex-col">
            <div ref={buttonContainerRef} className="flex flex-col [&>*:last-child]:border-b-0">
              {lockedRecord && <LockedRecordRow record={lockedRecord} rowLabel={rowLabel} rowIcon={recordIcon} />}
              {!lockedRecord && !hideRecord && (
                <RecordPopover
                  rowLabel={rowLabel}
                  rowIcon={recordIcon}
                  record={record}
                  companies={recordOptions}
                  selectedCompany={selectedCompany}
                  selectedCompanyLabel={selectedCompanyLabel}
                  defaultLabel={effectiveRecordLabel}
                  searchPlaceholder={recordSearchPlaceholder}
                  emptyLabel={recordEmptyLabel}
                  recordRequired={recordRequired}
                  isSearching={isSearchingRecords}
                  onSearchChange={onRecordSearchChange ? handleRecordSearch : undefined}
                  onChange={handleRecordChange}
                  showKind={availablePeople !== NO_PEOPLE}
                  onCreate={onCreateRecord}
                  createLabels={createRecordLabels}
                />
              )}

              <StatusPopover status={status} availableStatuses={availableStatuses} onChange={setStatus} />

              <PriorityPopover priority={priority} onChange={setPriority} />

              <AssigneesPopover
                assigneeList={assigneeList}
                availableAssignees={availableAssignees}
                open={assigneePopoverOpen}
                onOpenChange={setAssigneePopoverOpen}
                onChange={setAssigneeList}
              />

              <DueDatePopover dueDate={dueDate} onChange={setDueDate} />

              <DurationPopover duration={duration} onChange={setDuration} />

              {/* Only labels of the active project (or workspace-wide ones) are offered. The project
                  comes from the `projectId` prop on project-scoped views (where `record` is hidden)
                  and falls back to `record` on cross-project views like My Tasks, where the
                  selected linked record is itself a project. */}
              <LabelsPopover
                selectedLabels={selectedLabels}
                availableLabels={availableLabels}
                activeProjectId={projectId ?? record}
                onChange={setSelectedLabels}
                onCreateLabel={onCreateLabel}
              />

              <RepeatPopover
                repeat={repeat}
                repeatInterval={repeatInterval}
                repeatUnit={repeatUnit}
                onRepeatChange={setRepeat}
                onIntervalChange={setRepeatInterval}
                onUnitChange={setRepeatUnit}
              />

              {/* Files go into the description, where they can also be dropped or pasted. */}
              <DetailRow
                icon={Paperclip}
                label={tCrm.taskDialog.attachmentsRow}
                title={st('sweep.weldcrm.taskDialog.attachFileTooltip')}
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
              >
                {isUploading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : <EmptyValue>{tCrm.taskDialog.addFiles}</EmptyValue>}
              </DetailRow>

              {showGithubCheckbox && (
                <div className="flex min-h-11 items-center border-b border-border px-4 py-2">
                  <GithubCreateOption
                    outboundRepos={outboundRepos}
                    createOnGithub={createOnGithub}
                    selectedRepoLinkId={selectedGithubRepoLinkId}
                    onCreateOnGithubChange={setCreateOnGithub}
                    onRepoLinkChange={setSelectedGithubRepoLinkId}
                  />
                </div>
              )}
            </div>

            <div className="mt-auto flex h-12 items-center justify-end gap-3 border-t border-border px-4">
              {!editingTask && (
                <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground select-none">
                  <Switch checked={createMore} onCheckedChange={setCreateMore} aria-label={tCrm.taskDialog.createMore} />
                  {tCrm.taskDialog.createMore}
                </label>
              )}
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={!title.trim() || isPending || (recordRequired && !record)}
                className="h-[30px] text-xs px-3 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : submitLabel}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
