
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import {
  X,
  Trash2,
  Copy,
  Pencil,
  EllipsisVertical,
  ChevronLeft,
  FolderInput,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { toast } from 'sonner';
import { useFeatureFlag } from '@/hooks/queries/use-feature-flags-queries';
import {
  useAddTaskAttachment,
  useRemoveTaskAttachment,
} from '@/components/objects/task/use-task-data';
import { MoveTaskDialog } from '@/components/weldflow/move-task-dialog';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@/lib/utils';
import type { Task } from '@/hooks/use-crm-tasks';
import { TaskNumberBadge } from '@/components/weldflow/task-number-badge';
import { TaskDetailContent, DescriptionField, CommentsList, type TaskAttachment, type TaskComment, type SubtaskItem, type DependencyTask } from './task-detail-content';
import { TaskChat } from './task-chat';

export interface TaskDetailPanelProps {
  task: Task;
  isOpen: boolean;
  onClose: () => void;
  onUpdate: (taskId: string, data: any) => void;
  onDelete: (taskId: string) => void;
  onToggle: (taskId: string) => void;
  onDuplicate: (task: Task) => void;
  onEdit: (task: Task) => void;
  availableAssignees: string[] | { id: string; name: string }[];
  availableCompanies: { id: string; name: string; avatar?: string }[];
  availableLabels?: { id: string; name: string; color: string }[];
  onCreateLabel?: (data: { name: string; color: string }) => Promise<{ id: string; name: string; color: string } | null>;
  projectId?: string;
  width?: string;
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
  // Field ids whose sections should always be hidden (e.g. 'labels', 'repeat', 'subtasks').
  // Overrides the user's per-drawer visibility settings.
  hiddenFields?: string[];
  // Hide the title-row completion checkbox (useful when this panel is reused for entities
  // without a done/not-done state).
  hideCompletionCheckbox?: boolean;
  // When provided, renders a back chevron at the top of the header. Used when this panel
  // is opened from inside another panel (e.g. the minimized customer detail's Tasks tab)
  // so the user can return to the parent panel instead of just closing.
  onBack?: () => void;
}

function EditableTitle({
  title,
  isDone,
  onSave,
}: {
  title: string;
  isDone: boolean;
  onSave: (newTitle: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  // Local mirror of the title so saves are optimistic — on blur we commit the
  // new value to `localTitle` immediately, the render uses it for the div's
  // children, and nothing flashes back to the stale parent prop while the API
  // update is in flight.
  const [localTitle, setLocalTitle] = useState(title);
  const editorRef = useRef<HTMLDivElement>(null);

  // Keep the latest `isEditing` in a ref so the `title` sync effect below
  // never fires on edit-mode transitions — it should only react to genuine
  // changes in the `title` prop.
  const isEditingRef = useRef(isEditing);
  useEffect(() => { isEditingRef.current = isEditing; }, [isEditing]);

  // Pull in server-side changes when the prop updates (e.g. other user edits,
  // or the API response rewrites the value). Skips the sync while the user is
  // actively editing or just committed an optimistic save that the parent has
  // yet to propagate.
  useEffect(() => {
    if (isEditingRef.current) return;
    setLocalTitle(title);
  }, [title]);

  // Seed editor content with the current local value when entering edit mode
  // and move the caret to the end.
  useEffect(() => {
    if (!isEditing) return;
    const el = editorRef.current;
    if (!el) return;
    el.textContent = localTitle;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  const handleSave = () => {
    const next = (editorRef.current?.textContent ?? localTitle).trim();
    if (next && next !== localTitle) {
      setLocalTitle(next); // optimistic — render uses localTitle below
      onSave(next);
    } else if (editorRef.current) {
      // No change — restore DOM text to the current local value.
      editorRef.current.textContent = localTitle;
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLDivElement).blur();
    }
    if (e.key === 'Escape') {
      if (editorRef.current) editorRef.current.textContent = localTitle;
      setIsEditing(false);
    }
  };

  return (
    <div
      ref={editorRef}
      contentEditable={isEditing}
      suppressContentEditableWarning
      onClick={() => { if (!isEditing) setIsEditing(true); }}
      onBlur={handleSave}
      onKeyDown={isEditing ? handleKeyDown : undefined}
      className={cn(
        'translate-y-[0.5px] text-[15px] font-medium leading-normal text-foreground break-words min-w-0 rounded-md px-1.5 py-0.5 -mx-1.5 -my-0.5 border outline-none whitespace-pre-wrap',
        isEditing
          ? 'border-border focus:ring-1 focus:ring-primary cursor-text'
          : 'border-transparent hover:border-border transition-colors cursor-text',
        isDone && 'line-through text-muted-foreground',
      )}
    >
      {localTitle}
    </div>
  );
}

export function TaskDetailPanel({
  task,
  isOpen,
  onClose,
  onUpdate,
  onDelete,
  onToggle,
  onDuplicate,
  onEdit,
  availableAssignees,
  availableCompanies,
  availableLabels = [],
  onCreateLabel,
  projectId,
  width = '480px',
  comments,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  currentUserId,
  subtasks,
  onCreateSubtask,
  onToggleSubtask,
  onNavigateToTask,
  parentTask,
  dependencyTasks,
  blockingTasks,
  allProjectTasks,
  onAddDependency,
  onRemoveDependency,
  hiddenFields,
  hideCompletionCheckbox,
  onBack,
}: TaskDetailPanelProps) {
  const widthNum = parseInt(width, 10) || 480;

  const { t } = useI18n();
  const st = useTranslations();
  // WeldFlow "Move to project" — gated behind the weldflow-move-task flag.
  const showMoveTask = useFeatureFlag('weldflow-move-task');
  const [showMoveDialog, setShowMoveDialog] = useState(false);

  // Comments section resizable height
  const maxCommentsHeight = 350;
  const [manualHeight, setManualHeight] = useState<number | null>(null);
  const isDraggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);

  const commentsContainerRef = useRef<HTMLDivElement>(null);

  const handleResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    startYRef.current = e.clientY;
    startHeightRef.current = commentsContainerRef.current?.offsetHeight ?? maxCommentsHeight;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const panelElRef = useRef<HTMLDivElement>(null);

  const handleResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    const delta = startYRef.current - e.clientY;
    // Allow dragging up to panel height minus ~80px for header + description
    const panelHeight = panelElRef.current?.offsetHeight ?? 800;
    const maxHeight = panelHeight - 80;
    const newHeight = Math.max(120, Math.min(startHeightRef.current + delta, maxHeight));
    setManualHeight(newHeight);
  }, []);

  const handleResizePointerUp = useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  // Attachments state — loaded from task's customFields
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);

  // Seed attachments from the files-backed `attachments` field, falling back to
  // the legacy customFields blob during the migration window (before Phase 4).
  useEffect(() => {
    const fromFiles = (task as { attachments?: unknown }).attachments;
    if (Array.isArray(fromFiles)) {
      setAttachments(fromFiles as TaskAttachment[]);
      return;
    }
    const stored = (task as any).customFields?.attachments;
    setAttachments(Array.isArray(stored) ? stored : []);
  }, [task]);

  const addAttachmentMutation = useAddTaskAttachment(task.id);
  const removeAttachmentMutation = useRemoveTaskAttachment(task.id);

  // Attachments are real `files` rows (entityType='task'), not customFields.
  // Update local state optimistically for instant UI, then persist. On success
  // reconcile the optimistic entry's temp id (from upload-confirm) with the real
  // files-row id, so a remove during the round trip never targets a stale id.
  const handleAttachmentAdd = useCallback(
    async (a: TaskAttachment) => {
      setAttachments((prev) => [...prev, a]);
      try {
        const created = await addAttachmentMutation.mutateAsync({
          fileName: a.fileName,
          fileKey: a.fileKey,
          fileSize: a.fileSize,
          mimeType: a.mimeType,
          url: a.url,
        });
        if (created) {
          setAttachments((prev) => prev.map((x) => (x.id === a.id ? (created as TaskAttachment) : x)));
        }
      } catch {
        setAttachments((prev) => prev.filter((x) => x.id !== a.id)); // roll back
        toast.error(st('sweep.shared.failedToSaveAttachment'));
      }
    },
    [addAttachmentMutation],
  );

  const handleAttachmentRemove = useCallback(
    async (attachmentId: string) => {
      let removed: TaskAttachment | undefined;
      setAttachments((prev) => {
        removed = prev.find((a) => a.id === attachmentId);
        return prev.filter((a) => a.id !== attachmentId);
      });
      try {
        await removeAttachmentMutation.mutateAsync(attachmentId);
      } catch {
        if (removed) setAttachments((prev) => [...prev, removed as TaskAttachment]); // roll back
        toast.error(st('sweep.shared.failedToRemoveAttachment'));
      }
    },
    [removeAttachmentMutation],
  );

  // Close WeldAgent when this panel opens
  useEffect(() => {
    if (isOpen) {
      window.dispatchEvent(new CustomEvent('close-weldagent'));
    }
  }, [isOpen]);

  // Notify layout of panel open/close so content width adjusts.
  // Uses useLayoutEffect so the width change commits before paint.
  // When `onBack` is provided this panel is stacked on top of a parent panel
  // (e.g. opened from the customer detail panel's Tasks tab). In that case
  // dispatch `stacked-detail-panel` instead so the parent panel can shrink to
  // make room — using `task-detail-panel` would double-reserve at the page
  // layout level and shift the underlying page sideways.
  useLayoutEffect(() => {
    const eventName = onBack ? 'stacked-detail-panel' : 'task-detail-panel';
    window.dispatchEvent(new CustomEvent(eventName, {
      detail: { isOpen, width: widthNum },
    }));
    return () => {
      window.dispatchEvent(new CustomEvent(eventName, {
        detail: { isOpen: false, width: 0 },
      }));
    };
  }, [isOpen, widthNum, onBack]);

  // Close this panel when WeldAgent opens
  useEffect(() => {
    const handler = () => onClose();
    window.addEventListener('close-detail-panels', handler);
    return () => window.removeEventListener('close-detail-panels', handler);
  }, [onClose]);

  return (
    <div
      ref={panelElRef}
      className={cn(
        "fixed bg-background z-50 flex flex-col border-l border-border overflow-x-hidden",
        "inset-0",
        "md:inset-auto md:right-0 md:top-[60px] md:bottom-0",
        "transition-transform duration-300 ease-[cubic-bezier(0.25,0.1,0.25,1)]",
        isOpen ? "translate-x-0" : "translate-x-full",
        !isOpen && "pointer-events-none",
      )}
      style={{ width }}
    >
      {/* Header */}
      <div className="group/header relative px-3 md:px-4 py-3 flex-shrink-0">
        {/* Back chevron — only when opened from a parent panel */}
        {onBack && (
          <div className="mb-2">
            <Button
              variant="ghost"
              className="group/back inline-flex items-center gap-1 -ml-1 px-1 py-0.5 text-sm text-muted-foreground hover:text-foreground transition-colors h-auto"
              onClick={onBack}
              title={st('sweep.shared.back')}
            >
              <ChevronLeft className="h-4 w-4" />
              <span className="group-hover/back:underline">{st('sweep.shared.back')}</span>
            </Button>
          </div>
        )}
        {/* Right Section */}
        <div className="absolute top-3 right-3 md:right-4 flex items-center gap-0.5 md:gap-1 flex-shrink-0">
          {/* More menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="p-1.5 hover:bg-muted data-[state=open]:bg-muted rounded-md transition-colors focus:outline-none focus-visible:outline-none h-auto w-auto">
                <EllipsisVertical className="h-4 w-4 text-gray-500" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => onEdit(task)}>
                <Pencil className="h-4 w-4 mr-0.5" />
                {st('sweep.shared.editTask')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDuplicate(task)}>
                <Copy className="h-4 w-4 mr-0.5" />
                {st('sweep.shared.duplicate')}
              </DropdownMenuItem>
              {showMoveTask && (
                <DropdownMenuItem onClick={() => setShowMoveDialog(true)}>
                  <FolderInput className="h-4 w-4 mr-0.5" />
                  {t.projects.tasks.moveTaskItem}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950"
                onClick={() => {
                  onDelete(task.id);
                  onClose();
                }}
              >
                <Trash2 className="h-4 w-4 mr-0.5 text-red-600" />
                {st('sweep.shared.deleteTask')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {showMoveTask && (
            <MoveTaskDialog
              open={showMoveDialog}
              onOpenChange={setShowMoveDialog}
              taskId={task.id}
              currentProjectId={(task as { projectId?: string | null }).projectId ?? projectId}
              onMoved={() => {
                // The task left this project — close the detail panel.
                setShowMoveDialog(false);
                onClose();
              }}
            />
          )}
          {/* Close panel — when stacked on a parent panel (onBack provided),
              also dispatch the global close event so the parent panel closes. */}
          <Button
            variant="ghost"
            className="p-1.5 hover:bg-muted rounded-md transition-colors h-auto w-auto"
            onClick={() => {
              if (onBack) {
                window.dispatchEvent(new CustomEvent('close-detail-panels'));
              } else {
                onClose();
              }
            }}
            title={st('sweep.shared.close')}
          >
            <X className="h-4 w-4 text-gray-500" />
          </Button>
        </div>

        {/* Task number — human-friendly identifier, click to copy */}
        {task.number != null && (
          <div className="pb-1.5">
            <TaskNumberBadge number={task.number} />
          </div>
        )}

        {/* Title Section — pr reserves room for the 3-dots + close buttons
            (the gear moved to the tabs row) incl. the title's `-mx-1.5`
            overhang. */}
        <div className="flex items-start gap-2 pr-20 min-w-0">
          {!hideCompletionCheckbox && (
            <Checkbox
              checked={task.status === 'done'}
              onCheckedChange={() => onToggle(task.id)}
              className={cn(
                "h-5 w-5 flex-shrink-0 !rounded-[6px] mt-0.5",
                task.status === 'done' && "data-[state=checked]:!bg-green-600 data-[state=checked]:!border-green-600"
              )}
            />
          )}
          <EditableTitle
            title={task.title}
            isDone={task.status === 'done'}
            onSave={(newTitle) => onUpdate(task.id, { title: newTitle })}
          />
        </div>
      </div>

      {/* Description under title */}
      <div className="px-1 md:px-2 -mt-2 pb-3">
        <DescriptionField
          taskId={task.id}
          description={task.description}
          onUpdate={onUpdate}
        />
      </div>

      {/* Content area */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <div className="flex-1 overflow-y-auto overflow-x-hidden customer-detail-scroll min-w-0" style={{ overflowX: 'hidden' }}>
          <TaskDetailContent
            task={task}
            onUpdate={onUpdate}
            availableAssignees={availableAssignees}
            availableCompanies={availableCompanies}
            availableLabels={availableLabels}
            onCreateLabel={onCreateLabel}
            projectId={projectId}
            taskId={task.id}
            attachments={attachments}
            onAttachmentAdd={projectId ? handleAttachmentAdd : undefined}
            onAttachmentRemove={projectId ? handleAttachmentRemove : undefined}
            comments={comments}
            onAddComment={onAddComment}
            onUpdateComment={onUpdateComment}
            onDeleteComment={onDeleteComment}
            currentUserId={currentUserId}
            subtasks={subtasks}
            onCreateSubtask={onCreateSubtask}
            onToggleSubtask={onToggleSubtask}
            onNavigateToTask={onNavigateToTask}
            parentTask={parentTask}
            dependencyTasks={dependencyTasks}
            blockingTasks={blockingTasks}
            allProjectTasks={allProjectTasks}
            onAddDependency={onAddDependency}
            onRemoveDependency={onRemoveDependency}
            hiddenFields={hiddenFields}
          />
        </div>
      </div>

      {/* Chat - pinned at bottom with resizable handle */}
      {task.id && (
        <div ref={commentsContainerRef} className="flex-shrink-0 flex flex-col" style={manualHeight != null ? { height: manualHeight } : { maxHeight: maxCommentsHeight }}>
          {/* Drag handle */}
          <div
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerUp}
            className="h-[9px] flex-shrink-0 cursor-row-resize flex items-center justify-center group touch-none border-t border-border"
          >
            <div className="w-8 h-[3px] rounded-full bg-gray-300 dark:bg-border opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <div className="flex-1 min-h-0 flex flex-col px-4 pb-4 chat-flush">
            <TaskChat taskId={task.id} taskTitle={task.title} />
          </div>
        </div>
      )}
    </div>
  );
}
