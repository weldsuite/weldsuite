
import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
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
} from '@weldsuite/ui/components/command';
import { Calendar } from '@weldsuite/ui/components/calendar';
import {
  Trash2,
  X,
  Check,
  Repeat2,
  Loader2,
  Paperclip,
  Upload,
  Github,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import type { Task } from '@/hooks/use-crm-tasks';
import { useFileUpload } from '@/hooks/use-file-upload';
import { toast } from 'sonner';
import { useLinkedRepos } from '@/hooks/queries/use-github-queries';
import { getTranslations } from '@/lib/i18n';
import { useTranslations } from '@weldsuite/i18n/client';
import { RepeatConfigMenu, repeatLabel, type RepeatFrequency, type RepeatUnit } from '@/components/tasks/repeat-config';

const statusConfig = {
  'backlog': { label: 'Backlog', color: 'bg-gray-100 text-gray-800 dark:bg-background/30 dark:text-muted-foreground', btnColor: 'bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200 dark:bg-secondary dark:text-muted-foreground dark:border-border' },
  'todo': { label: 'To Do', color: 'bg-gray-100 text-gray-800 dark:bg-background/30 dark:text-muted-foreground', btnColor: 'bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200 dark:bg-secondary dark:text-muted-foreground dark:border-border' },
  'in_progress': { label: 'In Progress', color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400', btnColor: 'bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800' },
  'in_review': { label: 'In Review', color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400', btnColor: 'bg-yellow-100 text-yellow-800 border-yellow-200 hover:bg-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800' },
  'testing': { label: 'Testing', color: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400', btnColor: 'bg-purple-100 text-purple-800 border-purple-200 hover:bg-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800' },
  'done': { label: 'Done', color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400', btnColor: 'bg-green-100 text-green-800 border-green-200 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800' },
  'cancelled': { label: 'Cancelled', color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400', btnColor: 'bg-red-100 text-red-800 border-red-200 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800' },
};

const priorityConfig = {
  'low': { label: 'Low', color: 'bg-gray-100 text-gray-600 dark:bg-secondary dark:text-muted-foreground', btnColor: 'bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-200 dark:bg-secondary dark:text-muted-foreground dark:border-border' },
  'medium': { label: 'Medium', color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400', btnColor: 'bg-yellow-100 text-yellow-800 border-yellow-200 hover:bg-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800' },
  'high': { label: 'High', color: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400', btnColor: 'bg-orange-100 text-orange-800 border-orange-200 hover:bg-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800' },
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
  const hex =
    raw.length === 3
      ? raw.split('').map((c) => c + c).join('')
      : raw.length === 6
        ? raw
        : null;
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
  availableAssignees: string[] | { id: string; name: string; avatar?: string }[];
  availableCompanies: Array<string | { id: string; name: string; avatar?: string; type?: string }>;
  onRecordSearchChange?: (query: string) => void;
  recordRequired?: boolean;
  availableLabels?: LabelOption[];
  onCreateLabel?: (data: { name: string; color: string }) => Promise<LabelOption | null>;
  defaultRecord?: string;
  defaultAssignee?: string;
  recordLabel?: string;
  hideRecord?: boolean;
  projectId?: string;
  // When provided, the status dropdown renders these options (project-specific
  // pipeline stages) instead of the built-in `statusConfig`. Values are stage IDs.
  availableStatuses?: Array<{ id: string; label: string; color?: string }>;
  onSave: (data: {
    title: string;
    description?: string;
    status: Task['status'];
    priority?: 'low' | 'medium' | 'high';
    assigneeId?: string;
    assigneeIds?: string[];
    dueDate?: Date;
    duration?: number;
    linkedCompanyId?: string;
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
    priority?: 'low' | 'medium' | 'high';
    dueDate?: Date;
    duration?: number;
    linkedCompany?: { id: string; name: string } | null;
    labels?: string[];
    repeat?: {
      frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom';
      interval?: number;
      unit?: 'days' | 'weeks' | 'months' | 'years';
    };
  }) => void;
  isPending: boolean;
}

/** Convert markdown image/link syntax to HTML for contentEditable display */
function markdownToHtml(md: string): string {
  return md
    // Images: ![alt](url) → <img>
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;max-height:200px;border-radius:6px;margin:4px 0;display:block;" />')
    // Links: [text](url) → <a>
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:var(--primary);text-decoration:underline;">$1</a>')
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
type RepeatValue = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom';
type RepeatUnitValue = 'days' | 'weeks' | 'months' | 'years';
type AssigneeOption = { id: string; name: string; avatar?: string };
type CompanyOption = { id: string; name: string; avatar?: string; type?: string };

const DURATION_PRESETS = [15, 30, 45, 60, 90, 120];

function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const rest = mins % 60;
  return `${Math.floor(mins / 60)}h${rest ? ` ${rest}m` : ''}`;
}

function normalizeAssignee(a: string | AssigneeOption): AssigneeOption {
  return typeof a === 'string' ? { id: a, name: a, avatar: undefined } : a;
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
  priority: PriorityValue | null;
  assigneeList: string[];
  dueDate: Date | undefined;
  duration: number | null;
  record: string | null;
  recordName: string | null;
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
): TaskFormState {
  if (!editingTask) {
    return {
      title: '',
      description: '',
      status: 'todo',
      priority: null,
      assigneeList: defaultAssignee ? [defaultAssignee] : [],
      dueDate: undefined,
      duration: 30,
      record: defaultRecord || null,
      recordName: defaultRecord || null,
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
    record: editingTask.linkedCompany?.id || null,
    recordName: editingTask.linkedCompany?.name || null,
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
    priority: form.priority || undefined,
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

const CLEAR_ITEM_CLASS =
  'flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded';

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
    in_review: tCrm.tasks.status.inReview,
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

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-7 text-xs font-medium", !availableStatuses && builtIn?.btnColor)} style={availableStatuses ? { backgroundColor: (currentCustom?.color ?? '#e5e7eb') + '33', borderColor: currentCustom?.color } : undefined}>
          {buttonLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-1" align="start">
        {options.map(({ key, label, color }) => (
          <Button
            variant="ghost"
            key={key}
            onClick={() => onChange(key)}
            className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-secondary rounded gap-2"
          >
            <span className="flex items-center gap-2">
              {color && <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />}
              <span>{label}</span>
            </span>
            {status === key && <Check className="h-3.5 w-3.5 text-primary" />}
          </Button>
        ))}
        {!availableStatuses && status !== 'todo' && (
          <>
            <div className="h-px bg-gray-200 dark:bg-accent my-1" />
            <Button
              variant="ghost"
              onClick={() => onChange('todo')}
              className={CLEAR_ITEM_CLASS}
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              <span>{tCrm.taskDialog.resetToDefault}</span>
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function PriorityPopover({
  priority,
  onChange,
}: Readonly<{ priority: PriorityValue | null; onChange: (priority: PriorityValue | null) => void }>) {
  const tCrm = getTranslations('crm');
  const translatedPriorityLabels: Record<string, string> = {
    low: tCrm.tasks.priority.low,
    medium: tCrm.tasks.priority.medium,
    high: tCrm.tasks.priority.high,
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-7 text-xs font-medium", priority && priorityConfig[priority]?.btnColor)}>
          {priority ? (translatedPriorityLabels[priority] || priorityConfig[priority]?.label) : tCrm.taskDialog.priorityFallback}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-1" align="start">
        {Object.entries(priorityConfig).map(([key, config]) => (
          <Button
            variant="ghost"
            key={key}
            onClick={() => onChange(key as PriorityValue)}
            className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-secondary rounded"
          >
            <span>{translatedPriorityLabels[key] || config.label}</span>
            {priority === key && <Check className="h-3.5 w-3.5 text-primary" />}
          </Button>
        ))}
        {priority && (
          <>
            <div className="h-px bg-gray-200 dark:bg-accent my-1" />
            <Button
              variant="ghost"
              onClick={() => onChange(null)}
              className={CLEAR_ITEM_CLASS}
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              <span>{tCrm.taskDialog.clearPriority}</span>
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function LabelsPopover({
  selectedLabels,
  availableLabels,
  activeProjectId,
  onChange,
}: Readonly<{
  selectedLabels: string[];
  availableLabels: LabelOption[];
  activeProjectId: string | null | undefined;
  onChange: React.Dispatch<React.SetStateAction<string[]>>;
}>) {
  const tCrm = getTranslations('crm');
  // Only show labels that belong to the active project (or workspace-wide
  // labels with no projectId).
  const visibleLabels = availableLabels.filter(
    (l) => !l.projectId || l.projectId === activeProjectId,
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-7 text-xs font-normal gap-1", selectedLabels.length > 0 && "px-1")}>
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
            tCrm.taskDialog.labelsFallback
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-1 min-w-[200px]" align="start">
        {visibleLabels.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {activeProjectId ? tCrm.taskDialog.noLabelsForProject : tCrm.taskDialog.selectProjectForLabels}
          </div>
        ) : (
          visibleLabels.map((label) => {
            const isSelected = selectedLabels.includes(label.id);
            return (
              <Button
                variant="ghost"
                key={label.id}
                onClick={() => onChange((prev) => toggleValue(prev, label.id))}
                className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-secondary rounded gap-2"
              >
                <span
                  className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border-transparent"
                  style={{
                    backgroundColor: resolveLabelColor(label.color),
                    color: readableLabelTextColor(resolveLabelColor(label.color)),
                  }}
                >
                  {label.name}
                </span>
                {isSelected && <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />}
              </Button>
            );
          })
        )}
        {selectedLabels.length > 0 && (
          <>
            <div className="h-px bg-gray-200 dark:bg-accent my-1" />
            <Button
              variant="ghost"
              onClick={() => onChange([])}
              className={CLEAR_ITEM_CLASS}
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              <span>{tCrm.taskDialog.clearAll}</span>
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function DurationPopover({
  duration,
  onChange,
}: Readonly<{ duration: number | null; onChange: (duration: number | null) => void }>) {
  const tCrm = getTranslations('crm');
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-7 text-xs font-normal gap-1", duration != null && "bg-cyan-100 text-cyan-800 border-cyan-200 hover:bg-cyan-200 dark:bg-cyan-900/30 dark:text-cyan-400 dark:border-cyan-800")}>
          {duration != null ? formatMinutes(duration) : tCrm.taskDialog.durationFallback}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-1" align="start">
        <div className="flex flex-col">
          {DURATION_PRESETS.map((mins) => (
            <Button
              variant="ghost"
              key={mins}
              onClick={() => onChange(mins)}
              className={cn(
                "flex items-center justify-between px-2 py-1.5 text-sm rounded hover:bg-gray-100 dark:hover:bg-secondary",
                duration === mins && "bg-gray-100 dark:bg-secondary"
              )}
            >
              <span>{formatMinutes(mins)}</span>
              {duration === mins && <Check className="h-3.5 w-3.5" />}
            </Button>
          ))}
          <div className="h-px bg-gray-200 dark:bg-border my-1" />
          <div className="px-2 py-1.5">
            <label className="text-xs font-medium text-gray-500 dark:text-muted-foreground">{tCrm.taskDialog.customMinutes}</label>
            <Input
              type="number"
              min="0"
              value={duration != null && !DURATION_PRESETS.includes(duration) ? duration : ''}
              onChange={(e) => onChange(e.target.value ? Number.parseInt(e.target.value, 10) : null)}
              placeholder=""
              className="h-7 text-sm mt-1"
            />
          </div>
          {duration != null && (
            <>
              <div className="h-px bg-gray-200 dark:bg-border my-1" />
              <Button
                variant="ghost"
                onClick={() => onChange(null)}
                className={CLEAR_ITEM_CLASS}
              >
                <Trash2 className="h-3.5 w-3.5 mr-2" />
                <span>{tCrm.taskDialog.clearDuration}</span>
              </Button>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DueDatePopover({
  dueDate,
  onChange,
}: Readonly<{ dueDate: Date | undefined; onChange: (date: Date | undefined) => void }>) {
  const tCrm = getTranslations('crm');
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-xs font-normal">
          {dueDate ? format(dueDate, 'MMM d') : tCrm.taskDialog.dueDateFallback}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={dueDate}
          onSelect={onChange}
          disabled={(date) => {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            return date < today;
          }}
          initialFocus
        />
        {dueDate && (
          <div className="p-1 border-t border-gray-200 dark:border-border">
            <Button
              variant="ghost"
              onClick={() => onChange(undefined)}
              className={CLEAR_ITEM_CLASS}
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              <span>{tCrm.taskDialog.clearDueDate}</span>
            </Button>
          </div>
        )}
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
        <Avatar className="h-5 w-5 !rounded-[6px]">
          {a.avatar && <AvatarImage src={a.avatar} alt={a.name} className="!rounded-[6px]" />}
          <AvatarFallback className="!rounded-[6px] text-[10px] font-medium bg-blue-200/60 dark:bg-blue-900/60 text-blue-800 dark:text-blue-300">
            {a.name.charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span>{a.name}</span>
      </>
    );
  }
  const shown = selected.slice(0, 3);
  return (
    <>
      <span className="flex -space-x-1">
        {shown.map((a) => (
          <Avatar key={a.id} className="h-5 w-5 !rounded-[6px] ring-1 ring-blue-100 dark:ring-blue-900/30">
            {a.avatar && <AvatarImage src={a.avatar} alt={a.name} className="!rounded-[6px]" />}
            <AvatarFallback className="!rounded-[6px] text-[10px] font-medium bg-blue-200/60 dark:bg-blue-900/60 text-blue-800 dark:text-blue-300">
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
        <Button variant="outline" size="sm" className={cn("h-7 text-xs font-medium gap-1.5", assigneeList.length > 0 ? "bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800 pl-1" : "font-normal")}>
          {assigneeList.length > 0
            ? <AssigneesButtonContent selected={selected} />
            : tCrm.taskDialog.assigneesFallback}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto min-w-[220px] p-1" align="start">
        {normalized.map(({ id, name, avatar }) => {
          const isSelected = assigneeList.includes(id);
          return (
            <Button
              variant="ghost"
              key={id}
              onClick={() => onChange(toggleValue(assigneeList, id))}
              className="flex items-center justify-between w-full px-1.5 py-1.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-secondary rounded gap-4"
            >
              <span className="flex items-center gap-2">
                <Avatar className="h-5 w-5 !rounded-[7px]">
                  {avatar && <AvatarImage src={avatar} alt={name} className="!rounded-[7px]" />}
                  <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                    {name.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span>{name}</span>
              </span>
              {isSelected && <Check className="h-3.5 w-3.5 text-primary" />}
            </Button>
          );
        })}
        {assigneeList.length > 0 && (
          <>
            <div className="h-px bg-gray-200 dark:bg-accent my-1" />
            <Button
              variant="ghost"
              onClick={() => { onChange([]); onOpenChange(false); }}
              className={CLEAR_ITEM_CLASS}
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              <span>{tCrm.taskDialog.clearAll}</span>
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function RecordPopover({
  record,
  companies,
  selectedCompany,
  selectedCompanyLabel,
  defaultLabel,
  recordRequired,
  isSearching,
  onSearchChange,
  onChange,
}: Readonly<{
  record: string | null;
  companies: CompanyOption[];
  selectedCompany: CompanyOption | undefined;
  selectedCompanyLabel: string | null;
  defaultLabel: string;
  recordRequired: boolean | undefined;
  isSearching: boolean;
  onSearchChange: ((value: string) => void) | undefined;
  onChange: (company: { id: string; name: string } | null) => void;
}>) {
  const tCrm = getTranslations('crm');
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn(
          "h-7 text-xs font-normal gap-1.5",
          record && "bg-purple-100 text-purple-800 border-purple-200 hover:bg-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800 pl-1",
          recordRequired && !record && "border-red-300 text-red-600 dark:border-red-900 dark:text-red-400",
        )}>
          {record && (
            <Avatar className="h-5 w-5 !rounded-[6px]">
              {selectedCompany?.avatar && (
                <AvatarImage src={selectedCompany.avatar} alt={selectedCompanyLabel || ''} className="!rounded-[6px]" />
              )}
              <AvatarFallback className="!rounded-[6px] text-[10px] font-medium bg-purple-200/60 dark:bg-purple-900/60 text-purple-800 dark:text-purple-300">
                {(selectedCompanyLabel || '?').charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          )}
          <span>{selectedCompanyLabel || defaultLabel}{recordRequired && !record ? ' *' : ''}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0" align="start">
        <Command>
          <CommandInput
            placeholder={tCrm.taskDialog.searchRecords}
            className="h-9"
            onValueChange={onSearchChange}
          />
          <CommandList
            onWheel={(e) => {
              e.currentTarget.scrollTop += e.deltaY;
            }}
          >
            <CommandEmpty>{isSearching ? tCrm.taskDialog.searchingRecords : tCrm.taskDialog.noRecordsFound}</CommandEmpty>
            <CommandGroup className="px-1 py-1">
              {companies.map((company) => (
                <CommandItem
                  key={company.id}
                  value={`${company.name} ${company.id}`}
                  onSelect={() => onChange(company.id === record ? null : company)}
                  className="flex items-center justify-between gap-2 px-1.5"
                >
                  <span className="flex items-center gap-2 min-w-0 flex-1">
                    <Avatar className="h-5 w-5 !rounded-[7px] flex-shrink-0">
                      {company.avatar && (
                        <AvatarImage src={company.avatar} alt={company.name} className="!rounded-[7px]" />
                      )}
                      <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                        {company.name.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="truncate">{company.name}</span>
                  </span>
                  {record === company.id && <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />}
                </CommandItem>
              ))}
            </CommandGroup>
            {record && (
              <div className="p-1">
                <div className="h-px bg-gray-200 dark:bg-accent my-1" />
                <Button
                  variant="ghost"
                  onClick={() => onChange(null)}
                  className={CLEAR_ITEM_CLASS}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-2" />
                  <span>{tCrm.taskDialog.clearAll}</span>
                </Button>
              </div>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
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
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-[30px] gap-1 px-2", repeat && "bg-indigo-100 text-indigo-800 border-indigo-200 hover:bg-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400 dark:border-indigo-800")}>
          <Repeat2 className="h-3.5 w-3.5" />
          {repeat && (
            <span className="text-xs">
              {repeatLabel(repeat as RepeatFrequency, repeatInterval, repeatUnit as RepeatUnit)}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-1" align="end">
        <RepeatConfigMenu
          repeat={repeat as RepeatFrequency | null}
          repeatInterval={repeatInterval}
          repeatUnit={repeatUnit as RepeatUnit}
          onRepeatChange={(v) => onRepeatChange(v)}
          onIntervalChange={onIntervalChange}
          onUnitChange={(v) => onUnitChange(v)}
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

export function TaskDialog({
  open,
  onOpenChange,
  editingTask,
  availableAssignees,
  availableCompanies,
  onRecordSearchChange,
  recordRequired,
  availableLabels = [],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- part of the public TaskDialog contract (inline label creation); not yet wired into this dialog's label picker UI.
  onCreateLabel,
  defaultRecord,
  defaultAssignee,
  recordLabel = 'Select record',
  hideRecord,
  projectId,
  availableStatuses,
  onSave,
  onUpdate,
  isPending,
}: TaskDialogProps) {
  const tCrm = getTranslations('crm');
  const st = useTranslations();
  const effectiveRecordLabel = recordLabel === 'Select record' ? tCrm.taskDialog.selectRecord : recordLabel;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<string>('todo');
  const [priority, setPriority] = useState<PriorityValue | null>(null);
  const [assigneeList, setAssigneeList] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState<Date | undefined>(undefined);
  const [record, setRecord] = useState<string | null>(null);
  const [recordName, setRecordName] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(30);
  const [repeat, setRepeat] = useState<RepeatValue | null>(null);
  const [repeatInterval, setRepeatInterval] = useState<number>(1);
  const [repeatUnit, setRepeatUnit] = useState<RepeatUnitValue>('days');
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [, setHasButtonOverflow] = useState(false);
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recordSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const availableCompaniesRef = useRef(availableCompanies);

  const handleRecordSearch = useCallback((value: string) => {
    if (!onRecordSearchChange) return;
    setIsSearchingRecords(true);
    if (recordSearchTimerRef.current) clearTimeout(recordSearchTimerRef.current);
    recordSearchTimerRef.current = setTimeout(() => {
      onRecordSearchChange(value);
    }, 150);
  }, [onRecordSearchChange]);

  useEffect(() => {
    if (availableCompaniesRef.current !== availableCompanies) {
      availableCompaniesRef.current = availableCompanies;
      setIsSearchingRecords(false);
    }
  }, [availableCompanies]);

  useEffect(() => {
    return () => {
      if (recordSearchTimerRef.current) clearTimeout(recordSearchTimerRef.current);
    };
  }, []);

  const normalizedCompanies: CompanyOption[] = availableCompanies.map((c) =>
    typeof c === 'string' ? { id: c, name: c, avatar: undefined as string | undefined, type: undefined as string | undefined } : c
  );
  const selectedCompany = record ? normalizedCompanies.find((c) => c.id === record) : undefined;
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
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      handleUploadFiles(dt.files);
    } else {
      // For plain text paste, prevent rich HTML paste
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      if (text) {
        document.execCommand('insertText', false, text);
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
      handleUploadFiles(e.dataTransfer.files);
    }
  }, [handleUploadFiles]);

  // Reset form when dialog opens/closes or editingTask changes
  useEffect(() => {
    if (open) {
      isSubmittingRef.current = false;
      const initial = getInitialFormState(editingTask, defaultAssignee, defaultRecord);
      setTitle(initial.title);
      setDescription(initial.description);
      setStatus(initial.status);
      setPriority(initial.priority);
      setAssigneeList(initial.assigneeList);
      setDueDate(initial.dueDate);
      setDuration(initial.duration);
      setRecord(initial.record);
      setRecordName(initial.recordName);
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
  }, [open, editingTask, defaultRecord, defaultAssignee, syncDescriptionToDiv]);

  useLayoutEffect(() => {
    if (buttonContainerRef.current) {
      const hasOverflow = buttonContainerRef.current.scrollWidth > buttonContainerRef.current.clientWidth;
      setHasButtonOverflow(hasOverflow);
    }
  }, [open, status, priority, assigneeList, dueDate, record, repeat, selectedLabels]);

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setStatus('todo');
    setPriority(null);
    setAssigneeList(defaultAssignee ? [defaultAssignee] : []);
    setDueDate(undefined);
    setRecord(defaultRecord || null);
    setRecordName(defaultRecord || null);
    setRepeat(null);
    setRepeatInterval(1);
    setRepeatUnit('days');
    setSelectedLabels([]);
    setCreateOnGithub(false);
    setSelectedGithubRepoLinkId(null);
    if (descriptionRef.current) descriptionRef.current.innerHTML = '';
  };

  const handleClose = () => {
    onOpenChange(false);
    resetForm();
  };

  const handleSubmit = () => {
    if (!title.trim() || isSubmittingRef.current) return;
    if (recordRequired && !record) return;

    isSubmittingRef.current = true;

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
        repeat,
        repeatInterval,
        repeatUnit,
        selectedLabels,
      },
      finalDescription,
    );

    if (editingTask) {
      onUpdate(editingTask.id, {
        ...common,
        linkedCompany: record ? { id: record, name: selectedCompanyLabel || '' } : null,
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
        linkedCompanyId: record || undefined,
      });
    }
  };

  const handleRecordChange = (company: { id: string; name: string } | null) => {
    setRecord(company?.id ?? null);
    setRecordName(company?.name ?? null);
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

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[600px] p-0 gap-0 overflow-hidden" showCloseButton={false}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-border">
          <DialogTitle className="text-base font-semibold">{editingTask ? tCrm.taskDialog.titleEdit : tCrm.taskDialog.titleCreate}</DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 translate-x-[4px] hover:ring-[3px] hover:ring-accent dark:hover:ring-accent"
            onClick={handleClose}
          >
            <X className="h-3.5 w-3.5 !text-gray-500 dark:!text-gray-400" strokeWidth={2.5} />
          </Button>
        </div>

        {/* Task Name Row */}
        <div className="px-4 py-[11px]">
          <textarea
            ref={titleTextareaRef}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              resizeTextarea(e.target, 200);
            }}
            onKeyDown={(e) => handleKeyDown(e, true)}
            placeholder={tCrm.taskDialog.placeholderTaskName}
            className="w-full text-sm font-medium border-none outline-none bg-transparent placeholder:text-gray-400 resize-none overflow-y-auto max-h-[200px] block break-words [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-gray-200 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-gray-300 dark:[&::-webkit-scrollbar-thumb]:bg-gray-700"
            rows={1}
            autoFocus
          />
        </div>

        <div className="border-b border-gray-100 dark:border-border" />

        {/* Description Row */}
        <div className="px-4 py-[11px] group relative min-w-0">
          <div
            className={cn(
              'relative rounded-md transition-colors',
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
              onInput={() => {
                const div = descriptionRef.current;
                if (!div) return;
                setDescription(htmlToMarkdown(div.innerHTML));
                scrollCaretIntoView(div);
              }}
              onKeyDown={(e) => handleKeyDown(e, false)}
              onPaste={handleDescriptionPaste}
              className="w-full text-sm text-gray-600 dark:text-muted-foreground border-none outline-none bg-transparent overflow-y-auto max-h-[350px] min-h-[20px] leading-5 break-words whitespace-pre-wrap [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-gray-200 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-gray-300 dark:[&::-webkit-scrollbar-thumb]:bg-gray-700 [&_img]:max-w-full [&_img]:max-h-[200px] [&_img]:rounded-md [&_img]:my-1 [&_img]:block [&_a]:text-primary [&_a]:underline"
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
          {!description && !isDraggingFile && (
            <Button
              variant="ghost"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                fileInputRef.current?.click();
              }}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-gray-400 opacity-0 transition-opacity duration-200 group-hover:opacity-100 hover:underline hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
            >
              {tCrm.taskDialog.pasteOrDropFiles}
            </Button>
          )}

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
              handleUploadFiles(e.target.files);
              if (fileInputRef.current) fileInputRef.current.value = '';
            }}
            className="hidden"
            accept="*/*"
          />
        </div>

        {/* Bottom Bar */}
        <div className="flex items-end justify-between px-4 py-2 border-t border-gray-100 dark:border-border gap-2 w-full">
          <div
            ref={buttonContainerRef}
            className={cn(
              "flex items-center gap-1 flex-wrap min-w-0 flex-shrink py-2.5",
            )}>
            <StatusPopover status={status} availableStatuses={availableStatuses} onChange={setStatus} />

            <PriorityPopover priority={priority} onChange={setPriority} />

            {/* Only labels of the active project (or workspace-wide ones) are offered. The project
                comes from the `projectId` prop on project-scoped views (where `record` is hidden)
                and falls back to `record` on cross-project views like My Tasks, where the
                selected linked record is itself a project. */}
            <LabelsPopover
              selectedLabels={selectedLabels}
              availableLabels={availableLabels}
              activeProjectId={projectId ?? record}
              onChange={setSelectedLabels}
            />

            <DurationPopover duration={duration} onChange={setDuration} />

            <div className="basis-full h-0" />

            <DueDatePopover dueDate={dueDate} onChange={setDueDate} />

            {/* Assignees (multi-select) */}
            <AssigneesPopover
              assigneeList={assigneeList}
              availableAssignees={availableAssignees}
              open={assigneePopoverOpen}
              onOpenChange={setAssigneePopoverOpen}
              onChange={setAssigneeList}
            />

            {/* Select Record */}
            {!hideRecord && (
              <RecordPopover
                record={record}
                companies={normalizedCompanies}
                selectedCompany={selectedCompany}
                selectedCompanyLabel={selectedCompanyLabel}
                defaultLabel={effectiveRecordLabel}
                recordRequired={recordRequired}
                isSearching={isSearchingRecords}
                onSearchChange={onRecordSearchChange ? handleRecordSearch : undefined}
                onChange={handleRecordChange}
              />
            )}
          </div>

          <div className="flex items-center gap-2 flex-shrink-0 -translate-y-[10px]">
            {/* Attach Files */}
            <Button
              variant="outline"
              size="sm"
              type="button"
              className="h-[30px] gap-1 px-2"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              title={st('sweep.weldcrm.taskDialog.attachFileTooltip')}
            >
              <Paperclip className="h-3.5 w-3.5" />
            </Button>

            {/* Repeat Task */}
            <RepeatPopover
              repeat={repeat}
              repeatInterval={repeatInterval}
              repeatUnit={repeatUnit}
              onRepeatChange={setRepeat}
              onIntervalChange={setRepeatInterval}
              onUnitChange={setRepeatUnit}
            />
            {showGithubCheckbox && (
              <GithubCreateOption
                outboundRepos={outboundRepos}
                createOnGithub={createOnGithub}
                selectedRepoLinkId={selectedGithubRepoLinkId}
                onCreateOnGithubChange={setCreateOnGithub}
                onRepoLinkChange={setSelectedGithubRepoLinkId}
              />
            )}
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!title.trim() || isPending || (recordRequired && !record)}
              className="h-[30px] text-xs px-3 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : editingTask ? (
                tCrm.taskDialog.save
              ) : (
                tCrm.taskDialog.createTask
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
