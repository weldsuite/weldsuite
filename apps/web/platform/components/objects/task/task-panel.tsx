/**
 * Task object panel — same shell + stacking behaviour as the customer,
 * contact, and team-member panels. Wraps the existing `TaskDetailContent`
 * body unchanged so every field the legacy `TaskDetailPanel` rendered keeps
 * rendering here.
 *
 * Self-contained: callers just push the panel onto the stack via
 *   `useObjectPanel().open('task', taskId)`
 * — this component fetches the task and its comments / subtasks / labels /
 * members / dependencies from the new app-api worker.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Copy,
  EllipsisVertical,
  Link2,
  Pencil,
  Trash2,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useTranslations } from '@weldsuite/i18n/client';
import { useAuth } from '@clerk/clerk-react';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { useEntityChannel } from '@/components/entity-chat/entity-chat';
import {
  useObjectPanel,
  useObjectPanelShell,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@/lib/utils';
import { InlineTextEditor } from '@/components/shared/inline-text-editor';
import {
  TaskDetailContent,
  type TaskComment,
  type SubtaskItem,
  type DependencyTask,
  type TaskAttachment,
  type TaskUpdateData,
} from '@/components/task-detail';
import { DescriptionField } from '@/components/task-detail/task-detail-content';
import { TaskChat } from '@/components/task-detail/task-chat';
import type { Task as CrmTask } from '@/hooks/use-crm-tasks';
import { TaskDialog } from '@/app/weldcrm/task-dialog';
import type { TaskRow } from '@weldsuite/app-api-client/domains/tasks';
import { normalizeTaskStatus, type UpdateTaskInput } from '@weldsuite/app-api-client/schemas/tasks';
import type { TaskCommentRow } from '@weldsuite/core-api-client/domains/task-comments';
import {
  useAddTaskComment,
  useCreateProjectLabel,
  useCreateSubtask,
  useDeleteTask,
  useDeleteTaskComment,
  useDuplicateTask,
  useProjectLabels,
  useProjectMembers,
  useProjectTasksForDeps,
  useTaskById,
  useTaskCompanyOptions,
  useTaskPersonOptions,
  useTaskComments,
  useTaskSubtasks,
  useTaskAncestors,
  useToggleSubtask,
  useToggleTask,
  useUpdateTask,
  useAddTaskAttachment,
  useRemoveTaskAttachment,
  useUpdateTaskComment,
  useWorkspaceMembersForTaskPanel,
} from './use-task-data';

const TASK_PANEL_WIDTH = 400;

/**
 * Flatten a subtask tree depth-first, tagging each row with its depth below
 * the open task so the panel draws it as a tree.
 */
function flattenSubtasks(
  rows: TaskRow[],
  memberLookup: Map<string, { name: string; avatar?: string }>,
  depth = 0,
  out: SubtaskItem[] = [],
): SubtaskItem[] {
  for (const s of rows) {
    const hydrated = s.assigneeId ? memberLookup.get(s.assigneeId) : undefined;
    out.push({
      id: s.id,
      title: s.title,
      status: s.status,
      assignee: s.assigneeId
        ? { id: s.assigneeId, name: hydrated?.name ?? '', avatar: hydrated?.avatar }
        : null,
      depth,
    });
    if (s.children?.length) flattenSubtasks(s.children, memberLookup, depth + 1, out);
  }
  return out;
}

/**
 * Map the app-api row → the `CrmTask` shape `TaskDetailContent` expects.
 *
 * `memberLookup` lets us hydrate every `assigneeId` with the corresponding
 * member's display name + avatar. Without it the assignee chip in the
 * picker trigger collapses to a "?" because `TaskDetailContent` falls back
 * to the first character of the assignee's name (empty string → "?").
 */
