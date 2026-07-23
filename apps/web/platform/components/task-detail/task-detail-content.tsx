
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Check,
  Trash2,
  Repeat2,
  User,
  Calendar as CalendarIcon,
  Building,
  Flag,
  CircleDot,
  Clock,
  Tags,
  Plus,
  Upload,
  X,
  FileText,
  FileImage,
  FileVideo,
  File,
  Download,
  MessageSquare,
  Pencil,
  ArrowRight,
  ArrowLeft,
  ArrowUp,
  AtSign,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  EllipsisVertical,
  Pin,
  Sparkles,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { getTranslations } from '@/lib/i18n';
import { Input } from '@weldsuite/ui/components/input';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PopoverAnchor,
} from '@weldsuite/ui/components/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Calendar } from '@weldsuite/ui/components/calendar';
import { cn } from '@/lib/utils';
import { useDrawerFieldVisibility } from '@/hooks/use-drawer-field-visibility';
import { DrawerFieldSettings } from '@weldsuite/ui/components/drawer-field-settings';
import type { Task } from '@/hooks/use-crm-tasks';
import { format } from 'date-fns';
import { useFileUpload } from '@/hooks/use-file-upload';
import { toast } from 'sonner';
import { EntityAuditPanel } from '@/components/entity-audit-panel';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { ListCollapse, GitBranch, Paperclip, History, Smile, Bold, Italic, Strikethrough, Code, List, ListOrdered, Highlighter } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { EmojiPicker } from '@/app/weldchat/components/emoji-picker';
import { MentionAutocomplete } from '@/app/weldchat/components/mention-autocomplete';
import { useWorkspaceMembers } from '@/hooks/queries/use-weldchat-queries';

