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
  Pencil,
  Trash2,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { useAuth } from '@clerk/clerk-react';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
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
import { useQuery } from '@tanstack/react-query';
import { weldchatEntityApi } from '@/lib/api/domains/weldchat-entity';
import { useAppApi } from '@/lib/api/use-app-api';
import type { Task as CrmTask } from '@/hooks/use-crm-tasks';
import type { TaskRow } from '@weldsuite/app-api-client/domains/tasks';
import type { UpdateTaskInput } from '@weldsuite/app-api-client/schemas/tasks';
import type { TaskCommentRow } from '@weldsuite/core-api-client/domains/task-comments';
import {
  useAddTaskComment,
  useCreateProjectLabel,
  useCreateSubtask,
  useDeleteTask,
  useDeleteTaskComment,
  useProjectLabels,
  useProjectMembers,
  useProjectTasksForDeps,
  useTaskById,
  useTaskComments,
  useTaskSubtasks,
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
  const assigneesList = api.assigneeIds && api.assigneeIds.length > 0
    ? api.assigneeIds.map(hydrate)
    : api.assigneeId
      ? [hydrate(api.assigneeId)]
      : [];
  const primary = assigneesList[0];
  return {
    id: api.id,
    title: api.title,
    description: api.description ?? undefined,
    status: (api.status as CrmTask['status']) ?? 'todo',
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
    linkedCompany: api.projectId ? { id: api.projectId, name: '' } : null,
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

function TaskAvatar({ status, onToggle }: { status?: string; onToggle: () => void }) {
  return (
    <Checkbox
      checked={status === 'done'}
      onCheckedChange={onToggle}
      className={cn(
        'h-5 w-5 flex-shrink-0 !rounded-[6px]',
        status === 'done' && 'data-[state=checked]:!bg-green-600 data-[state=checked]:!border-green-600',
      )}
    />
  );
}

function TaskTitle({ title, isDone, onSave }: { title: string; isDone: boolean; onSave: (next: string) => void }) {
  const [isEditing, setIsEditing] = useState(false);
  const [local, setLocal] = useState(title);
  const editorRef = React.useRef<HTMLDivElement>(null);
  const isEditingRef = React.useRef(isEditing);
  useEffect(() => { isEditingRef.current = isEditing; }, [isEditing]);
  useEffect(() => {
    if (isEditingRef.current) return;
    setLocal(title);
  }, [title]);
  useEffect(() => {
    if (!isEditing) return;
    const el = editorRef.current;
    if (!el) return;
    el.textContent = local;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  const commit = () => {
    const next = (editorRef.current?.textContent ?? local).trim();
    if (next && next !== local) {
      setLocal(next);
      onSave(next);
    } else if (editorRef.current) {
      editorRef.current.textContent = local;
    }
    setIsEditing(false);
  };

  return (
    <div
      ref={editorRef}
      contentEditable={isEditing}
      suppressContentEditableWarning
      onClick={() => { if (!isEditing) setIsEditing(true); }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (!isEditing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLDivElement).blur();
        }
        if (e.key === 'Escape') {
          if (editorRef.current) editorRef.current.textContent = local;
          setIsEditing(false);
        }
      }}
      className={cn(
        'text-[15px] font-medium leading-normal text-foreground break-words min-w-0 rounded-md px-1.5 py-0.5 -mx-1.5 -my-0.5 border outline-none whitespace-pre-wrap',
        isEditing
          ? 'border-border focus:ring-1 focus:ring-primary cursor-text'
          : 'border-transparent hover:border-border transition-colors cursor-text',
        isDone && 'line-through text-muted-foreground',
      )}
    >
      {local}
    </div>
  );
}

function TaskActions({
  onEdit,
  onDuplicate,
  onDelete,
}: {
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="flex items-center gap-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="p-1.5 hover:bg-muted data-[state=open]:bg-muted rounded-md transition-colors focus:outline-none"
            aria-label={t('sweep.entities.moreActions')}
          >
            <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="h-4 w-4 mr-0.5" />
            {t('sweep.entities.editTask')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onDuplicate}>
            <Copy className="h-4 w-4 mr-0.5" />
            {t('sweep.entities.duplicate')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950"
            onClick={onDelete}
          >
            <Trash2 className="h-4 w-4 mr-0.5 text-red-600" />
            {t('sweep.entities.deleteTask')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function TaskPanel(props: ObjectPanelComponentProps) {
  const t = useTranslations();
  const { id, isOpen, onClose } = props;
  const { userId } = useAuth();
  const { open: openPanel } = useObjectPanel();
  const appApi = useAppApi();

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
  const subtasksQuery = useTaskSubtasks(id);
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

  const subtasks: SubtaskItem[] = useMemo(
    () => (subtasksQuery.data ?? []).map((s) => {
      const hydrated = s.assigneeId ? memberByUserId.get(s.assigneeId) : undefined;
      return {
        id: s.id,
        title: s.title,
        status: s.status,
        assignee: s.assigneeId
          ? { id: s.assigneeId, name: hydrated?.name ?? '', avatar: hydrated?.avatar }
          : null,
      };
    }),
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

  const parentTask = useMemo(() => {
    const pid = apiTask?.parentTaskId;
    if (!pid) return null;
    const parent = allProjectTasksForDeps.find((pt) => pt.id === pid);
    return parent ? { id: parent.id, title: parent.title, status: parent.status } : null;
  }, [apiTask?.parentTaskId, allProjectTasksForDeps]);

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
    if (data.labels !== undefined) payload.labels = data.labels;
    if (data.repeat !== undefined) payload.repeat = data.repeat || null;
    if (data.customFields !== undefined) payload.customFields = data.customFields;
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

  const handleDelete = useCallback(() => {
    deleteMutation.mutate(undefined, {
      onSuccess: () => {
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
  const handleDuplicate = useCallback(async () => {
    if (!apiTask) return;
    try {
      const res = await appApi.tasks.create({
        title: t('sweep.entities.taskCopyTitle', { title: apiTask.title }),
        description: apiTask.description ?? undefined,
        status: apiTask.status ?? 'todo',
        priority: apiTask.priority ?? undefined,
        ...(apiTask.projectId ? { projectId: apiTask.projectId } : {}),
        ...(apiTask.parentTaskId ? { parentTaskId: apiTask.parentTaskId } : {}),
        ...(apiTask.assigneeId ? { assigneeId: apiTask.assigneeId } : {}),
        ...(apiTask.dueDate ? { dueDate: apiTask.dueDate } : {}),
        ...(apiTask.startDate ? { startDate: apiTask.startDate } : {}),
        ...(apiTask.labels ? { labels: apiTask.labels } : {}),
        ...(apiTask.tags ? { tags: apiTask.tags } : {}),
      });
      if (res.data?.id) {
        toast.success(t('sweep.entities.taskDuplicated'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('sweep.entities.duplicateTaskFailed'));
    }
  }, [apiTask, appApi, t]);

  /**
   * Edit — the legacy panel handed control back to a per-page TaskDialog. The
   * new panel makes every field in-place editable, so "Edit task" no longer
   * needs to open a separate dialog. We still emit a `task-panel-edit-requested`
   * window event so any caller that wants to surface the old dialog can hook
   * in without the panel having to know about it.
   */
  const handleEdit = useCallback(() => {
    if (!apiTask) return;
    window.dispatchEvent(
      new CustomEvent('task-panel-edit-requested', { detail: { taskId: apiTask.id } }),
    );
  }, [apiTask]);

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

  const handleAddComment = useCallback(async (content: string) => {
    addCommentMutation.mutate(content, {
      onError: (err) => toast.error(err?.message || t('sweep.entities.addCommentFailed')),
    });
  }, [addCommentMutation, t]);

  const handleUpdateComment = useCallback(async (commentId: string, content: string) => {
    updateCommentMutation.mutate({ id: commentId, body: content });
  }, [updateCommentMutation]);

  const handleDeleteComment = useCallback(async (commentId: string) => {
    deleteCommentMutation.mutate(commentId);
  }, [deleteCommentMutation]);

  const handleCreateSubtask = useCallback(async () => {
    createSubtaskMutation.mutate({ title: t('sweep.entities.newSubtaskTitle'), status: 'todo' }, {
      onError: (err) => toast.error(err?.message || t('sweep.entities.createSubtaskFailed')),
    });
  }, [createSubtaskMutation, t]);

  const handleToggleSubtask = useCallback(async (subtaskId: string, currentStatus: string) => {
    toggleSubtaskMutation.mutate({ id: subtaskId, currentStatus });
  }, [toggleSubtaskMutation]);

  const handleNavigateToTask = useCallback((targetTaskId: string) => {
    openPanel({ type: 'task', id: targetTaskId, stack: true });
  }, [openPanel]);

  const handleAddDependency = useCallback(async (targetTaskId: string, type: 'blocks' | 'blockedBy') => {
    const currentDeps = apiTask?.dependsOn ?? [];
    const currentBlocks = apiTask?.blocks ?? [];
    const next = type === 'blockedBy'
      ? { dependsOn: [...new Set([...currentDeps, targetTaskId])], blocks: currentBlocks }
      : { dependsOn: currentDeps, blocks: [...new Set([...currentBlocks, targetTaskId])] };
    updateMutation.mutate(next, {
      onError: (err) => toast.error(err?.message || t('sweep.entities.addDependencyFailed')),
    });
  }, [apiTask?.dependsOn, apiTask?.blocks, updateMutation, t]);

  const handleRemoveDependency = useCallback(async (targetTaskId: string, type: 'blocks' | 'blockedBy') => {
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

  // The chat channel is created lazily on the first sent message, so
  // "channel exists" === "there is at least one message". Reads from the same
  // cached query EntityChat runs internally (same key), so it adds no extra
  // request. Used to hide the resize-handle line above the composer until a
  // conversation actually exists.
  const taskChannel = useQuery({
    queryKey: ['entity-channel', 'task', id],
    queryFn: () => weldchatEntityApi.getEntityChannel('task', id),
    enabled: !!id,
    retry: false,
  });
  const hasMessages = !!taskChannel.data;

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      avatar={<TaskAvatar status={task?.status} onToggle={handleToggle} />}
      title={
        task
          ? <TaskTitle title={task.title} isDone={task.status === 'done'} onSave={(next) => handleUpdate(task.id, { title: next })} />
          : <div className="h-4 w-32 rounded bg-muted animate-pulse" />
      }
      actions={
        <TaskActions
          onEdit={handleEdit}
          onDuplicate={handleDuplicate}
          onDelete={handleDelete}
        />
      }
      sidebar={chatSidebar}
      sidebarShowResizeHandle={hasMessages}
      sidebarDefaultSize={mode === 'panel' ? 320 : 500}
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
        <>
          <TaskDetailContent
            task={task}
            taskId={task.id}
            projectId={projectId ?? undefined}
            onUpdate={handleUpdate}
            availableAssignees={availableAssignees}
            availableCompanies={projectId ? [{ id: projectId, name: '' }] : []}
            availableLabels={availableLabels}
            onCreateLabel={handleCreateLabel}
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
            parentTask={parentTask}
            dependencyTasks={projectId ? dependencyTasks : undefined}
            blockingTasks={projectId ? blockingTasks : undefined}
            allProjectTasks={projectId ? allProjectTasksForDeps : undefined}
            onAddDependency={projectId ? handleAddDependency : undefined}
            onRemoveDependency={projectId ? handleRemoveDependency : undefined}
          />
        </>
      )}
    </EntityDetailView>
  );
}