function toCrmTask(
  api: TaskRow,
  memberLookup: Map<string, { name: string; avatar?: string }>,
): CrmTask {
  const hydrate = (id: string) => {
    const m = memberLookup.get(id);
    return { id, name: m?.name ?? '', avatar: m?.avatar };
  };
  let assigneesList: ReturnType<typeof hydrate>[] = [];
  if (api.assigneeIds && api.assigneeIds.length > 0) {
    assigneesList = api.assigneeIds.map(hydrate);
  } else if (api.assigneeId) {
    assigneesList = [hydrate(api.assigneeId)];
  }
  const primary = assigneesList[0];
  return {
    id: api.id,
    number: api.number ?? null,
    title: api.title,
    description: api.description ?? undefined,
    status: (normalizeTaskStatus(api.status) as CrmTask['status']) ?? 'todo',
    priority: ((api.priority === 'urgent' || api.priority === 'critical')
      ? 'high'
      : api.priority) as CrmTask['priority'],
    assignee: primary,
    assignees: assigneesList,
    dueDate: api.dueDate ? new Date(api.dueDate) : undefined,
    createdAt: api.createdAt ? new Date(api.createdAt) : new Date(),
    labels: api.labels ?? undefined,
    repeat: api.repeat ?? undefined,
    scheduledStart: null,
    scheduledEnd: null,
    autoScheduled: null,
    // `customerId` resolved server-side to the CRM company (id, name, avatar).
    linkedCompany: api.linkedCompany
      ? {
          id: api.linkedCompany.id,
          name: api.linkedCompany.name,
          avatar: api.linkedCompany.avatar ?? undefined,
        }
      : null,
    // `personId` resolved server-side to the CRM person (id, name, avatar).
    linkedPerson: api.linkedPerson
      ? {
          id: api.linkedPerson.id,
          name: api.linkedPerson.name,
          avatar: api.linkedPerson.avatar ?? undefined,
        }
      : null,
    duration: api.duration ?? undefined,
    ...(api.customFields ? { customFields: api.customFields } : {}),
  } as CrmTask;
}