// Status configuration (color only — labels are translated at render time via
// `useTaskStatusLabels()` / `useTaskPriorityLabels()` / `useTaskRepeatLabels()` below)
const statusConfig = {
  'backlog': { color: 'bg-gray-100 dark:bg-secondary text-gray-600 dark:text-muted-foreground' },
  'todo': { color: 'bg-gray-100 dark:bg-secondary text-gray-600 dark:text-muted-foreground' },
  'in_progress': { color: 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400' },
  'in_review': { color: 'bg-yellow-50 dark:bg-yellow-950 text-yellow-600 dark:text-yellow-400' },
  'testing': { color: 'bg-purple-50 dark:bg-purple-950 text-purple-600 dark:text-purple-400' },
  'done': { color: 'bg-emerald-50 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400' },
  'cancelled': { color: 'bg-gray-100 dark:bg-secondary text-gray-600 dark:text-muted-foreground' },
};

// Priority configuration (color only — see note above)
const priorityConfig = {
  'low': { color: 'bg-gray-100 dark:bg-secondary text-gray-600 dark:text-muted-foreground' },
  'medium': { color: 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400' },
  'high': { color: 'bg-orange-50 dark:bg-orange-950 text-orange-600 dark:text-orange-400' },
};

// Repeat configuration
const repeatOrder = ['daily', 'weekly', 'biweekly', 'monthly', 'yearly'] as const;

function useTaskStatusLabels(t: (path: string, params?: Record<string, unknown>) => string): Record<keyof typeof statusConfig, string> {
  return {
    backlog: t('sweep.shared.taskStatus.backlog'),
    todo: t('sweep.shared.taskStatus.todo'),
    in_progress: t('sweep.shared.taskStatus.inProgress'),
    in_review: t('sweep.shared.taskStatus.inReview'),
    testing: t('sweep.shared.taskStatus.testing'),
    done: t('sweep.shared.taskStatus.done'),
    cancelled: t('sweep.shared.taskStatus.cancelled'),
  };
}

function useTaskPriorityLabels(t: (path: string, params?: Record<string, unknown>) => string): Record<keyof typeof priorityConfig, string> {
  return {
    low: t('sweep.shared.taskPriority.low'),
    medium: t('sweep.shared.taskPriority.medium'),
    high: t('sweep.shared.taskPriority.high'),
  };
}

function useTaskRepeatLabels(t: (path: string, params?: Record<string, unknown>) => string): Record<typeof repeatOrder[number], string> {
  return {
    daily: t('sweep.shared.taskRepeat.daily'),
    weekly: t('sweep.shared.taskRepeat.weekly'),
    biweekly: t('sweep.shared.taskRepeat.biweekly'),
    monthly: t('sweep.shared.taskRepeat.monthly'),
    yearly: t('sweep.shared.taskRepeat.yearly'),
  };
}

const LABEL_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#22c55e',
  '#3b82f6', '#8b5cf6', '#ec4899', '#6b7280',
];

/**
 * Project labels are stored two different ways depending on which UI created
 * them:
 *   - Created via the project settings → stored as a Tailwind class string
 *     like "bg-red-500" (the colored-square palette).
 *   - Created via the task-dialog quick-create here → stored as a hex like
 *     "#ef4444" (LABEL_COLORS above).
 *
 * The label picker rendered `style={{ backgroundColor: label.color }}` —
 * which works for hex but produces invalid CSS for the Tailwind-class form
 * (the pill ends up with no background, and the hardcoded `text-white` then
 * leaves the label invisible against the popover's white surface). This
 * resolver normalizes both shapes to a hex and returns a contrast-aware text
 * color computed from that hex.
 */
const LABEL_TAILWIND_TO_HEX: Record<string, string> = {
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

function resolveLabelHex(color: string | null | undefined): string {
  if (!color) return '#6b7280';
  if (color.startsWith('#')) return color;
  return LABEL_TAILWIND_TO_HEX[color] ?? '#6b7280';
}

/**
 * Choose readable text (white or gray-800) for a label pill, computed from
 * the resolved hex via the YIQ luminance approximation. Mid-tones split at
 * 160/255 — gives white text on saturated colors and dark text on pale/yellow.
 */
function readableLabelTextColor(color: string | undefined): string {
  const hex = resolveLabelHex(color).replace('#', '');
  if (hex.length !== 3 && hex.length !== 6) return '#ffffff';
  const expand = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const r = parseInt(expand.slice(0, 2), 16);
  const g = parseInt(expand.slice(2, 4), 16);
  const b = parseInt(expand.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return '#ffffff';
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 160 ? '#1f2937' /* gray-800 */ : '#ffffff';
}

/**
 * Deterministic colored fallback for an assignee avatar — matches Clerk's
 * default identicon style (colored square with the user's initial). Picks
 * one of a small palette based on a stable hash of the id+name so the same
 * user always gets the same color across the app.
 */
const ASSIGNEE_AVATAR_PALETTE = [
  '#0d9488', // teal-600
  '#16a34a', // green-600
  '#2563eb', // blue-600
  '#7c3aed', // violet-600
  '#db2777', // pink-600
  '#dc2626', // red-600
  '#ea580c', // orange-600
  '#ca8a04', // yellow-600
  '#0891b2', // cyan-600
  '#4f46e5', // indigo-600
];

function assigneeFallbackColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % ASSIGNEE_AVATAR_PALETTE.length;
  return ASSIGNEE_AVATAR_PALETTE[idx]!;
}

interface AssigneeAvatarProps {
  id?: string;
  name?: string;
  avatar?: string;
  className?: string;
}

/**
 * Single shared assignee-avatar renderer for the task detail panel —
 * everywhere a user pill is shown (the assigned-row trigger and the picker
 * dropdown items) routes through this so the styling can never drift.
 */
function AssigneeAvatar({ id, name, avatar, className }: AssigneeAvatarProps) {
  const seed = id || name || '?';
  const bg = assigneeFallbackColor(seed);
  const initial = (name || '?').charAt(0).toUpperCase();
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

export interface TaskAttachment {
  id: string;
  fileName: string;
  fileKey: string;
  fileSize: number;
  mimeType: string;
  url: string;
}

export interface TaskComment {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubtaskItem {
  id: string;
  title: string;
  status: string;
  assignee?: { id: string; name: string; avatar?: string } | null;
  /** Nesting level within the current task's subtree. 0 = direct child of the
   *  task shown in the detail panel, 1 = grandchild, etc. Used to indent rows
   *  in the Subtasks section so deep trees are visible in a flat list. */
  depth?: number;
}

export interface DependencyTask {
  id: string;
  title: string;
  status: string;
  key?: string;
}

export interface TaskDetailContentProps {
  task: Task;
  onUpdate: (taskId: string, data: any) => void;
  availableAssignees: string[] | { id: string; name: string }[];
  availableCompanies: { id: string; name: string; avatar?: string }[];
  availableLabels?: { id: string; name: string; color: string }[];
  onCreateLabel?: (data: { name: string; color: string }) => Promise<{ id: string; name: string; color: string } | null>;
  projectId?: string;
  taskId?: string;
  attachments?: TaskAttachment[];
  /**
   * Legacy wholesale-array callback (writes the full list). Still used by any
   * consumer that stores attachments as a blob. Prefer the explicit
   * add/remove callbacks below, which back attachments with real `files` rows
   * (docs/custom-fields-blob-extraction.md).
   */
  onAttachmentsChange?: (attachments: TaskAttachment[]) => void;
  /** Persist one just-uploaded attachment (creates a files row). Takes precedence over onAttachmentsChange. */
  onAttachmentAdd?: (attachment: TaskAttachment) => void | Promise<void>;
  /** Remove one attachment by id (soft-deletes its files row). Takes precedence over onAttachmentsChange. */
  onAttachmentRemove?: (attachmentId: string) => void | Promise<void>;
  comments?: TaskComment[];
  onAddComment?: (content: string) => void;
  onUpdateComment?: (commentId: string, content: string) => void;
  onDeleteComment?: (commentId: string) => void;
  currentUserId?: string;
  // Subtasks
  subtasks?: SubtaskItem[];
  onCreateSubtask?: () => void;
  onToggleSubtask?: (subtaskId: string, currentStatus: string) => void;
  onNavigateToTask?: (taskId: string) => void;
  parentTask?: { id: string; title: string; status?: string } | null;
  // Dependencies
  dependencyTasks?: DependencyTask[];
  blockingTasks?: DependencyTask[];
  allProjectTasks?: DependencyTask[];
  onAddDependency?: (targetTaskId: string, type: 'blocks' | 'blockedBy') => void;
  onRemoveDependency?: (targetTaskId: string, type: 'blocks' | 'blockedBy') => void;
  hiddenFields?: string[];
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function GithubIssueBadge({ task }: { task: Task }) {
  const t = getTranslations('settings');
  const github = t.integrations.github;

  const issueNumber: number = (task as any).githubIssueNumber;
  const repoLinkId: string = (task as any).githubRepoLinkId;
  const { data: linkedReposResult } = useLinkedRepos();
  const linkedRepos = ((linkedReposResult as any)?.data ?? []) as Array<{ id: string; repoFullName: string; lastSyncedAt: string | null }>;
  const repoLink = linkedRepos.find((r) => r.id === repoLinkId);

  const issueUrl = repoLink
    ? `https://github.com/${repoLink.repoFullName}/issues/${issueNumber}`
    : null;

  const lastSynced = repoLink?.lastSyncedAt ? formatRelativeTime(repoLink.lastSyncedAt) : null;

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2 w-32 flex-shrink-0">
        <Github className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{github.title}</span>
      </div>
      <div className="flex-1 h-8 text-sm rounded-md px-2 -mx-2 flex items-center">
        {issueUrl ? (
          <a
            href={issueUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={lastSynced ? `${github.taskDetail.lastSynced}: ${lastSynced}` : undefined}
            className="flex items-center gap-1.5 text-sm text-foreground hover:text-primary transition-colors group"
          >
            <span className="font-medium">
              {repoLink?.repoFullName}#{issueNumber}
            </span>
            <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
          </a>
        ) : (
          <span className="text-muted-foreground">
            #{issueNumber}
          </span>
        )}
        {lastSynced && (
          <span className="ml-2 text-xs text-muted-foreground">
            · {github.taskDetail.lastSynced}: {lastSynced}
          </span>
        )}
      </div>
    </div>
  );
}

function formatRepeat(
  repeat: Task['repeat'],
  t: (path: string, params?: Record<string, unknown>) => string,
  repeatLabels: Record<string, string>,
) {
  if (!repeat) return null;
  if (repeat.frequency === 'custom' && repeat.interval && repeat.unit) {
    return t('sweep.shared.everyIntervalUnit', { interval: repeat.interval, unit: repeat.unit });
  }
  return repeatLabels[repeat.frequency] || repeat.frequency;
}

function getFileIcon(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext || '')) return FileImage;
  if (['mp4', 'avi', 'mov', 'wmv', 'flv', 'webm'].includes(ext || '')) return FileVideo;
  if (['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt'].includes(ext || '')) return FileText;
  return File;
}

function isPreviewable(fileName: string): 'image' | 'video' | 'pdf' | null {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext || '')) return 'image';
  if (['mp4', 'webm', 'mov'].includes(ext || '')) return 'video';
  if (ext === 'pdf') return 'pdf';
  return null;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
}

export function TaskDetailContent({
  task,
  onUpdate,
  availableAssignees,
  availableCompanies,
  availableLabels = [],
  onCreateLabel,
  projectId,
  taskId,
  attachments = [],
  onAttachmentsChange,
  onAttachmentAdd,
  onAttachmentRemove,
  comments = [],
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  currentUserId,
  subtasks = [],
  onCreateSubtask,
  onToggleSubtask,
  onNavigateToTask,
  parentTask,
  dependencyTasks = [],
  blockingTasks = [],
  allProjectTasks = [],
  onAddDependency,
  onRemoveDependency,
  hiddenFields,
}: TaskDetailContentProps) {
  const t = useTranslations();
  const statusLabels = useTaskStatusLabels(t);
  const priorityLabels = useTaskPriorityLabels(t);
  const repeatLabels = useTaskRepeatLabels(t);
  const {
    isFieldVisible: isFieldVisibleBase,
    fields,
    fieldVisibility,
    toggleField,
    resetToDefaults,
  } = useDrawerFieldVisibility('task-detail');
  const isFieldVisible = useCallback(
    (fieldId: string) => {
      if (hiddenFields?.includes(fieldId)) return false;
      return isFieldVisibleBase(fieldId);
    },
    [hiddenFields, isFieldVisibleBase]
  );
  const [isCreatingLabel, setIsCreatingLabel] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');
  // Repeat popover open state (controlled so we can close it after a preset
  // / Clear click, while keeping it open for Custom interval/unit tweaks).
  const [repeatPopoverOpen, setRepeatPopoverOpen] = useState(false);
  // Company picker — search lives in the data row (combobox pattern) so we
  // control both the popover open state and the query string from here.
  const [companyPopoverOpen, setCompanyPopoverOpen] = useState(false);
  const [companyQuery, setCompanyQuery] = useState('');
  const filteredCompanies = useMemo(() => {
    const q = companyQuery.trim().toLowerCase();
    if (!q) return availableCompanies;
    return availableCompanies.filter((c) => c.name.toLowerCase().includes(q));
  }, [companyQuery, availableCompanies]);
  const [newLabelColor, setNewLabelColor] = useState(LABEL_COLORS[4]);
  const [previewAttachment, setPreviewAttachment] = useState<TaskAttachment | null>(null);
  const [activeTab, setActiveTab] = useState('details');
  const [attachmentsCollapsed, setAttachmentsCollapsed] = useState(attachments.length === 0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tabs: PageTab[] = [
    { id: 'details', label: t('sweep.shared.details'), icon: ListCollapse },
    ...(taskId ? [{ id: 'history', label: t('sweep.shared.history'), icon: History }] : []),
  ];
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const { uploadFile, isUploading, progress, currentFileName } = useFileUpload({
    folder: 'projects',
    entityType: 'task',
    entityId: taskId,
    onError: (error) => toast.error(error),
  });

  const handleFiles = useCallback(async (files: FileList | null) => {
    // Accept either the explicit files-backed add callback or the legacy
    // wholesale-array one; do nothing if neither is wired.
    if (!files || (!onAttachmentAdd && !onAttachmentsChange)) return;

    const fileArray = Array.from(files);
    for (const file of fileArray) {
      if (file.size > 25 * 1024 * 1024) {
        toast.error(t('sweep.shared.fileSizeExceedsLimit', { name: file.name, limit: '25MB' }));
        continue;
      }
      const result = await uploadFile(file);
      if (result) {
        const newAttachment: TaskAttachment = {
          id: result.id,
          fileName: result.fileName,
          fileKey: result.fileKey,
          fileSize: result.fileSize,
          mimeType: result.mimeType,
          url: result.url,
        };
        if (onAttachmentAdd) {
          await onAttachmentAdd(newAttachment);
        } else {
          onAttachmentsChange?.([...attachmentsRef.current, newAttachment]);
        }
      }
    }
  }, [onAttachmentAdd, onAttachmentsChange, uploadFile]);

  const handleRemoveAttachment = useCallback((attachmentId: string) => {
    if (onAttachmentRemove) {
      void onAttachmentRemove(attachmentId);
      return;
    }
    if (!onAttachmentsChange) return;
    onAttachmentsChange(attachments.filter(a => a.id !== attachmentId));
  }, [attachments, onAttachmentRemove, onAttachmentsChange]);


  return (
    <div className="overflow-hidden min-w-0" style={{ overflowX: 'hidden' }}>
      {/* Tabs — padding lives on the inner flex so the bottom border extends
          edge-to-edge across the whole panel width. The field-visibility
          settings gear lives on the far right of this row. */}
      <PageTabs
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        className="border-border"
        innerClassName="px-4"
      >
        <div className="ml-auto flex items-center pb-1">
          <DrawerFieldSettings
            fields={fields}
            fieldVisibility={fieldVisibility}
            onToggle={toggleField}
            onReset={resetToDefaults}
            label={t('sweep.shared.taskFields')}
          />
        </div>
      </PageTabs>

      {/* Tab content */}
      <div className="p-4">

      {/* Details Tab */}
      {activeTab === 'details' && (
        <div>
          <div className="space-y-1">
          {/* Status */}
          {isFieldVisible('status') && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 w-32 flex-shrink-0">
              <CircleDot className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{t('sweep.shared.status')}</span>
            </div>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" className="h-8 text-sm text-left cursor-pointer inline-flex items-center self-start group/field">
                  <span className={cn(
                    "inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none ring-1 ring-transparent group-hover/field:ring-gray-300 dark:group-hover/field:ring-gray-600 transition-shadow",
                    statusConfig[task.status]?.color,
                  )}>
                    {statusLabels[task.status]}
                  </span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-1" align="start">
                {Object.entries(statusConfig).map(([key]) => (
                  <Button
                    variant="ghost"
                    key={key}
                    onClick={() => onUpdate(task.id, { status: key as Task['status'] })}
                    className="flex items-center justify-between w-full px-1.5 py-1.5 text-sm text-left hover:bg-muted rounded"
                  >
                    <span>{statusLabels[key as keyof typeof statusLabels]}</span>
                    {task.status === key && <Check className="h-3.5 w-3.5 text-primary" />}
                  </Button>
                ))}
              </PopoverContent>
            </Popover>
          </div>
          )}

          {/* Priority */}
          {isFieldVisible('priority') && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 w-32 flex-shrink-0">
              <Flag className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{t('sweep.shared.priority')}</span>
            </div>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" className="h-8 text-sm text-left cursor-pointer inline-flex items-center self-start group/field">
                  {task.priority ? (
                    <span className={cn(
                      "inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none ring-1 ring-transparent group-hover/field:ring-gray-300 dark:group-hover/field:ring-gray-600 transition-shadow",
                      priorityConfig[task.priority]?.color,
                    )}>
                      {priorityLabels[task.priority]}
                    </span>
                  ) : (
                    <span className="text-muted-foreground group-hover/field:underline">{t('sweep.shared.setPriority')}</span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-1" align="start">
                {Object.entries(priorityConfig).map(([key]) => (
                  <Button
                    variant="ghost"
                    key={key}
                    onClick={() => onUpdate(task.id, { priority: key as Task['priority'] })}
                    className="flex items-center justify-between w-full px-1.5 py-1.5 text-sm text-left hover:bg-muted rounded"
                  >
                    <span>{priorityLabels[key as keyof typeof priorityLabels]}</span>
                    {task.priority === key && <Check className="h-3.5 w-3.5 text-primary" />}
                  </Button>
                ))}
                {task.priority && (
                  <>
                    <div className="h-px bg-border my-1" />
                    <Button
                      variant="ghost"
                      onClick={() => onUpdate(task.id, { priority: undefined })}
                      className="flex items-center w-full px-1.5 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-2 text-red-600" />
                      <span>{t('sweep.shared.clear')}</span>
                    </Button>
                  </>
                )}
              </PopoverContent>
            </Popover>
          </div>
          )}

          {/* Due Date */}
          {isFieldVisible('dueDate') && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 w-32 flex-shrink-0">
              <CalendarIcon className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{t('sweep.shared.dueDate')}</span>
            </div>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" className={cn(
                  "h-8 text-sm text-left rounded-md px-[5px] -mx-[5px] cursor-pointer inline-flex items-center self-start group/field transition-colors",
                  task.dueDate && "border border-transparent hover:border-border hover:bg-muted/40",
                )}>
                  {task.dueDate ? (
                    <span className={cn(
                      task.dueDate < new Date() && task.status !== 'done' && "text-red-600 dark:text-red-400"
                    )}>
                      {format(task.dueDate, 'MMM d, yyyy')}
                    </span>
                  ) : (
                    <span className="text-muted-foreground group-hover/field:underline">{t('sweep.shared.setDueDate')}</span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={task.dueDate}
                  onSelect={(date) => onUpdate(task.id, { dueDate: date })}
                  initialFocus
                />
                {task.dueDate && (
                  <div className="p-1 border-t border-border">
                    <Button
                      variant="ghost"
                      onClick={() => onUpdate(task.id, { dueDate: undefined })}
                      className="flex items-center w-full px-1.5 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-2 text-red-600" />
                      <span>{t('sweep.shared.clear')}</span>
                    </Button>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </div>
          )}

          {/* Scheduled slot — read-only, sourced from the linked calendar event.
              Shown only when the task has actually been auto-scheduled or
              manually pinned to a time. */}
          {(() => {
            const scheduledStart = (task as any).scheduledStart
              ? new Date((task as any).scheduledStart)
              : null;
            const scheduledEnd = (task as any).scheduledEnd
              ? new Date((task as any).scheduledEnd)
              : null;
            const autoScheduled = (task as any).autoScheduled;
            if (!scheduledStart) return null;
            const sameDay =
              scheduledEnd &&
              scheduledStart.toDateString() === scheduledEnd.toDateString();
            const display = scheduledEnd
              ? sameDay
                ? `${format(scheduledStart, 'MMM d, HH:mm')}–${format(scheduledEnd, 'HH:mm')}`
                : `${format(scheduledStart, 'MMM d, HH:mm')} – ${format(scheduledEnd, 'MMM d, HH:mm')}`
              : format(scheduledStart, 'MMM d, HH:mm');
            return (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 w-32 flex-shrink-0">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">{t('sweep.shared.scheduled')}</span>
                </div>
                <div className="h-8 inline-flex items-center gap-2 text-sm">
                  <span>{display}</span>
                  {autoScheduled === false && (
                    <span
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                      title={t('sweep.shared.pinnedAutoSchedulingOffTitle')}
                    >
                      <Pin className="h-3 w-3" />
                      {t('sweep.shared.pinned')}
                    </span>
                  )}
                  {autoScheduled === true && (
                    <span
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                      title={t('sweep.shared.autoScheduledTitle')}
                    >
                      <Sparkles className="h-3 w-3" />
                      {t('sweep.shared.auto')}
                    </span>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Assignees (multi-select) */}
          {isFieldVisible('assignee') && (
          <div className="flex items-start gap-3 group/assignees">
            <div className="flex items-center gap-2 w-32 flex-shrink-0 h-8">
              <User className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{t('sweep.shared.assignees')}</span>
            </div>
            <div className="flex-1 min-w-0">
              {/* Single trigger — clicking anywhere on the assignees area
                  opens the picker. Matches the Status/Priority/Labels pattern.
                  Inner remove buttons stopPropagation so they don't toggle
                  the popover. Uses a <div> trigger so the inner remove
                  buttons stay valid HTML (no nested <button>s). */}
              <Popover>
                <PopoverTrigger asChild>
                  <div
                    role="button"
                    tabIndex={0}
                    className="text-sm cursor-pointer flex items-start justify-between gap-2 self-start min-h-8 outline-none focus-visible:ring-2 focus-visible:ring-ring w-full group/field"
                  >
                    {((task as any).assignees?.length > 0 || task.assignee) ? (
                      <>
                        <div className="flex flex-col gap-1 min-w-0">
                          {((task as any).assignees || (task.assignee ? [task.assignee] : [])).map((a: any) => (
                            <div
                              key={a.id || a.name}
                              className="flex items-center gap-2 pl-0.5 pr-1.5 py-0.5 -ml-0.5 rounded-[6px] group/assignee"
                            >
                              <AssigneeAvatar id={a.id} name={a.name} avatar={a.avatar} />
                              <span className="text-sm text-gray-600 dark:text-muted-foreground truncate max-w-[150px]">
                                {a.name}
                              </span>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  e.preventDefault();
                                  const current: any[] = (task as any).assignees || (task.assignee ? [task.assignee] : []);
                                  const updated = current.filter((x: any) => (x.id || x.name) !== (a.id || a.name));
                                  onUpdate(task.id, { assignees: updated.length > 0 ? updated : null });
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
                          aria-label={t('sweep.shared.addAssignee')}
                        >
                          <Plus className="h-4 w-4" />
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground group-hover/field:underline">{t('sweep.shared.addAssignee')}</span>
                    )}
                  </div>
                </PopoverTrigger>
                <PopoverContent className="w-64 p-0" align="start">
                  <Command>
                    <CommandInput placeholder={t('sweep.shared.searchAssigneesPlaceholder')} />
                    <CommandList className="max-h-[260px] p-1">
                      <CommandEmpty>{t('sweep.shared.noAssigneesFound')}</CommandEmpty>
                      {availableAssignees.map((item) => {
                        const id = typeof item === 'string' ? item : item.id;
                        const name = typeof item === 'string' ? item : item.name;
                        const avatar = typeof item === 'string' ? undefined : (item as any).avatar;
                        const current: any[] = (task as any).assignees || (task.assignee ? [task.assignee] : []);
                        const isSelected = current.some((a: any) => a.id === id || a.name === name);
                        return (
                          <CommandItem
                            key={id}
                            value={name}
                            onSelect={() => {
                              if (isSelected) {
                                const updated = current.filter((a: any) => (a.id || a.name) !== id && a.name !== name);
                                onUpdate(task.id, { assignees: updated.length > 0 ? updated : null });
                              } else {
                                onUpdate(task.id, { assignees: [...current, { id, name, avatar }] });
                              }
                            }}
                            className="flex items-center justify-between gap-2 px-1.5"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <AssigneeAvatar id={id} name={name} avatar={avatar} />
                              <span className="truncate">{name}</span>
                            </div>
                            {isSelected && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                          </CommandItem>
                        );
                      })}
                      {((task as any).assignees?.length > 0 || task.assignee) && (
                        <>
                          <div className="h-px bg-border my-1" />
                          <CommandItem
                            value="__clear__"
                            onSelect={() => onUpdate(task.id, { assignees: null })}
                            className="px-1.5 text-red-600 data-[selected=true]:text-red-600 data-[selected=true]:bg-red-50 dark:data-[selected=true]:bg-red-950"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="h-5 w-5 flex items-center justify-center shrink-0">
                                <Trash2 className="h-3.5 w-3.5 text-red-600" />
                              </div>
                              <span>{t('sweep.shared.clearAll')}</span>
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
          )}

          {/* Company */}
          {isFieldVisible('company') && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 w-32 flex-shrink-0">
              <Building className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{t('sweep.shared.customer')}</span>
            </div>
            <Popover
              open={companyPopoverOpen}
              onOpenChange={(open) => {
                setCompanyPopoverOpen(open);
                if (!open) setCompanyQuery('');
              }}
            >
              {companyPopoverOpen ? (
                <PopoverAnchor asChild>
                  <Input
                    autoFocus
                    value={companyQuery}
                    onChange={(e) => setCompanyQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setCompanyPopoverOpen(false);
                    }}
                    placeholder={t('sweep.shared.searchCustomerPlaceholder')}
                    className="h-8 text-sm -mx-2 w-auto min-w-[200px] self-start border-0 shadow-none focus-visible:ring-0 px-2 bg-transparent"
                  />
                </PopoverAnchor>
              ) : (
                <PopoverTrigger asChild>
                  <Button variant="ghost" className={cn(
                    "h-8 text-sm text-left rounded-md px-[5px] -mx-[5px] cursor-pointer inline-flex items-center self-start gap-2 group/field transition-colors",
                    task.linkedCompany && "border border-transparent hover:border-border hover:bg-muted/40",
                  )}>
                    {task.linkedCompany ? (
                      <>
                        <Avatar className="h-5 w-5 rounded-[7px]">
                          <AvatarImage src={(task.linkedCompany as any).avatar} className="rounded-[7px]" />
                          <AvatarFallback className="text-[10px] rounded-[7px]">
                            {(task.linkedCompany.name || '?').charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-foreground">{task.linkedCompany.name}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground group-hover/field:underline">{t('sweep.shared.setCustomer')}</span>
                    )}
                  </Button>
                </PopoverTrigger>
              )}
              <PopoverContent
                className="w-[260px] p-0 overflow-hidden"
                align="start"
                sideOffset={4}
                onOpenAutoFocus={(e) => e.preventDefault()}
              >
                {/* Scrollable list — only left/vertical padding so hover
                    backgrounds extend all the way to the scrollbar on the
                    right side. */}
                <div className="max-h-[240px] overflow-y-auto py-1 pl-1">
                  {filteredCompanies.length === 0 ? (
                    <div className="px-2 py-6 text-sm text-center text-muted-foreground">
                      {t('sweep.shared.noCustomerFound')}
                    </div>
                  ) : (
                    filteredCompanies.map((company) => {
                      const isSelected = task.linkedCompany?.id === company.id;
                      return (
                        <Button
                          variant="ghost"
                          key={company.id}
                          onClick={() => {
                            onUpdate(task.id, { linkedCompany: company });
                            setCompanyPopoverOpen(false);
                          }}
                          className="flex items-center gap-2 w-full pl-1.5 pr-2 py-1.5 text-sm text-left hover:bg-muted rounded"
                        >
                          <Avatar className="h-5 w-5 rounded-[7px]">
                            <AvatarImage src={company.avatar} className="rounded-[7px]" />
                            <AvatarFallback className="text-[10px] rounded-[7px]">
                              {(company.name || '?').charAt(0).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <span className="flex-1 truncate">{company.name}</span>
                          {isSelected && <Check className="ml-auto h-3.5 w-3.5 text-primary shrink-0" />}
                        </Button>
                      );
                    })
                  )}
                </div>
                {task.linkedCompany && (
                  <div className="border-t border-border p-1">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        onUpdate(task.id, { linkedCompany: null });
                        setCompanyPopoverOpen(false);
                      }}
                      className="flex items-center w-full px-1.5 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-2 text-red-600" />
                      <span>{t('sweep.shared.clear')}</span>
                    </Button>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </div>
          )}

          {/* Labels */}
          {isFieldVisible('labels') && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 w-32 flex-shrink-0">
              <Tags className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{t('sweep.shared.labels')}</span>
            </div>
            <Popover onOpenChange={(open) => { if (!open) { setIsCreatingLabel(false); setNewLabelName(''); setNewLabelColor(LABEL_COLORS[4]); } }}>
              <PopoverTrigger asChild>
                {(() => {
                  const resolvedLabels = (task.labels ?? [])
                    .map((labelId) => availableLabels.find((l) => l.id === labelId))
                    .filter((l): l is NonNullable<typeof l> => !!l);
                  const hasResolvedLabels = resolvedLabels.length > 0;
                  return (
                    <Button variant="ghost" className={cn(
                      "h-8 text-sm text-left rounded-md px-[5px] -mx-[5px] cursor-pointer inline-flex items-center self-start gap-1 flex-wrap group/field transition-colors",
                      hasResolvedLabels && "border border-transparent hover:border-border hover:bg-muted/40",
                    )}>
                      {hasResolvedLabels ? (
                        resolvedLabels.map((label) => (
                          <span
                            key={label.id}
                            className="px-2 py-0.5 rounded text-[12px] font-medium"
                            style={{
                              backgroundColor: resolveLabelHex(label.color),
                              color: readableLabelTextColor(label.color),
                            }}
                          >
                            {label.name}
                          </span>
                        ))
                      ) : (
                        <span className="text-muted-foreground group-hover/field:underline">{t('sweep.shared.setLabels')}</span>
                      )}
                    </Button>
                  );
                })()}
              </PopoverTrigger>
              <PopoverContent className="w-auto p-1 min-w-[200px]" align="start">
                {availableLabels.map((label) => {
                  const isSelected = task.labels?.includes(label.id) ?? false;
                  return (
                    <Button
                      variant="ghost"
                      key={label.id}
                      onClick={() => {
                        const currentLabels = task.labels || [];
                        const newLabels = isSelected
                          ? currentLabels.filter(id => id !== label.id)
                          : [...currentLabels, label.id];
                        onUpdate(task.id, { labels: newLabels });
                      }}
                      className="flex items-center justify-between w-full px-1.5 py-1.5 text-sm text-left hover:bg-muted rounded gap-2"
                    >
                      <span
                        className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none"
                        style={{
                          backgroundColor: resolveLabelHex(label.color),
                          color: readableLabelTextColor(label.color),
                        }}
                      >
                        {label.name}
                      </span>
                      {isSelected && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                    </Button>
                  );
                })}
                {task.labels && task.labels.length > 0 && (
                  <>
                    <div className="h-px bg-border my-1" />
                    <Button
                      variant="ghost"
                      onClick={() => onUpdate(task.id, { labels: [] })}
                      className="flex items-center w-full px-1.5 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-2 text-red-600" />
                      <span>{t('sweep.shared.clearAll')}</span>
                    </Button>
                  </>
                )}
              </PopoverContent>
            </Popover>
          </div>
          )}

          {/* Repeat */}
          {isFieldVisible('repeat') && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 w-32 flex-shrink-0">
              <Repeat2 className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{t('sweep.shared.repeat')}</span>
            </div>
            <Popover open={repeatPopoverOpen} onOpenChange={setRepeatPopoverOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" className={cn(
                  "h-8 text-sm text-left rounded-md px-[5px] -mx-[5px] cursor-pointer inline-flex items-center self-start group/field transition-colors",
                  task.repeat && "border border-transparent hover:border-border hover:bg-muted/40",
                )}>
                  {task.repeat ? (
                    <span className="text-indigo-600 dark:text-indigo-400">
                      {formatRepeat(task.repeat, t, repeatLabels)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground group-hover/field:underline">{t('sweep.shared.setRepeat')}</span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-1" align="start">
                {repeatOrder.map((key) => (
                  <Button
                    variant="ghost"
                    key={key}
                    onClick={() => {
                      onUpdate(task.id, { repeat: { frequency: key } });
                      setRepeatPopoverOpen(false);
                    }}
                    className="flex items-center justify-between w-full px-1.5 py-1.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-secondary rounded"
                  >
                    <span>{repeatLabels[key]}</span>
                    {task.repeat?.frequency === key && <Check className="h-3.5 w-3.5 text-primary" />}
                  </Button>
                ))}
                <div className="h-px bg-gray-200 dark:bg-accent my-1" />
                <Button
                  variant="ghost"
                  onClick={() => onUpdate(task.id, {
                    repeat: {
                      frequency: 'custom',
                      interval: task.repeat?.frequency === 'custom' ? (task.repeat.interval ?? 1) : 1,
                      unit: task.repeat?.frequency === 'custom' ? (task.repeat.unit ?? 'days') : 'days',
                    },
                  })}
                  className="flex items-center justify-between w-full px-1.5 py-1.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-secondary rounded"
                >
                  <span>{t('sweep.shared.custom')}</span>
                  {task.repeat?.frequency === 'custom' && <Check className="h-3.5 w-3.5 text-primary" />}
                </Button>
                {task.repeat?.frequency === 'custom' && (
                  <div className="flex items-center gap-2 px-2 py-2 mt-1">
                    <span className="text-sm text-muted-foreground">{t('sweep.shared.every')}</span>
                    <Input
                      type="number"
                      min={1}
                      value={task.repeat.interval ?? 1}
                      onChange={(e) => {
                        const interval = Math.max(1, parseInt(e.target.value, 10) || 1);
                        onUpdate(task.id, {
                          repeat: { frequency: 'custom', interval, unit: task.repeat?.unit ?? 'days' },
                        });
                      }}
                      className="w-16 text-center"
                    />
                    <Select
                      value={task.repeat.unit ?? 'days'}
                      onValueChange={(value) => {
                        onUpdate(task.id, {
                          repeat: { frequency: 'custom', interval: task.repeat?.interval ?? 1, unit: value },
                        });
                      }}
                    >
                      <SelectTrigger className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="days">{t('sweep.shared.repeatUnit.days')}</SelectItem>
                        <SelectItem value="weeks">{t('sweep.shared.repeatUnit.weeks')}</SelectItem>
                        <SelectItem value="months">{t('sweep.shared.repeatUnit.months')}</SelectItem>
                        <SelectItem value="years">{t('sweep.shared.repeatUnit.years')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {task.repeat && (
                  <>
                    <div className="h-px bg-gray-200 dark:bg-accent my-1" />
                    <Button
                      variant="ghost"
                      onClick={() => {
                        onUpdate(task.id, { repeat: null });
                        setRepeatPopoverOpen(false);
                      }}
                      className="flex items-center w-full px-1.5 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-2 text-red-600" />
                      <span>{t('sweep.shared.clear')}</span>
                    </Button>
                  </>
                )}
              </PopoverContent>
            </Popover>
          </div>
          )}

          {/* Created */}
          {isFieldVisible('created') && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 w-32 flex-shrink-0">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{t('sweep.shared.created')}</span>
            </div>
            <div className="flex-1 h-8 text-sm rounded-md px-2 -mx-2 flex items-center">
              <span className="text-muted-foreground">
                {format(task.createdAt, 'MMM d, yyyy')}
              </span>
            </div>
          </div>
          )}

          {/* GitHub issue badge */}
          {(task as any).githubIssueNumber != null && (task as any).githubRepoLinkId != null && (
            <GithubIssueBadge task={task} />
          )}

          </div>

          {/* Subtasks — includes the parent-task row at the top when the
              selected task is a subtask. `currentTaskId` keeps the active
              row visually highlighted so the user knows which task is open. */}
          {isFieldVisible('subtasks') && onCreateSubtask && (
            <div className="mt-6">
              <SubtasksSection
                subtasks={subtasks}
                parentTask={parentTask}
                currentTaskId={task.id}
                rootTask={{ id: task.id, title: task.title, status: task.status }}
                onCreateSubtask={onCreateSubtask}
                onToggleSubtask={onToggleSubtask}
                onNavigateToTask={onNavigateToTask}
              />
            </div>
          )}

          {/* Dependencies */}
          {isFieldVisible('dependencies') && onAddDependency && (
            <div className="mt-6">
              <DependenciesSection
                taskId={task.id}
                dependencyTasks={dependencyTasks}
                blockingTasks={blockingTasks}
                allProjectTasks={allProjectTasks}
                onAddDependency={onAddDependency}
                onRemoveDependency={onRemoveDependency}
                onNavigateToTask={onNavigateToTask}
              />
            </div>
          )}

          {/* Attachments */}
          {isFieldVisible('attachments') && (onAttachmentAdd || onAttachmentsChange) && (
            <div className="mt-6 group/attachments-section">
              <div className={cn("flex items-center justify-between", !attachmentsCollapsed && "mb-2")}>
                <Button variant="ghost" onClick={() => setAttachmentsCollapsed(!attachmentsCollapsed)} className="flex items-center gap-1.5">
                  <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform duration-200", !attachmentsCollapsed && "rotate-90")} />
                  <span className="text-sm font-medium text-foreground">{t('sweep.shared.attachments')}</span>
                  {attachments.length > 0 && (
                    <span className="text-[10px] font-mono text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-[5px]">
                      {attachments.length}
                    </span>
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => fileInputRef.current?.click()}
                  className="p-0.5 text-muted-foreground hover:text-foreground transition-colors opacity-0 group-hover/attachments-section:opacity-100"
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={(e) => {
                  handleFiles(e.target.files);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
                className="hidden"
                accept="*/*"
              />

              {!attachmentsCollapsed && (<>
              {/* Upload Progress */}
              {isUploading && currentFileName && (
                <div className="flex items-center gap-2 px-2 py-1.5 mb-2 text-xs text-muted-foreground">
                  <div className="flex-1 min-w-0">
                    <span className="truncate block">{currentFileName}</span>
                  </div>
                  <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden flex-shrink-0">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <span className="flex-shrink-0">{progress}%</span>
                </div>
              )}

              {/* Preview Dialog */}
              {previewAttachment && (() => {
                const type = isPreviewable(previewAttachment.fileName);
                return (
                  <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setPreviewAttachment(null)}>
                    <div className="absolute inset-0 bg-black/60" />
                    <div className="fixed top-4 right-4 z-20 flex items-center gap-2">
                      <a
                        href={previewAttachment.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 bg-black/50 hover:bg-black/70 rounded-lg text-white"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Download className="h-4.5 w-4.5" />
                      </a>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setPreviewAttachment(null)}
                        className="p-2 bg-black/50 hover:bg-black/70 rounded-lg text-white"
                      >
                        <X className="h-4.5 w-4.5" />
                      </Button>
                    </div>
                    <div className="relative z-10 max-w-[90vw] max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-center overflow-auto">
                        {type === 'image' && (
                          <img src={previewAttachment.url} alt={previewAttachment.fileName} className="max-w-[85vw] max-h-[80vh] object-contain" />
                        )}
                        {type === 'video' && (
                          <video src={previewAttachment.url} controls className="max-w-[85vw] max-h-[80vh]" />
                        )}
                        {type === 'pdf' && (
                          <iframe src={previewAttachment.url} className="w-[85vw] h-[80vh] border-0" />
                        )}
                        {!type && (
                          <div className="py-12 px-8 text-center text-sm text-muted-foreground">
                            {t('sweep.shared.previewNotAvailable')}
                            <br />
                            <a href={previewAttachment.url} target="_blank" rel="noopener noreferrer" className="text-primary underline mt-2 inline-block">
                              {t('sweep.shared.openFile')}
                            </a>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {attachments.length === 0 && !isUploading && (
                <p className="text-sm text-muted-foreground mt-0.5">{t('sweep.shared.noAttachmentsYet')}</p>
              )}

              {attachments.length > 0 && (
                <div className="space-y-1">
                  {attachments.map((attachment) => {
                    const Icon = getFileIcon(attachment.fileName);
                    return (
                      <div
                        key={attachment.id}
                        onClick={() => setPreviewAttachment(attachment)}
                        className="flex items-center gap-2 pl-2 py-1.5 rounded-md hover:bg-muted/50 group cursor-pointer"
                      >
                        <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
                          <Icon className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm truncate text-foreground">{attachment.fileName}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatFileSize(attachment.fileSize)}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0 mr-2.5">
                          <a
                            href={attachment.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="p-1.5 hover:bg-muted rounded-md opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                            title={t('sweep.shared.download')}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </a>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={(e) => { e.stopPropagation(); handleRemoveAttachment(attachment.id); }}
                            className="p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30"
                            title={t('sweep.shared.remove')}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              </>)}
            </div>
          )}

        </div>
      )}

      {/* History Tab */}
      {activeTab === 'history' && taskId && (
        <div className="-mx-4">
          <EntityAuditPanel
            entityType={projectId ? 'project_task' : 'personal_task'}
            entityId={taskId}
          />
        </div>
      )}

      </div>
    </div>
  );
}

function SubtasksSection({
  subtasks,
  parentTask,
  currentTaskId,
  rootTask,
  onCreateSubtask,
  onToggleSubtask,
  onNavigateToTask,
}: {
  subtasks: SubtaskItem[];
  parentTask?: { id: string; title: string; status?: string } | null;
  /** The task currently shown in the panel — if it matches a subtask row,
   *  that row stays highlighted so the user can see which item they're on. */
  currentTaskId?: string;
  /** The task whose children populate `subtasks` — rendered as the root of
   *  the tree above the list so the first-level children visually thread
   *  back to their ACTUAL parent instead of to the `parentTask` breadcrumb
   *  (which is the grandparent of those children). */
  rootTask?: { id: string; title: string; status?: string };
  onCreateSubtask: () => void;
  onToggleSubtask?: (subtaskId: string, currentStatus: string) => void;
  onNavigateToTask?: (taskId: string) => void;
}) {
  const t = useTranslations();
  const [collapsed, setCollapsed] = useState(false);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const completedCount = subtasks.filter(s => s.status === 'done').length;
  const totalCount = subtasks.length;

  // When the selected task has a parent, we surface the parent as the tree
  // root AND prepend the selected task into the list at depth 0 (shifting
  // the originally-loaded descendants down by one level). Effect: the panel
  // reads as "parent → selected → selected's children". Top-level tasks
  // (no parent) keep the previous shape: selected as root, children below.
  const effectiveRoot = parentTask ?? rootTask;
  const effectiveSubtasks: SubtaskItem[] = parentTask && rootTask
    ? [
        { id: rootTask.id, title: rootTask.title, status: rootTask.status || 'todo', assignee: null, depth: 0 },
        ...subtasks.map((s) => ({ ...s, depth: (s.depth ?? 0) + 1 })),
      ]
    : subtasks;

  return (
    <div style={{ overflow: 'hidden', maxWidth: '100%' }} className="group/subtasks-section">
      <div className={cn("flex items-center justify-between", !collapsed && "mb-2")}>
        <Button variant="ghost" onClick={() => setCollapsed(!collapsed)} className="flex items-center gap-1.5">
          <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform duration-200", !collapsed && "rotate-90")} />
          <span className="text-sm font-medium text-foreground">{t('sweep.shared.subtasks')}</span>
          {totalCount > 0 && (
            <span className="text-[10px] font-mono text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-[5px]">
              {completedCount}/{totalCount}
            </span>
          )}
        </Button>
        {subtasks.length > 0 && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onCreateSubtask}
            className="inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors opacity-0 group-hover/subtasks-section:opacity-100"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {!collapsed && (<>
      {/* Root row — the task whose children fill the list. Shown only when
          there ARE subtasks, so deep-level children's col-0 elbows visually
          thread back to THIS row (their real parent) instead of to the
          `parentTask` breadcrumb above it (which is the grandparent). The
          layout MIRRORS the subtask-row layout (18px connector column +
          content with marginLeft -5 and padding-left 9) so the checkbox
          lines up horizontally with every subtask checkbox and the col-0
          tree guide stays in its own column. The connector column carries
          only the BOTTOM-HALF descending trunk — there's no elbow because
          this row is the root of the tree, nothing above it to connect to. */}
      {effectiveRoot && effectiveSubtasks.length > 0 && (
        <div
          onClick={effectiveRoot.id !== currentTaskId ? () => onNavigateToTask?.(effectiveRoot.id) : undefined}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 4px', position: 'relative' }}
          className={cn('group/root-task rounded-md', effectiveRoot.id !== currentTaskId && 'cursor-pointer')}
        >
          <div onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={effectiveRoot.status === 'done'}
              onCheckedChange={() => onToggleSubtask?.(effectiveRoot.id, effectiveRoot.status || 'todo')}
              style={{ width: 14, height: 14, flexShrink: 0 }}
              className="group-hover/root-task:border-muted-foreground/70"
            />
          </div>
          <span
            style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', fontSize: 14, fontWeight: 500 }}
            className={cn(
              effectiveRoot.status === 'done' ? 'line-through text-muted-foreground' : 'text-foreground',
            )}
          >
            {effectiveRoot.title}
          </span>
          {effectiveRoot.id !== currentTaskId && (
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => { e.stopPropagation(); onNavigateToTask?.(effectiveRoot.id); }}
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)' }}
              className="text-muted-foreground opacity-0 group-hover/root-task:opacity-100 transition-opacity hover:text-foreground"
            >
              <ChevronRight style={{ width: 14, height: 14 }} />
            </Button>
          )}
        </div>
      )}

      {/* Subtask list - tree view. Flat list is actually a DFS traversal of
          the full subtree; each row carries `depth` so we draw the nesting
          explicitly with connector columns (not just padding) so the tree
          READS as hierarchical — each subtask visually threads back to its
          parent subtask through a continuous vertical guide line.
          Per row we need:
          - `nextSiblingAt[i]`: index of the next sibling at the same depth
            within the same parent (skip descendants). -1 if it's the last
            sibling in its group. Controls whether row i's OWN column draws
            the lower half of the vertical line (the bit heading down to
            the next sibling's elbow).
          - `ancestorContinuations[i][c]`: whether the column at depth c
            should draw a full-height vertical line through row i. True iff
            row i's ancestor at depth c is NOT the last sibling in its own
            group — meaning the tree at depth c still has unfinished
            business below, and the guide line must continue past row i. */}
      {effectiveSubtasks.length > 0 && (() => {
            const nextSiblingAt: number[] = new Array(effectiveSubtasks.length).fill(-1);
            for (let i = 0; i < effectiveSubtasks.length; i++) {
              const d = effectiveSubtasks[i].depth ?? 0;
              for (let j = i + 1; j < effectiveSubtasks.length; j++) {
                const dj = effectiveSubtasks[j].depth ?? 0;
                if (dj === d) { nextSiblingAt[i] = j; break; }
                if (dj < d) break;
              }
            }
            // Ancestor lookup: in DFS order, row i's ancestor at depth c is
            // simply the most recent preceding row whose depth equals c —
            // any rows between them are strictly deeper (descendants of that
            // ancestor's subtree that contain row i). A later sibling of the
            // ancestor would only appear AFTER the ancestor's entire subtree
            // closes, i.e. after row i.
            const ancestorContinuations: boolean[][] = new Array(effectiveSubtasks.length);
            for (let i = 0; i < effectiveSubtasks.length; i++) {
              const d = effectiveSubtasks[i].depth ?? 0;
              const arr: boolean[] = new Array(d).fill(false);
              for (let c = 0; c < d; c++) {
                let j = i - 1;
                while (j >= 0 && (effectiveSubtasks[j].depth ?? 0) !== c) j--;
                arr[c] = j >= 0 && nextSiblingAt[j] !== -1;
              }
              ancestorContinuations[i] = arr;
            }
            // A row "has a direct child below" when the next row in the flat
            // list sits one level deeper (DFS always emits a parent's first
            // child immediately after the parent). That means we need a
            // descending trunk at col d+1 from this row's middle down to its
            // bottom, so the child's upper vertical at col d+1 visually
            // threads back to THIS row — not to some distant ancestor.
            const hasChildBelow: boolean[] = effectiveSubtasks.map((s, i) => {
              const d = s.depth ?? 0;
              const next = effectiveSubtasks[i + 1];
              return !!next && (next.depth ?? 0) === d + 1;
            });
            return (
            <div style={{ overflow: 'hidden', maxWidth: '100%' }}>
              {effectiveSubtasks.map((subtask, index) => {
                const depth = subtask.depth ?? 0;
                const nextSiblingIndex = nextSiblingAt[index];
                const isLast = nextSiblingIndex === -1;
                const isActive = subtask.id === currentTaskId;
                const nextIsActive = nextSiblingIndex !== -1 && effectiveSubtasks[nextSiblingIndex].id === currentTaskId;
                const isHovered = hoveredIndex === index;
                const nextIsHovered = nextSiblingIndex !== -1 && hoveredIndex === nextSiblingIndex;
                const continuations = ancestorContinuations[index];
                const descendToChild = hasChildBelow[index];
                // Upper vertical + curve lead INTO this row's checkbox, so
                // they darken when this row is active OR hovered. The lower
                // vertical on this row leads DOWN to the NEXT row's checkbox,
                // so it darkens when the next row is active OR hovered.
                const upperDark = isActive || isHovered;
                const lowerDark = nextIsActive || nextIsHovered;
                const DARK = 'color-mix(in srgb, var(--color-border), var(--color-foreground) 20%)';
                const DEFAULT = 'var(--color-border)';
                return (
                  <div
                    key={subtask.id}
                    onMouseEnter={() => setHoveredIndex(index)}
                    onMouseLeave={() => setHoveredIndex(null)}
                    className="flex overflow-hidden max-w-full relative"
                  >
                    {/* Descending trunk — parent→first-child connector. Sits
                        at col d+1 (which lands inside the content area in
                        the flex layout, so it has to be absolutely
                        positioned rather than laid out as a column). Runs
                        from this row's middle down to its bottom where the
                        child row below picks it up with its own upper
                        vertical. */}
                    {descendToChild && (
                      <div
                        style={{
                          position: 'absolute',
                          left: (depth + 1) * 18 + 6,
                          top: 'calc(50% + 2px)',
                          bottom: 0,
                          width: 1,
                          backgroundColor: DEFAULT,
                          zIndex: 0,
                          pointerEvents: 'none',
                        }}
                      />
                    )}
                    {/* Ancestor guide columns — one per depth level above
                        this row. Each draws a continuous vertical line only
                        if its ancestor has more siblings below, so the tree
                        trunk "threads through" descendants back to its later
                        siblings. */}
                    {continuations.map((show, c) => (
                      <div key={c} style={{ width: 18, flexShrink: 0, position: 'relative' }}>
                        {show && (
                          <div
                            style={{ position: 'absolute', left: 6, top: 0, bottom: 0, width: 1, backgroundColor: DEFAULT }}
                          />
                        )}
                      </div>
                    ))}
                    {/* Tree connector with rounded corner */}
                    <div style={{ width: 18, flexShrink: 0, position: 'relative' }}>
                      {/* Vertical line above the curve */}
                      <div
                        style={{ position: 'absolute', left: 6, top: 0, height: 'calc(50% - 5px)', width: 1, backgroundColor: upperDark ? DARK : DEFAULT }}
                      />
                      {/* Rounded corner */}
                      <div
                        style={{
                          position: 'absolute',
                          left: 6,
                          top: 'calc(50% - 6px)',
                          width: 8,
                          height: 8,
                          borderLeft: `1px solid ${upperDark ? DARK : DEFAULT}`,
                          borderBottom: `1px solid ${upperDark ? DARK : DEFAULT}`,
                          borderRadius: '0 0 0 6px',
                        }}
                      />
                      {/* Vertical line below the curve — darkens when the
                          next sibling is active OR hovered, so the line that
                          leads down into the next row's curve follows along. */}
                      {!isLast && (
                        <div
                          style={{ position: 'absolute', left: 6, top: 'calc(50% + 2px)', bottom: 0, width: 1, backgroundColor: lowerDark ? DARK : DEFAULT }}
                        />
                      )}
                    </div>
                    {/* Subtask row — no hover bg, darkening comes from the
                        connector lines and checkbox border instead. */}
                    <div
                      onClick={() => onNavigateToTask?.(subtask.id)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 4px 5px 9px', marginLeft: -5, overflow: 'hidden', flex: 1, minWidth: 0, cursor: 'pointer' }}
                      className="group/subtask rounded-md relative"
                    >
                      <div onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={subtask.status === 'done'}
                          onCheckedChange={() => onToggleSubtask?.(subtask.id, subtask.status)}
                          style={{ width: 14, height: 14, flexShrink: 0 }}
                          className={cn(isActive ? 'border-muted-foreground/70' : isHovered && 'border-muted-foreground/70')}
                        />
                      </div>
                      <span
                        style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', fontSize: 14 }}
                        className={cn(
                          subtask.status === 'done' ? "line-through text-muted-foreground" : "text-foreground"
                        )}
                      >
                        {subtask.title}
                      </span>
                      {subtask.assignee && (
                        <div style={{ width: 20, height: 20, borderRadius: 9999, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} className="bg-muted" title={subtask.assignee.name}>
                          <span style={{ fontSize: 9, fontWeight: 500 }} className="text-muted-foreground">
                            {subtask.assignee.name.charAt(0).toUpperCase()}
                          </span>
                        </div>
                      )}
                      {subtask.id !== currentTaskId && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onNavigateToTask?.(subtask.id)}
                          style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)' }}
                          className="text-muted-foreground opacity-0 group-hover/subtask:opacity-100 transition-opacity hover:text-foreground"
                        >
                          <ChevronRight style={{ width: 14, height: 14 }} />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            );
          })()}

      {subtasks.length === 0 && (
        <Button
          variant="ghost"
          type="button"
          onClick={onCreateSubtask}
          className="inline-flex items-center gap-1.5 py-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('sweep.shared.addSubtask')}
        </Button>
      )}
      </>)}
    </div>
  );
}

function DependenciesSection({
  taskId,
  dependencyTasks,
  blockingTasks,
  allProjectTasks,
  onAddDependency,
  onRemoveDependency,
  onNavigateToTask,
}: {
  taskId: string;
  dependencyTasks: DependencyTask[];
  blockingTasks: DependencyTask[];
  allProjectTasks: DependencyTask[];
  onAddDependency?: (targetTaskId: string, type: 'blocks' | 'blockedBy') => void;
  onRemoveDependency?: (targetTaskId: string, type: 'blocks' | 'blockedBy') => void;
  onNavigateToTask?: (taskId: string) => void;
}) {
  const st = useTranslations();
  const [collapsed, setCollapsed] = useState(dependencyTasks.length === 0 && blockingTasks.length === 0);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [depType, setDepType] = useState<'blockedBy' | 'blocks'>('blockedBy');
  const [search, setSearch] = useState('');

  const totalDeps = dependencyTasks.length + blockingTasks.length;
  const hasDeps = totalDeps > 0;

  // Exclude self and already-linked tasks
  const linkedIds = new Set([
    taskId,
    ...dependencyTasks.map(t => t.id),
    ...blockingTasks.map(t => t.id),
  ]);
  const availableTasks = allProjectTasks.filter(t => !linkedIds.has(t.id));

  const statusSquare = (status: string) => {
    const colors: Record<string, string> = {
      todo: 'bg-gray-400',
      in_progress: 'bg-blue-500',
      in_review: 'bg-yellow-500',
      testing: 'bg-purple-500',
      done: 'bg-green-500',
      cancelled: 'bg-gray-300',
    };
    return <span className={cn("inline-block w-2.5 h-2.5 rounded-[3px] flex-shrink-0", colors[status] || 'bg-gray-400')} />;
  };

  const renderDepRow = (dep: DependencyTask, type: 'blockedBy' | 'blocks', index: number, isLast: boolean) => (
    <div key={dep.id} style={{ display: 'flex', overflow: 'hidden', maxWidth: '100%' }}>
      {/* Tree connector */}
      <div style={{ width: 18, flexShrink: 0, position: 'relative' }}>
        <div style={{ position: 'absolute', left: 6, top: 0, height: 'calc(50% - 5px)', width: 1, backgroundColor: 'var(--color-border)' }} />
        <div style={{ position: 'absolute', left: 6, top: 'calc(50% - 6px)', width: 8, height: 8, borderLeft: '1px solid var(--color-border)', borderBottom: '1px solid var(--color-border)', borderRadius: '0 0 0 6px' }} />
        {!isLast && (
          <div style={{ position: 'absolute', left: 6, top: 'calc(50% + 2px)', bottom: 0, width: 1, backgroundColor: 'var(--color-border)' }} />
        )}
      </div>
      {/* Row */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 4px', overflow: 'hidden', flex: 1, minWidth: 0 }}
        className="rounded-md hover:bg-muted/50 group/dep-item relative"
      >
        {statusSquare(dep.status)}
        <Button
          variant="ghost"
          onClick={() => onNavigateToTask?.(dep.id)}
          style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', fontSize: 14 }}
          className="text-foreground hover:text-primary transition-colors"
        >
          {dep.title}
        </Button>
        {dep.key && (
          <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded flex-shrink-0">{dep.key}</span>
        )}
        {onRemoveDependency && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onRemoveDependency(dep.id, type)}
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)' }}
            className="p-0.5 rounded-md hover:bg-muted text-muted-foreground opacity-0 group-hover/dep-item:opacity-100 transition-all"
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <div className="group/deps-section">
      <div className={cn("flex items-center justify-between", !collapsed && "mb-2")}>
        <Button variant="ghost" onClick={() => setCollapsed(!collapsed)} className="flex items-center gap-1.5">
          <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform duration-200", !collapsed && "rotate-90")} />
          <span className="text-sm font-medium text-foreground">{st('sweep.shared.dependencies')}</span>
          {totalDeps > 0 && (
            <span className="text-[10px] font-mono text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-[5px]">
              {totalDeps}
            </span>
          )}
        </Button>
        {onAddDependency && (
          <Popover open={popoverOpen} onOpenChange={(open) => { setPopoverOpen(open); if (!open) setSearch(''); }}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="p-0.5 text-muted-foreground hover:text-foreground transition-colors opacity-0 group-hover/deps-section:opacity-100">
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[280px] p-0" align="end" side="bottom" sideOffset={4}>
              <div className="flex items-center border-b border-border">
                <Button
                  variant="ghost"
                  onClick={() => setDepType('blockedBy')}
                  className={cn(
                    "flex-1 text-xs font-medium py-2.5 text-center transition-colors border-b-2",
                    depType === 'blockedBy'
                      ? "text-foreground border-primary"
                      : "text-muted-foreground border-transparent hover:text-foreground"
                  )}
                >
                  {st('sweep.shared.blockedBy')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setDepType('blocks')}
                  className={cn(
                    "flex-1 text-xs font-medium py-2.5 text-center transition-colors border-b-2",
                    depType === 'blocks'
                      ? "text-foreground border-primary"
                      : "text-muted-foreground border-transparent hover:text-foreground"
                  )}
                >
                  {st('sweep.shared.blocking')}
                </Button>
              </div>
              <Command>
                <CommandInput
                  placeholder={st('sweep.shared.searchTasksPlaceholder')}
                  value={search}
                  onValueChange={setSearch}
                  className="h-9 text-sm"
                />
                <CommandList className="max-h-[200px] [scrollbar-width:thin] [scrollbar-color:rgba(156,163,175,0.3)_transparent] [&::-webkit-scrollbar]:w-[3px] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-gray-300/30 [&::-webkit-scrollbar-thumb]:rounded-full">
                  <CommandEmpty className="py-6 text-center text-sm text-muted-foreground">{st('sweep.shared.noTasksFound')}</CommandEmpty>
                  <CommandGroup>
                    {availableTasks.map((t) => (
                      <CommandItem
                        key={t.id}
                        value={`${t.title} ${t.key || ''}`}
                        onSelect={() => {
                          onAddDependency?.(t.id, depType);
                          setPopoverOpen(false);
                          setSearch('');
                        }}
                        className="flex items-center gap-2 py-2"
                      >
                        {statusSquare(t.status)}
                        <span className="truncate flex-1 text-sm">{t.title}</span>
                        {t.key && <span className="text-[10px] font-mono text-muted-foreground">{t.key}</span>}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        )}
      </div>

      {!collapsed && (<>
      {/* Blocked by */}
      {dependencyTasks.length > 0 && (
        <div className="mb-2">
          <span className="text-[11px] font-medium text-muted-foreground mb-1 block">{st('sweep.shared.blockedBy')}</span>
          <div>
            {dependencyTasks.map((dep, i) => renderDepRow(dep, 'blockedBy', i, i === dependencyTasks.length - 1))}
          </div>
        </div>
      )}

      {/* Blocking */}
      {blockingTasks.length > 0 && (
        <div className="mb-2">
          <span className="text-[11px] font-medium text-muted-foreground mb-1 block">{st('sweep.shared.blocking')}</span>
          <div>
            {blockingTasks.map((dep, i) => renderDepRow(dep, 'blocks', i, i === blockingTasks.length - 1))}
          </div>
        </div>
      )}

      {!hasDeps && (
        <p className="text-sm text-muted-foreground">{st('sweep.shared.noDependenciesYet')}</p>
      )}
      </>)}
    </div>
  );
}

function CommentContent({ content, membersMap }: { content: string; membersMap: Map<string, string> }) {
  const mentionRegex = /<@([^>]+)>/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = mentionRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(content.substring(lastIndex, match.index));
    }
    const userId = match[1];
    const name = membersMap.get(userId) ?? userId;
    parts.push(
      <span key={key++} className="comment-mention-badge">@{name}</span>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push(content.substring(lastIndex));
  }

  return <>{parts}</>;
}

export function CommentsList({
  comments,
  currentUserId,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
}: {
  comments: TaskComment[];
  currentUserId?: string;
  onAddComment: (content: string) => void;
  onUpdateComment?: (commentId: string, content: string) => void;
  onDeleteComment?: (commentId: string) => void;
}) {
  const t = useTranslations();
  const [newComment, setNewComment] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const editorRef = useRef<HTMLDivElement>(null);
  const membersMapRef = useRef(new Map<string, string>());
  const { data: membersData } = useWorkspaceMembers();

  useEffect(() => {
    const map = new Map<string, string>();
    for (const m of membersData?.data ?? []) {
      if (m.userId && m.name) map.set(m.userId, m.name);
    }
    membersMapRef.current = map;
  }, [membersData]);
  const commentsListRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when comments change
  useEffect(() => {
    if (commentsListRef.current) {
      commentsListRef.current.scrollTop = commentsListRef.current.scrollHeight;
    }
  }, [comments]);

  // Convert raw content (with <@userId> tokens) to HTML with badge spans
  const contentToHtml = useCallback((text: string): string => {
    return text.replace(/<@([^>]+)>/g, (_, uid) => {
      const name = membersMapRef.current.get(uid) ?? uid;
      return `<span class="comment-mention-badge" contenteditable="false" data-userid="${uid}">@${name}</span>`;
    });
  }, []);

  // Extract raw content from the contentEditable div innerHTML
  const htmlToContent = useCallback((html: string): string => {
    const div = document.createElement('div');
    div.innerHTML = html;
    div.querySelectorAll('.comment-mention-badge').forEach((badge) => {
      const userId = badge.getAttribute('data-userid');
      if (userId) badge.replaceWith(`<@${userId}>`);
    });
    return div.innerText;
  }, []);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const raw = editorRef.current ? htmlToContent(editorRef.current.innerHTML) : newComment;
    const trimmed = raw.trim();
    if (!trimmed) return;
    onAddComment(trimmed);
    setNewComment('');
    setMentionIds([]);
    setMentionQuery(null);
    if (editorRef.current) editorRef.current.innerHTML = '';
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape' && mentionQuery !== null) {
      setMentionQuery(null);
    }
  };

  const handleInput = useCallback(() => {
    if (!editorRef.current) return;
    const raw = htmlToContent(editorRef.current.innerHTML);
    setNewComment(raw);

    const text = editorRef.current.innerText;
    const atIndex = text.lastIndexOf('@');
    if (atIndex >= 0 && (atIndex === 0 || text[atIndex - 1] === ' ' || text[atIndex - 1] === '\n')) {
      const query = text.substring(atIndex + 1);
      if (!query.includes(' ') && !query.includes('\n')) {
        setMentionQuery(query);
        return;
      }
    }
    setMentionQuery(null);
  }, [htmlToContent]);

  const handleMentionSelect = useCallback((member: { userId: string; name: string }) => {
    if (!editorRef.current) return;
    membersMapRef.current.set(member.userId, member.name);

    const text = editorRef.current.innerText;
    const atIndex = text.lastIndexOf('@');
    if (atIndex >= 0) {
      const before = text.substring(0, atIndex);
      const newContent = `${before}<@${member.userId}> `;
      setNewComment(newContent);
      setMentionIds(prev => [...prev, member.userId]);
      editorRef.current.innerHTML = contentToHtml(newContent) + '&nbsp;';

      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editorRef.current);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    setMentionQuery(null);
  }, [contentToHtml]);

  const triggerMention = () => {
    if (!editorRef.current) return;
    editorRef.current.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const textNode = document.createTextNode('@');
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      editorRef.current.innerHTML += '@';
    }
    setMentionQuery('');
  };

  const startEditing = (comment: TaskComment) => {
    setEditingId(comment.id);
    setEditContent(comment.content);
  };

  const saveEdit = (commentId: string) => {
    const trimmed = editContent.trim();
    if (trimmed && onUpdateComment) {
      onUpdateComment(commentId, trimmed);
    }
    setEditingId(null);
    setEditContent('');
  };

  const formatRelativeTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return t('sweep.shared.justNow');
    if (diffMins < 60) return t('sweep.shared.minutesAgo', { count: diffMins });
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return t('sweep.shared.hoursAgo', { count: diffHours });
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return t('sweep.shared.daysAgo', { count: diffDays });
    return format(date, 'MMM d');
  };

  // Sort comments oldest first (top to bottom chronological order)
  const sortedComments = [...comments].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Comment list - scrollable */}
      {sortedComments.length > 0 && (
        <div ref={commentsListRef} className="flex-1 min-h-0 overflow-y-auto space-y-2 -mx-2" style={{ scrollbarWidth: 'thin', scrollbarColor: '#d1d5db transparent' }}>
          {sortedComments.map((comment) => {
            const isOwn = currentUserId === comment.authorId;
            const initials = (comment.authorName || '?').slice(0, 2).toUpperCase();

            return (
              <div key={comment.id} className="flex gap-2 px-2 py-1.5 rounded-xl hover:bg-muted/30 group">
                <div className="w-6 h-6 rounded-[9px] bg-muted flex items-center justify-center flex-shrink-0 mt-0.5">
                  {comment.authorAvatar ? (
                    <img src={comment.authorAvatar} alt={comment.authorName} className="w-6 h-6 rounded-[9px] object-cover" />
                  ) : (
                    <span className="text-[10px] font-medium text-muted-foreground">{initials}</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-foreground">{comment.authorName}</span>
                    <span className={cn("text-[10px] text-muted-foreground ml-auto transition-transform duration-200 ease-out", isOwn ? "group-hover:translate-x-[-2px]" : "translate-x-[10px]")}>{formatRelativeTime(comment.createdAt)}</span>
                    {isOwn && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="p-0.5 rounded-md hover:bg-muted text-muted-foreground opacity-0 group-hover:opacity-100 transition-all w-0 group-hover:w-auto overflow-hidden">
                            <EllipsisVertical className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-32">
                          {onUpdateComment && (
                            <DropdownMenuItem onClick={() => startEditing(comment)}>
                              <Pencil className="h-3.5 w-3.5 mr-0.5" />
                              {t('sweep.shared.edit')}
                            </DropdownMenuItem>
                          )}
                          {onDeleteComment && (
                            <>
                              {onUpdateComment && <DropdownMenuSeparator />}
                              <DropdownMenuItem
                                className="text-red-600 hover:!bg-red-50 hover:!text-red-600 focus:bg-red-50 focus:text-red-600 dark:hover:!bg-red-950 dark:hover:!text-red-400 dark:focus:bg-red-950"
                                onClick={() => onDeleteComment(comment.id)}
                              >
                                <Trash2 className="h-3.5 w-3.5 mr-0.5 text-red-500" />
                                {t('sweep.shared.delete')}
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  {editingId === comment.id ? (
                    <div className="mt-1">
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            saveEdit(comment.id);
                          }
                          if (e.key === 'Escape') {
                            setEditingId(null);
                            setEditContent('');
                          }
                        }}
                        className="w-full text-sm rounded-md px-2 py-1 border border-border bg-transparent outline-none focus:ring-1 focus:ring-primary resize-none"
                        rows={2}
                        autoFocus
                      />
                      <div className="flex items-center gap-1 mt-1">
                        <Button size="sm" variant="default" className="h-6 text-xs px-2" onClick={() => saveEdit(comment.id)}>
                          {t('sweep.shared.save')}
                        </Button>
                        <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => { setEditingId(null); setEditContent(''); }}>
                          {t('sweep.shared.cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words mt-0.5">
                      <CommentContent content={comment.content} membersMap={membersMapRef.current} />
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* New comment input */}
      <div className="flex-shrink-0">
        <style>{`
          .comment-mention-badge {
            display: inline-block;
            background: rgb(239 246 255);
            color: rgb(37 99 235);
            border-radius: 4px;
            padding: 2px 8px;
            font-weight: 500;
            font-size: 12px;
            line-height: 16px;
            height: 20px;
            vertical-align: middle;
            cursor: default;
            user-select: none;
          }
          .dark .comment-mention-badge {
            background: rgb(23 37 84);
            color: rgb(96 165 250);
          }
          .comment-editor:empty:before {
            content: attr(data-placeholder);
            color: #9ca3af;
            pointer-events: none;
          }
        `}</style>
        <div
          className="relative bg-white dark:bg-background border border-gray-200 dark:border-border rounded-[20px] p-[10px] w-full flex flex-col shadow-[0_1px_4px_-1px_rgba(0,0,0,0.03)] cursor-text overflow-visible"
          onClick={(e) => {
            const target = e.target as HTMLElement;
            if (!target.closest('button') && !target.closest('[role="dialog"]') && editorRef.current) {
              editorRef.current.focus();
            }
          }}
        >
          {mentionQuery !== null && (
            <div className="absolute bottom-full -left-px -right-px mb-3 z-50 [&>div]:static [&>div]:mb-0 [&>div]:rounded-xl">
              <MentionAutocomplete query={mentionQuery} onSelect={handleMentionSelect} onDismiss={() => setMentionQuery(null)} />
            </div>
          )}
          <div
            ref={editorRef}
            contentEditable
            data-placeholder={t('sweep.shared.writeACommentPlaceholder')}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            className="comment-editor w-full bg-transparent text-[15px] text-gray-900 dark:text-foreground placeholder:text-gray-500 dark:placeholder:text-muted-foreground outline-none resize-none min-h-[40px] flex-1 pl-[9px] pt-[7px] pb-3 max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words"
            style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(200,200,200,0.3) transparent' }}
          />
          <div className="flex items-center justify-between mt-auto">
            <div className="flex items-center gap-0">
              <Button variant="ghost" type="button" className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors" title={t('sweep.shared.addAttachment')}>
                <Plus className="h-[18px] w-[18px]" />
              </Button>
              <Popover open={emojiPickerOpen} onOpenChange={setEmojiPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    type="button"
                    className={cn(
                      "p-1.5 rounded-lg transition-colors",
                      emojiPickerOpen
                        ? "bg-gray-100 dark:bg-accent text-gray-700 dark:text-foreground"
                        : "text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent"
                    )}
                    title={t('sweep.shared.emoji')}
                  >
                    <Smile className="h-[18px] w-[18px]" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" side="top" sideOffset={8} className="w-[370px] p-0">
                  <EmojiPicker onSelect={(emoji) => {
                    if (editorRef.current) {
                      editorRef.current.focus();
                      const sel = window.getSelection();
                      if (sel && sel.rangeCount > 0) {
                        const range = sel.getRangeAt(0);
                        range.insertNode(document.createTextNode(emoji));
                        range.collapse(false);
                      } else {
                        editorRef.current.innerText += emoji;
                      }
                      setNewComment(htmlToContent(editorRef.current.innerHTML));
                    }
                    setEmojiPickerOpen(false);
                  }} />
                </PopoverContent>
              </Popover>
              <Button variant="ghost" type="button" onClick={triggerMention} className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors" title={t('sweep.shared.mentionSomeone')}>
                <AtSign className="h-[18px] w-[18px]" />
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                type="button"
                disabled={!newComment.trim()}
                onClick={() => handleSubmit()}
                className={cn(
                  'w-8 h-8 rounded-[12px] flex items-center justify-center transition-all',
                  newComment.trim()
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-gray-300 dark:bg-muted text-gray-500 dark:text-muted-foreground cursor-not-allowed'
                )}
                title={t('sweep.shared.sendComment')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor" className={cn("h-[15px] w-[15px]", newComment.trim() ? "text-primary-foreground" : "text-gray-500 dark:text-muted-foreground")}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
                </svg>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Renders description text with inline images and links.
 * Supports markdown image syntax ![alt](url) and link syntax [text](url).
 */
// Converts a stored description (which may be HTML or legacy markdown) into
// HTML suitable for a contentEditable editor. This normalizes `**bold**`,
// `*italic*`, `~~strike~~`, and `` `code` `` into their HTML equivalents so
// the editor never shows raw markdown delimiters to the user.
function descriptionToHtml(input: string): string {
  if (!input) return '';
  // If it already looks like HTML (contains tags), use it as-is.
  if (/<[a-z][^>]*>/i.test(input)) return input;
  // Otherwise treat it as markdown — convert the inline markers we support.
  // Order matters: bold (**) before italic (*) so greedy matches don't swallow pairs.
  let html = input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Preserve newlines as <br>
  html = html.replace(/\n/g, '<br>');
  return html;
}

function RichDescription({ text }: { text: string }) {
  // Descriptions may be stored as raw HTML (from the contentEditable editor)
  // or as markdown (older content). If we detect HTML tags we render them
  // directly; otherwise we fall through to the ReactMarkdown path so legacy
  // markdown descriptions keep working.
  const looksLikeHtml = /<[a-z][^>]*>/i.test(text);
  const commonWrapper =
    'text-sm text-muted-foreground whitespace-pre-wrap break-words [&_p]:m-0 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[0.85em] [&_code]:font-mono [&_strong]:font-semibold [&_strong]:text-foreground [&_em]:italic [&_a]:text-primary [&_a]:underline [&_a]:hover:text-primary/80 [&_img]:max-w-full [&_img]:rounded-md [&_img]:my-1 [&_img]:inline-block [&_mark]:bg-yellow-200 [&_mark]:dark:bg-yellow-400/30 [&_mark]:text-inherit [&_mark]:rounded [&_mark]:px-0.5';

  if (looksLikeHtml) {
    return (
      <div
        className={commonWrapper}
        dangerouslySetInnerHTML={{ __html: text }}
      />
    );
  }

  return (
    <div className={commonWrapper}>
      <ReactMarkdown
        components={{
          img: ({ src, alt }) => (
            <img
              src={src ?? undefined}
              alt={alt ?? ''}
              className="max-w-full rounded-md my-1 inline-block"
              style={{ maxHeight: 300 }}
            />
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline hover:text-primary/80"
              onClick={(e) => e.stopPropagation()}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Inline-editable description field with file upload support.
 * Click to edit, blur or Cmd+Enter to save (Enter for new line).
 * Paste or drop images/files to upload and insert inline.
 */
export function DescriptionField({
  taskId,
  description,
  onUpdate,
}: {
  taskId: string;
  description?: string;
  onUpdate: (taskId: string, data: any) => void;
}) {
  const t = useTranslations();
  const [isEditing, setIsEditing] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [activeFormats, setActiveFormats] = useState<Set<string>>(new Set());
  // Local mirror of the description so saves are optimistic — on blur we
  // commit to `localDescription` immediately; the display renders from that,
  // so nothing flashes back to the stale parent prop while the API call is in
  // flight.
  const [localDescription, setLocalDescription] = useState(description || '');
  const editorRef = useRef<HTMLDivElement>(null);
  // Keep the latest HTML in a ref so we don't have to re-render the contentEditable
  // on every keystroke (which would move the caret).
  const currentHtmlRef = useRef(description || '');

  // Sync from prop on genuine prop changes only (not on edit-mode transitions).
  const isEditingRef = useRef(isEditing);
  useEffect(() => { isEditingRef.current = isEditing; }, [isEditing]);
  useEffect(() => {
    if (isEditingRef.current) return;
    setLocalDescription(description || '');
  }, [description]);

  const { uploadFile, isUploading, progress, currentFileName } = useFileUpload({
    folder: 'projects',
    entityType: 'task',
    entityId: taskId,
    onError: (error) => toast.error(error),
  });

  // Load initial content into the contentEditable div when entering edit mode.
  // We intentionally don't re-run on `description` changes while editing, so
  // React never wipes the caret position out from under the user.
  useEffect(() => {
    if (!isEditing) {
      currentHtmlRef.current = localDescription || '';
      return;
    }
    const el = editorRef.current;
    if (!el) return;
    el.innerHTML = descriptionToHtml(localDescription || '');
    currentHtmlRef.current = el.innerHTML;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  // Apply a formatting command to the current selection. Mirrors the pattern
  // used by weldchat's message-input — straight `document.execCommand` for
  // WYSIWYG (bold text appears bold as you type, no `**` markers).
  const applyFormat = useCallback((
    kind: 'bold' | 'italic' | 'strike' | 'code' | 'highlight' | 'ul' | 'ol',
  ) => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();

    // `code` and `highlight` wrap selections in a specific tag (code / mark)
    // and toggle off when the caret is already inside one. execCommand has no
    // portable way to do this so we handle it manually.
    if (kind === 'code' || kind === 'highlight') {
      const tagName = kind === 'code' ? 'code' : 'mark';
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const anchorNode = sel.anchorNode;
      const wrapperEl = anchorNode instanceof HTMLElement
        ? anchorNode.closest(tagName)
        : anchorNode?.parentElement?.closest(tagName);
      if (wrapperEl) {
        const textNode = document.createTextNode(wrapperEl.textContent || '');
        wrapperEl.replaceWith(textNode);
        const range = document.createRange();
        range.setStartAfter(textNode);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else if (!sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        const fragment = range.extractContents();
        const wrapper = document.createElement(tagName);
        if (tagName === 'code') {
          wrapper.className = 'bg-muted text-[0.85em] px-1 py-0.5 rounded font-mono';
        } else {
          wrapper.className = 'bg-yellow-200 dark:bg-yellow-400/30 text-inherit rounded px-0.5';
        }
        wrapper.appendChild(fragment);
        range.insertNode(wrapper);
        range.setStartAfter(wrapper);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else {
      const command: Record<typeof kind, string> = {
        bold: 'bold',
        italic: 'italic',
        strike: 'strikeThrough',
        ul: 'insertUnorderedList',
        ol: 'insertOrderedList',
      };
      document.execCommand(command[kind], false);
    }

    currentHtmlRef.current = el.innerHTML;
    // After an execCommand the selection state may flip — refresh the toolbar
    // highlights immediately so the pressed button reflects reality.
    updateActiveFormats();
  }, []);

  // Recompute which formats apply to the current selection. Runs on
  // selectionchange, input, and after format commands.
  const updateActiveFormats = useCallback(() => {
    if (!editorRef.current) return;
    if (!editorRef.current.contains(document.activeElement)) return;
    const next = new Set<string>();
    if (document.queryCommandState('bold')) next.add('bold');
    if (document.queryCommandState('italic')) next.add('italic');
    if (document.queryCommandState('strikeThrough')) next.add('strike');
    // <code> / <mark> aren't execCommands — detect by ancestor walk.
    const sel = window.getSelection();
    const anchor = sel?.anchorNode;
    const codeEl = anchor instanceof HTMLElement
      ? anchor.closest('code')
      : anchor?.parentElement?.closest('code');
    if (codeEl && editorRef.current.contains(codeEl)) next.add('code');
    const markEl = anchor instanceof HTMLElement
      ? anchor.closest('mark')
      : anchor?.parentElement?.closest('mark');
    if (markEl && editorRef.current.contains(markEl)) next.add('highlight');
    if (document.queryCommandState('insertUnorderedList')) next.add('ul');
    if (document.queryCommandState('insertOrderedList')) next.add('ol');
    setActiveFormats(next);
  }, []);

  useEffect(() => {
    if (!isEditing) return;
    document.addEventListener('selectionchange', updateActiveFormats);
    return () => document.removeEventListener('selectionchange', updateActiveFormats);
  }, [isEditing, updateActiveFormats]);

  // Insert uploaded files inline. Images are rendered as <img>, other files as
  // a link. Runs against the contentEditable editor — uses execCommand so the
  // caret position is honoured.
  const insertAtCursor = useCallback((kind: 'image' | 'link', url: string, name: string) => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const html = kind === 'image'
      ? `<img src="${url}" alt="${name}" style="max-width:100%;max-height:300px;border-radius:6px;" />`
      : `<a href="${url}" target="_blank" rel="noopener noreferrer">${name}</a>`;
    document.execCommand('insertHTML', false, html);
    currentHtmlRef.current = el.innerHTML;
  }, []);

  const handleUploadFiles = useCallback(async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.size > 25 * 1024 * 1024) {
        toast.error(t('sweep.shared.fileSizeExceedsLimit', { name: file.name, limit: '25MB' }));
        continue;
      }
      const result = await uploadFile(file);
      if (result) {
        const isImage = result.mimeType.startsWith('image/');
        insertAtCursor(isImage ? 'image' : 'link', result.url, result.fileName);
      }
    }
  }, [uploadFile, insertAtCursor]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData?.items;
    // Image / file paste — intercept and upload
    if (items) {
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
        return;
      }
    }
    // Plain text paste — strip formatting so pasted HTML doesn't bring in
    // unwanted styles from other apps.
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    document.execCommand('insertText', false, text);
  }, [handleUploadFiles]);

  const handleSave = () => {
    const html = (editorRef.current?.innerHTML ?? currentHtmlRef.current).trim();
    // Treat "empty" contentEditable (just <br>) as no description.
    const isEmpty = html === '' || html === '<br>' || html === '<div><br></div>';
    const next = isEmpty ? '' : html;
    if (next !== (localDescription || '')) {
      setLocalDescription(next); // optimistic — display renders from this
      onUpdate(taskId, { description: next || undefined });
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Cmd/Ctrl+Enter to save, plain Enter for new line
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
    if (e.key === 'Escape') {
      setIsEditing(false);
    }
  };

  // Shared styles for the text box in BOTH display and edit modes — same
  // padding, font size, line-height, wrapping. Only min-height and contentEditable
  // flip. This is the critical invariant: anything different between the two
  // versions will cause a visible shift when the user clicks to start editing.
  const textBoxClass =
    'w-full text-sm leading-[1.5] px-2 py-1.5 bg-transparent outline-none break-words whitespace-pre-wrap [&_strong]:font-semibold [&_em]:italic [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[0.85em] [&_code]:font-mono [&_mark]:bg-yellow-200 [&_mark]:dark:bg-yellow-400/30 [&_mark]:text-inherit [&_mark]:rounded [&_mark]:px-0.5 [&_a]:text-primary [&_a]:underline [&_a]:hover:text-primary/80 [&_img]:max-w-full [&_img]:rounded-md [&_img]:my-1 [&_img]:inline-block [&_p]:m-0';

  // Compute the HTML to render in display mode. Mirrors the editor's load path
  // (`descriptionToHtml`) so the rendered output is literally identical — no
  // ReactMarkdown middle layer, no extra wrapper div, no color differences.
  const displayHtml = localDescription ? descriptionToHtml(localDescription) : '';

  // One shared outer wrapper across display + edit so the text's horizontal
  // and vertical position is identical — clicking to edit only changes the
  // border colour / reveals the toolbar, it never shifts the content.
  return (
    <div
      className={cn(
        'relative w-full rounded-md border transition-colors overflow-hidden',
        isEditing
          ? 'border-gray-200 dark:border-border focus-within:ring-1 focus-within:ring-primary focus-within:border-primary'
          : 'border-transparent hover:border-gray-200 dark:hover:border-gray-700 cursor-pointer',
        isDraggingFile && 'ring-1 ring-primary/30',
      )}
      onClick={() => {
        if (!isEditing) setIsEditing(true);
      }}
      onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setIsDraggingFile(true); } }}
      onDragLeave={(e) => { e.preventDefault(); setIsDraggingFile(false); }}
      onDrop={(e) => { e.preventDefault(); setIsDraggingFile(false); if (e.dataTransfer?.files?.length) handleUploadFiles(e.dataTransfer.files); }}
    >
      {isEditing ? (
        <>
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            onInput={(e) => {
              currentHtmlRef.current = (e.currentTarget as HTMLDivElement).innerHTML;
            }}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            data-placeholder={t('sweep.shared.addDescriptionPlaceholder')}
            className={cn(
              textBoxClass,
              'min-h-[96px] empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground',
            )}
          />
          {/* Formatting toolbar — onMouseDown + preventDefault keeps the
              editor focused so handleSave doesn't fire from a blur. */}
          <div className="flex items-center gap-0.5 px-1.5 py-1 border-t border-gray-200 dark:border-border">
            {([
              { key: 'bold', icon: Bold, label: t('sweep.shared.formatBold') },
              { key: 'italic', icon: Italic, label: t('sweep.shared.formatItalic') },
              { key: 'strike', icon: Strikethrough, label: t('sweep.shared.formatStrikethrough') },
              { key: 'highlight', icon: Highlighter, label: t('sweep.shared.formatHighlight') },
              { key: 'code', icon: Code, label: t('sweep.shared.formatCode') },
              { key: 'ul', icon: List, label: t('sweep.shared.formatBulletList') },
              { key: 'ol', icon: ListOrdered, label: t('sweep.shared.formatNumberedList') },
            ] as const).map(({ key, icon: Icon, label }) => {
              const isActive = activeFormats.has(key);
              return (
                <Button
                  variant="ghost"
                  size="icon"
                  key={key}
                  type="button"
                  title={label}
                  aria-label={label}
                  aria-pressed={isActive}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyFormat(key);
                  }}
                  className={cn(
                    'inline-flex items-center justify-center h-7 w-7 rounded transition-colors',
                    isActive
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" />
                </Button>
              );
            })}
          </div>
          {isUploading && currentFileName && (
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
              <span className="truncate">{t('sweep.shared.uploadingFile', { name: currentFileName })}</span>
              <div className="w-16 h-1 bg-muted rounded-full overflow-hidden flex-shrink-0">
                <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}
          {isDraggingFile && (
            <div className="absolute inset-0 flex items-center justify-center bg-primary/5 rounded-md pointer-events-none">
              <div className="flex items-center gap-1.5 text-xs text-primary">
                <Upload className="h-3.5 w-3.5" />
                {t('sweep.shared.dropFilesHere')}
              </div>
            </div>
          )}
        </>
      ) : (
        displayHtml ? (
          <div
            className={cn(textBoxClass, 'min-h-[32px] text-muted-foreground')}
            dangerouslySetInnerHTML={{ __html: displayHtml }}
          />
        ) : (
          <div className={cn(textBoxClass, 'min-h-[32px] text-muted-foreground')}>
            {t('sweep.shared.addDescriptionEllipsis')}
          </div>
        )
      )}
    </div>
  );
}