/** TaskComment in TaskDetailContent uses `content`; app-api stores `body`. */
function toUiComment(row: TaskCommentRow): TaskComment {
  return {
    id: row.id,
    content: row.body,
    authorId: row.authorId ?? '',
    authorName: '', // hydration of author name/picture is a TODO server-side
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** What the task dialog hands back when it saves an edit. */
type TaskDialogUpdate = Parameters<React.ComponentProps<typeof TaskDialog>['onUpdate']>[1];

function TaskAvatar({ status, onToggle }: Readonly<{ status?: string; onToggle: () => void }>) {
  // The header pins its items to the first line (the title can wrap), so the
  // checkbox is centred in a box as tall as the 28px header buttons.
  return (
    <span className="relative -top-px flex h-7 items-center">
      <Checkbox
        checked={status === 'done'}
        onCheckedChange={onToggle}
        className={cn(
          'size-[18px] flex-shrink-0 !rounded-[6px]',
          status === 'done' && 'data-[state=checked]:!bg-green-600 data-[state=checked]:!border-green-600',
        )}
      />
    </span>
  );
}

function TaskTitle({ title, isDone, onSave }: Readonly<{ title: string; isDone: boolean; onSave: (next: string) => void }>) {
  // 24px lines + 1px offset put the first line's centre on the same 26px line
  // as the checkbox and the header buttons.
  return (
    <div className="pt-px">
      <InlineTextEditor
        value={title}
        onSave={onSave}
        className={cn(
          'text-[15px] font-medium leading-6 text-foreground',
          isDone && 'line-through text-muted-foreground',
        )}
      />
    </div>
  );
}

function TaskActions({
  onCopyLink,
  onEdit,
  onDuplicate,
  onDelete,
}: Readonly<{
  onCopyLink: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}>) {
  const t = useTranslations();
  // "Edit task" opens the task dialog only once the menu has closed: opening a
  // dialog while the menu is still tearing down leaves the page unclickable
  // (both lock pointer events) and the menu's focus return fights the dialog's.
  const editOnCloseRef = React.useRef(false);
  return (
    <div className="flex items-center gap-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
            aria-label={t('sweep.entities.moreActions')}
          >
            <EllipsisVertical className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(e) => {
            if (!editOnCloseRef.current) return;
            editOnCloseRef.current = false;
            e.preventDefault();
            onEdit();
          }}
        >
          <DropdownMenuItem
            onClick={() => {
              editOnCloseRef.current = true;
            }}
          >
            <Pencil />
            {t('sweep.entities.editTask')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onCopyLink}>
            <Link2 />
            {t('sweep.entities.copyLink')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onDuplicate}>
            <Copy />
            {t('sweep.entities.duplicate')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 />
            {t('sweep.entities.deleteTask')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function TaskPanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = useTranslations();
  const { id, isOpen, onClose } = props;
  const { userId } = useAuth();
  const { open: openPanel } = useObjectPanel();

  // Coordinate with the legacy WeldAgent and other detail panels — when this
  // panel opens, the WeldAgent drawer dismisses; when another detail panel
  // broadcasts a global close, we dismiss too. Matches the old
  // TaskDetailPanel behaviour 1:1 so users don't notice a regression.
  useEffect(() => {
    if (isOpen) {
      window.dispatchEvent(new CustomEvent('close-weldagent'));
    }
  }, [isOpen]);
  useEffect(() => {
    const handler = () => onClose();
    window.addEventListener('close-detail-panels', handler);
    return () => window.removeEventListener('close-detail-panels', handler);
  }, [onClose]);

  const taskQuery = useTaskById(id);
  const apiTask = taskQuery.data;
  const projectId = apiTask?.projectId ?? null;

  const commentsQuery = useTaskComments(id);
  const subtasksQuery = useTaskSubtasks(id, apiTask);
  const ancestorsQuery = useTaskAncestors(apiTask?.parentTaskId);
  const labelsQuery = useProjectLabels(projectId);
  const projectTasksQuery = useProjectTasksForDeps(projectId);
  const projectMembersQuery = useProjectMembers(projectId);
  const workspaceMembersQuery = useWorkspaceMembersForTaskPanel();

  const updateMutation = useUpdateTask(id);
  const deleteMutation = useDeleteTask(id);
  const toggleMutation = useToggleTask(id, apiTask?.status);
  const addCommentMutation = useAddTaskComment(id);
  const updateCommentMutation = useUpdateTaskComment(id);
  const deleteCommentMutation = useDeleteTaskComment(id);
  const createLabelMutation = useCreateProjectLabel(projectId);
  const createSubtaskMutation = useCreateSubtask(id, projectId);
  const toggleSubtaskMutation = useToggleSubtask();

  const shell = useObjectPanelShell({
    ...props,
    width: TASK_PANEL_WIDTH,
    loading: taskQuery.isLoading && !apiTask,
  });
  const mode = shell.mode;

  // Workspace members lookup keyed by userId, used to hydrate names/avatars
  // for project-member rows (which only have userId/role from the join
  // table) AND for the task's own assignees (which we store as bare ids).
  // We also prefer the richer per-project row (it may carry a custom
  // display name) when it exists, falling back to the workspace member
  // record otherwise.
  const memberByUserId = useMemo(() => {
    const map = new Map<string, { name: string; avatar?: string }>();
    for (const m of workspaceMembersQuery.data ?? []) {
      if (!m.userId) continue;
      map.set(m.userId, { name: m.name ?? '', avatar: m.picture ?? undefined });
    }
    for (const m of projectMembersQuery.data ?? []) {
      if (!m.userId) continue;
      const fallback = map.get(m.userId);
      map.set(m.userId, {
        name: m.name ?? fallback?.name ?? '',
        avatar: m.avatar ?? m.picture ?? fallback?.avatar,
      });
    }
    return map;
  }, [workspaceMembersQuery.data, projectMembersQuery.data]);

  const task = useMemo<CrmTask | null>(() => {
    if (!apiTask) return null;
    return toCrmTask(apiTask, memberByUserId);
  }, [apiTask, memberByUserId]);

  // The CRM record link belongs to tasks outside a project (CRM My Tasks).
  // It is always shown there, and for a project task that happens to carry one.
  const showCompanyField = !!task && (!projectId || !!task.linkedCompany || !!task.linkedPerson);
  const companyOptionsQuery = useTaskCompanyOptions(showCompanyField);
  // Outside a project the field is a CRM record picker: companies and people.
  const showPeopleOptions = showCompanyField && !projectId;
  const personOptionsQuery = useTaskPersonOptions(showPeopleOptions);
  const availableCompanies = useMemo(() => {
    const options = new Map<string, { id: string; name: string; avatar?: string }>();
    if (task?.linkedCompany) {
      options.set(task.linkedCompany.id, task.linkedCompany);
    }
    for (const company of companyOptionsQuery.data ?? []) {
      const name = company.displayName || company.name;
      if (name) options.set(company.id, { id: company.id, name, avatar: company.avatarUrl ?? undefined });
    }
    return Array.from(options.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [task?.linkedCompany, companyOptionsQuery.data]);
  const availablePeople = useMemo(() => {
    if (!showPeopleOptions) return undefined;
    const options = new Map<string, { id: string; name: string; avatar?: string }>();
    if (task?.linkedPerson) {
      options.set(task.linkedPerson.id, task.linkedPerson);
    }
    for (const person of personOptionsQuery.data ?? []) {
      if (person.displayName) {
        options.set(person.id, { id: person.id, name: person.displayName, avatar: person.avatarUrl ?? undefined });
      }
    }
    return Array.from(options.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [showPeopleOptions, task?.linkedPerson, personOptionsQuery.data]);

  const availableAssignees = useMemo(() => {
    if (projectId && projectMembersQuery.data && projectMembersQuery.data.length > 0) {
      return projectMembersQuery.data.map((m) => {
        const hydrated = memberByUserId.get(m.userId);
        return {
          id: m.userId,
          name: m.name ?? hydrated?.name ?? '',
          avatar: m.avatar ?? m.picture ?? hydrated?.avatar,
        };
      });
    }
    // No projectId (global task) or no project members — fall back to the
    // full workspace member directory.
    return (workspaceMembersQuery.data ?? [])
      .filter((m) => m.userId)
      .map((m) => ({
        id: m.userId,
        name: m.name ?? '',
        avatar: m.picture ?? undefined,
      }));
  }, [projectId, projectMembersQuery.data, workspaceMembersQuery.data, memberByUserId]);

  const availableLabels = useMemo(
    () => (labelsQuery.data ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      color: l.color ?? '#6b7280',
    })),
    [labelsQuery.data],
  );

  // The whole subtree, depth-first, so the panel draws it as a tree.
  const subtasks: SubtaskItem[] = useMemo(
    () => flattenSubtasks(subtasksQuery.data ?? [], memberByUserId),
    [subtasksQuery.data, memberByUserId],
  );

  const comments: TaskComment[] = useMemo(
    () => (commentsQuery.data ?? []).map((c) => {
      const hydrated = c.authorId ? memberByUserId.get(c.authorId) : undefined;
      const ui = toUiComment(c);
      return hydrated
        ? { ...ui, authorName: hydrated.name, authorAvatar: hydrated.avatar }
        : ui;
    }),
    [commentsQuery.data, memberByUserId],
  );

  const allProjectTasksForDeps: DependencyTask[] = useMemo(
    () => (projectTasksQuery.data ?? []).map((pt) => ({
      id: pt.id,
      title: pt.title,
      status: pt.status,
    })),
    [projectTasksQuery.data],
  );

  const dependencyTasks: DependencyTask[] = useMemo(() => {
    const deps = apiTask?.dependsOn ?? [];
    if (!deps.length) return [];
    return deps
      .map((depId) => allProjectTasksForDeps.find((pt) => pt.id === depId))
      .filter((pt): pt is DependencyTask => !!pt);
  }, [apiTask?.dependsOn, allProjectTasksForDeps]);

  const blockingTasks: DependencyTask[] = useMemo(() => {
    const blocks = apiTask?.blocks ?? [];
    if (!blocks.length) return [];
    return blocks
      .map((bId) => allProjectTasksForDeps.find((pt) => pt.id === bId))
      .filter((pt): pt is DependencyTask => !!pt);
  }, [apiTask?.blocks, allProjectTasksForDeps]);

  // The chain this task hangs from, root first: shown above it in Subtasks
  // so a subtask always reads in the context of its main task.
  const ancestorTasks = useMemo(
    () => (ancestorsQuery.data ?? []).map((a) => ({ id: a.id, title: a.title, status: a.status })),
    [ancestorsQuery.data],
  );

  const attachments: TaskAttachment[] = useMemo(() => {
    // Files-backed attachments (entityType='task'); fall back to the legacy
    // customFields blob during the migration window (before Phase 4 drop).
    const fromFiles = (apiTask as { attachments?: unknown })?.attachments;
    if (Array.isArray(fromFiles)) return fromFiles as TaskAttachment[];
    const stored = (apiTask?.customFields as Record<string, unknown> | undefined)?.attachments;
    return Array.isArray(stored) ? stored as TaskAttachment[] : [];
  }, [apiTask]);

  // ─── Mutations ────────────────────────────────────────────────────────

  const handleUpdate = useCallback((_taskId: string, data: TaskUpdateData) => {
    const payload: UpdateTaskInput = {};
    if (data.title !== undefined) payload.title = data.title;
    if (data.description !== undefined) payload.description = data.description;
    if (data.status !== undefined) payload.status = data.status;
    if (data.priority !== undefined) payload.priority = data.priority;
    if (data.dueDate !== undefined) payload.dueDate = data.dueDate.toISOString();
    if (data.startDate !== undefined) payload.startDate = data.startDate.toISOString();
    if (data.duration !== undefined) payload.duration = data.duration;
    if (data.labels !== undefined) payload.labels = data.labels;
    if (data.repeat !== undefined) payload.repeat = data.repeat || null;
    if (data.customFields !== undefined) payload.customFields = data.customFields;
    // A task links to a company OR a person: setting one clears the other.
    if (data.linkedCompany !== undefined) {
      payload.customerId = data.linkedCompany?.id ?? null;
      if (data.linkedCompany) payload.personId = null;
    }
    if (data.linkedPerson !== undefined) {
      payload.personId = data.linkedPerson?.id ?? null;
      if (data.linkedPerson) payload.customerId = null;
    }
    if (data.assignees !== undefined) {
      const ids = (data.assignees ?? []).map((a) => a.id).filter(Boolean);
      payload.assigneeIds = ids;
      payload.assigneeId = ids[0] ?? null;
    } else if (data.assignee !== undefined) {
      payload.assigneeId = data.assignee?.id ?? null;
    }
    updateMutation.mutate(payload, {
      onError: (err) => toast.error(err?.message || t('sweep.entities.updateTaskFailed')),
    });
  }, [updateMutation, t]);

  const handleToggle = useCallback(() => {
    toggleMutation.mutate();
  }, [toggleMutation]);

  // Deleting is destructive and has no undo, so the menu item only opens a
  // confirmation; `handleDelete` runs once the user confirms.
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const requestDelete = useCallback(() => setConfirmDeleteOpen(true), []);

  const handleDelete = useCallback(() => {
    deleteMutation.mutate(undefined, {
      onSuccess: () => {
        setConfirmDeleteOpen(false);
        toast.success(t('sweep.entities.taskDeleted'));
        onClose();
      },
      onError: (err) => toast.error(err?.message || t('sweep.entities.deleteTaskFailed')),
    });
  }, [deleteMutation, onClose, t]);

  /**
   * Duplicate — create a sibling task with the same fields prefixed "(copy)".
   * Mirrors the legacy panel's behaviour: the original is kept open, a toast
   * confirms, list views invalidate so the copy shows up immediately.
   */
  const duplicateMutation = useDuplicateTask();
  const handleDuplicate = useCallback(async () => {
    if (!apiTask) return;
    try {
      await duplicateMutation.mutateAsync({
        title: t('sweep.entities.taskCopyTitle', { title: apiTask.title }),
        description: apiTask.description ?? undefined,
        status: apiTask.status ?? 'todo',
        priority: apiTask.priority ?? undefined,
        ...(apiTask.type ? { type: apiTask.type } : {}),
        ...(apiTask.projectId ? { projectId: apiTask.projectId } : {}),
        ...(apiTask.stageId ? { stageId: apiTask.stageId } : {}),
        ...(apiTask.parentTaskId ? { parentTaskId: apiTask.parentTaskId } : {}),
        ...(apiTask.assigneeId ? { assigneeId: apiTask.assigneeId } : {}),
        ...(apiTask.assigneeIds?.length ? { assigneeIds: apiTask.assigneeIds } : {}),
        ...(apiTask.dueDate ? { dueDate: apiTask.dueDate } : {}),
        ...(apiTask.startDate ? { startDate: apiTask.startDate } : {}),
        ...(apiTask.duration == null ? {} : { duration: apiTask.duration }),
        ...(apiTask.storyPoints == null ? {} : { storyPoints: apiTask.storyPoints }),
        ...(apiTask.estimatedHours == null ? {} : { estimatedHours: String(apiTask.estimatedHours) }),
        ...(apiTask.labels ? { labels: apiTask.labels } : {}),
        ...(apiTask.tags ? { tags: apiTask.tags } : {}),
        ...(apiTask.repeat ? { repeat: apiTask.repeat } : {}),
      });
      toast.success(t('sweep.entities.taskDuplicated'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('sweep.entities.duplicateTaskFailed'));
    }
  }, [apiTask, duplicateMutation, t]);

  /**
   * Edit — opens the same dialog used to create a task, filled in with this
   * task; saving writes the changed fields through the panel's update path.
   */
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const handleEdit = useCallback(() => setEditDialogOpen(true), []);
  const handleDialogUpdate = useCallback((taskId: string, data: TaskDialogUpdate) => {
    const update: TaskUpdateData = {
      title: data.title,
      description: data.description ?? '',
      status: data.status,
      labels: data.labels ?? [],
    };
    if (data.priority) update.priority = data.priority;
    if (data.dueDate) update.dueDate = data.dueDate;
    // The dialog echoes the estimate back on every save, and writing it
    // re-plans the task's calendar block, so only send a real change.
    if (data.duration !== undefined && data.duration !== task?.duration) update.duration = data.duration;
    // No repeat in the dialog means "doesn't repeat", which clears an existing one.
    if (data.repeat || task?.repeat) update.repeat = data.repeat ?? null;
    if (data.assigneeIds) update.assignees = data.assigneeIds.map((id) => ({ id, name: '' }));
    if (showCompanyField) {
      update.linkedCompany = data.linkedCompany ?? null;
      update.linkedPerson = data.linkedPerson ?? null;
    }
    handleUpdate(taskId, update);
    setEditDialogOpen(false);
  }, [handleUpdate, task?.duration, task?.repeat, showCompanyField]);

  /**
   * Copy link — the stable `/weldflow/task/{id}` URL, which resolves the
   * task's project and opens it in the panel.
   */
  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/weldflow/task/${id}`);
      toast.success(t('sweep.entities.linkCopied'));
    } catch {
      toast.error(t('sweep.entities.copyLinkFailed'));
    }
  }, [id, t]);

  const addAttachmentMutation = useAddTaskAttachment(id);
  const removeAttachmentMutation = useRemoveTaskAttachment(id);

  const handleAttachmentAdd = useCallback(
    async (a: TaskAttachment) => {
      try {
        await addAttachmentMutation.mutateAsync({
          fileName: a.fileName,
          fileKey: a.fileKey,
          fileSize: a.fileSize,
          mimeType: a.mimeType,
          url: a.url,
        });
      } catch {
        toast.error(t('sweep.entities.saveAttachmentFailed'));
      }
    },
    [addAttachmentMutation, t],
  );

  const handleAttachmentRemove = useCallback(
    async (attachmentId: string) => {
      try {
        await removeAttachmentMutation.mutateAsync(attachmentId);
      } catch {
        toast.error(t('sweep.entities.removeAttachmentFailed'));
      }
    },
    [removeAttachmentMutation, t],
  );

  const handleAddComment = useCallback((content: string) => {
    addCommentMutation.mutate(content, {
      onError: (err) => toast.error(err?.message || t('sweep.entities.addCommentFailed')),
    });
  }, [addCommentMutation, t]);

  const handleUpdateComment = useCallback((commentId: string, content: string) => {
    updateCommentMutation.mutate({ id: commentId, body: content });
  }, [updateCommentMutation]);

  const handleDeleteComment = useCallback((commentId: string) => {
    deleteCommentMutation.mutate(commentId);
  }, [deleteCommentMutation]);

  const handleCreateSubtask = useCallback((title: string) => {
    createSubtaskMutation.mutate({ title, status: 'todo' }, {
      onError: (err) => toast.error(err?.message || t('sweep.entities.createSubtaskFailed')),
    });
  }, [createSubtaskMutation, t]);

  const handleToggleSubtask = useCallback((subtaskId: string, currentStatus: string) => {
    toggleSubtaskMutation.mutate({ id: subtaskId, currentStatus });
  }, [toggleSubtaskMutation]);

  const handleNavigateToTask = useCallback((targetTaskId: string) => {
    openPanel({ type: 'task', id: targetTaskId, stack: true });
  }, [openPanel]);

  const handleOpenRecord = useCallback((type: 'company' | 'person', recordId: string) => {
    openPanel({ type, id: recordId, stack: true });
  }, [openPanel]);

  const handleOpenAssignee = useCallback((userId: string) => {
    openPanel({ type: 'team-member', id: userId, stack: true });
  }, [openPanel]);

  const handleAddDependency = useCallback((targetTaskId: string, type: 'blocks' | 'blockedBy') => {
    const currentDeps = apiTask?.dependsOn ?? [];
    const currentBlocks = apiTask?.blocks ?? [];
    const next = type === 'blockedBy'
      ? { dependsOn: [...new Set([...currentDeps, targetTaskId])], blocks: currentBlocks }
      : { dependsOn: currentDeps, blocks: [...new Set([...currentBlocks, targetTaskId])] };
    updateMutation.mutate(next, {
      onError: (err) => toast.error(err?.message || t('sweep.entities.addDependencyFailed')),
    });
  }, [apiTask?.dependsOn, apiTask?.blocks, updateMutation, t]);

  const handleRemoveDependency = useCallback((targetTaskId: string, type: 'blocks' | 'blockedBy') => {
    const currentDeps = apiTask?.dependsOn ?? [];
    const currentBlocks = apiTask?.blocks ?? [];
    const next = type === 'blockedBy'
      ? { dependsOn: currentDeps.filter((d) => d !== targetTaskId), blocks: currentBlocks }
      : { dependsOn: currentDeps, blocks: currentBlocks.filter((b) => b !== targetTaskId) };
    updateMutation.mutate(next);
  }, [apiTask?.dependsOn, apiTask?.blocks, updateMutation]);

  const handleCreateLabel = useCallback(async (data: { name: string; color: string }) => {
    try {
      const created = await createLabelMutation.mutateAsync(data);
      if (created?.id) return { id: created.id, name: data.name, color: data.color };
      return null;
    } catch {
      toast.error(t('sweep.entities.createLabelFailed'));
      return null;
    }
  }, [createLabelMutation, t]);

  // Mount the chat as soon as we know the task id, not after the full task
  // load — otherwise the bottom sidebar pops in late, which combined with a
  // persisted-collapsed state can leave the chat invisible on first open.
  const chatSidebar = <TaskChat taskId={id} taskTitle={task?.title} />;
  // The line above the chat only appears once the chat has had a message (its
  // channel is created by the first one); an untouched task shows no divider.
  const chatHasMessages = !!useEntityChannel('task', id).data;

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      sidebarDivider={chatHasMessages}
      avatar={<TaskAvatar status={task?.status} onToggle={handleToggle} />}
      title={
        task
          ? <TaskTitle title={task.title} isDone={task.status === 'done'} onSave={(next) => handleUpdate(task.id, { title: next })} />
          : <div className="h-4 w-32 rounded bg-muted animate-pulse" />
      }
      // `TaskTitle` is a wrapping, auto-growing editor — without this the shell's
      // single-line clamp boxes it in and the title scrolls instead of wrapping.
      titleWrap
      actions={
        <TaskActions
          onCopyLink={handleCopyLink}
          onEdit={handleEdit}
          onDuplicate={handleDuplicate}
          onDelete={requestDelete}
        />
      }
      sidebar={chatSidebar}
      sidebarDefaultSize={mode === 'panel' ? 200 : 500}
      sidebarMinSize={mode === 'panel' ? 140 : 320}
      sidebarMaxSize={mode === 'panel' ? undefined : 900}
      // Panel mode: no persistKey so the chat always opens fresh at the
      // default size. Persisting was a footgun — once any earlier build
      // wrote `:collapsed=1` into localStorage (e.g. from when this panel
      // briefly default-collapsed), the bottom chat stayed invisible
      // forever for that user. Resize+collapse are still session-local.
      //
      // Fullscreen mode keeps a persistKey because the right-side chat is
      // larger, less prone to misclicks, and users genuinely want size +
      // open-state remembered there.
      sidebarPersistKey={mode === 'fullscreen' ? 'task-panel-chat-right-v2' : undefined}
      sidebarDefaultCollapsed={false}
      sidebarDefaultOpen
      // In fullscreen mode the chat is essential context — lock it open and
      // hide the toggle. Panel mode is unaffected: the bottom chat is still
      // freely collapsible via the resize handle.
      sidebarLocked={mode === 'fullscreen'}
      subheader={
        task ? (
          <div className="px-1 md:px-2 -mt-2 pb-3">
            <DescriptionField
              taskId={task.id}
              description={task.description}
              onUpdate={handleUpdate}
            />
          </div>
        ) : null
      }
    >
      {task && (
        <TaskDetailContent
            task={task}
            taskId={task.id}
            projectId={projectId ?? undefined}
            onUpdate={handleUpdate}
            availableAssignees={availableAssignees}
            availableCompanies={availableCompanies}
            availablePeople={availablePeople}
            onOpenRecord={handleOpenRecord}
            onOpenAssignee={handleOpenAssignee}
            alwaysShowFields={showCompanyField ? ['company'] : undefined}
            availableLabels={availableLabels}
            onCreateLabel={handleCreateLabel}
            onDurationChange={(minutes) => handleUpdate(task.id, { duration: minutes })}
            attachments={attachments}
            onAttachmentAdd={handleAttachmentAdd}
            onAttachmentRemove={handleAttachmentRemove}
            comments={comments}
            onAddComment={handleAddComment}
            onUpdateComment={handleUpdateComment}
            onDeleteComment={handleDeleteComment}
            currentUserId={userId || undefined}
            subtasks={subtasks}
            onCreateSubtask={projectId ? handleCreateSubtask : undefined}
            onToggleSubtask={handleToggleSubtask}
            onNavigateToTask={handleNavigateToTask}
            ancestorTasks={ancestorTasks}
            dependencyTasks={projectId ? dependencyTasks : undefined}
            blockingTasks={projectId ? blockingTasks : undefined}
            allProjectTasks={projectId ? allProjectTasksForDeps : undefined}
            onAddDependency={projectId ? handleAddDependency : undefined}
            onRemoveDependency={projectId ? handleRemoveDependency : undefined}
          />
      )}
      {task && (
        <TaskDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          editingTask={task}
          availableAssignees={availableAssignees}
          availableCompanies={availableCompanies}
          availablePeople={availablePeople}
          hideRecord={!showCompanyField}
          availableLabels={availableLabels}
          onCreateLabel={handleCreateLabel}
          projectId={projectId ?? undefined}
          onSave={() => {}}
          onUpdate={handleDialogUpdate}
          isPending={updateMutation.isPending}
        />
      )}
      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title={t('sweep.entities.deleteTask')}
        description={t('sweep.entities.deleteTaskConfirmDescription')}
        confirmLabel={t('sweep.entities.deleteTask')}
        cancelLabel={t('common.actions.cancel')}
        variant="destructive"
        loading={deleteMutation.isPending}
        onConfirm={handleDelete}
      />
    </EntityDetailView>
  );
}
