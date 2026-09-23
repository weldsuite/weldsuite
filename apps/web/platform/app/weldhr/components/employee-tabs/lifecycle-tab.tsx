/** Employee detail — lifecycle tab: every onboarding/offboarding checklist for this employee. */

import { useState } from 'react';
import { Eye, EyeOff, Plus, Trash2, X } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Progress } from '@weldsuite/ui/components/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrAssigneeRole, HrChecklist } from '@weldsuite/app-api-client/domains/weldhr';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useAddHrChecklistTask,
  useCancelHrChecklist,
  useDeleteHrChecklist,
  useDeleteHrChecklistTask,
  useHrChecklists,
  useHrEmployee,
  useUpdateHrChecklistTask,
} from '@/hooks/queries/use-weldhr-queries';
import { StartChecklistDialog } from '../../lifecycle/components/start-checklist-dialog';
import { EmptyState, ErrorBanner, InlineSpinner, StatusBadge, errorMessage, formatDate, todayIso } from '../shared';

const ASSIGNEE_ROLES: HrAssigneeRole[] = ['hr', 'manager', 'it', 'employee', 'other'];

export function EmployeeLifecycleTab({ employeeId }: { employeeId: string }) {
  const t = useTranslations();
  const { can } = usePermissions();
  const canWrite = can('employees:update');
  const today = todayIso();

  const { data: employee } = useHrEmployee(employeeId);
  const { data: checklists, isLoading, error } = useHrChecklists({ employeeId });

  const [starting, setStarting] = useState<'onboarding' | 'offboarding' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addingTaskFor, setAddingTaskFor] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<HrChecklist | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrChecklist | null>(null);
  const [deleteTaskTarget, setDeleteTaskTarget] = useState<{ checklistId: string; taskId: string } | null>(null);

  const updateTask = useUpdateHrChecklistTask();
  const deleteTaskMutation = useDeleteHrChecklistTask();
  const cancelChecklist = useCancelHrChecklist();
  const deleteChecklist = useDeleteHrChecklist();

  const hasOpen = (kind: 'onboarding' | 'offboarding') => (checklists ?? []).some((c) => c.kind === kind && c.status === 'in_progress');

  async function toggleTask(checklistId: string, taskId: string, completed: boolean) {
    try {
      const res = await updateTask.mutateAsync({ id: taskId, completed });
      const outcome = res.data.outcome;
      if (outcome.checklistCompleted && employee) {
        setNotice(
          outcome.kind === 'onboarding'
            ? t('weldhr.lifecycle.detail.completeOutcomeOnboarding', { name: employee.displayName })
            : t('weldhr.lifecycle.detail.completeOutcomeOffboarding', { name: employee.displayName }),
        );
      }
    } catch {
      // The mutation error surfaces via the checklist card's own state below.
    }
  }

  if (isLoading) return <InlineSpinner />;

  return (
    <div className="space-y-4">
      <ErrorBanner error={error ? errorMessage(error, t('weldhr.lifecycle.loadFailed')) : null} />
      {notice && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-300/50 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} aria-label={t('weldhr.common.close')}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {canWrite && (
        <div className="flex flex-wrap gap-2">
          {!hasOpen('onboarding') && (
            <Button size="sm" variant="outline" onClick={() => setStarting('onboarding')}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('weldhr.status.checklistKind.onboarding')}
            </Button>
          )}
          {!hasOpen('offboarding') && (
            <Button size="sm" variant="outline" onClick={() => setStarting('offboarding')}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('weldhr.status.checklistKind.offboarding')}
            </Button>
          )}
        </div>
      )}

      {!checklists || checklists.length === 0 ? (
        <EmptyState title={t('weldhr.lifecycle.detail.noChecklists')} />
      ) : (
        <div className="space-y-4">
          {checklists.map((checklist) => {
            const percent = checklist.progress.total
              ? Math.round((checklist.progress.done / checklist.progress.total) * 100)
              : 0;
            return (
              <Card key={checklist.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{checklist.name}</p>
                      <Badge variant="outline">{t(`weldhr.status.checklistKind.${checklist.kind}`)}</Badge>
                      <StatusBadge group="checklist" status={checklist.status} />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {checklist.completedAt
                        ? t('weldhr.lifecycle.card.completedOn', { date: formatDate(checklist.completedAt) })
                        : t('weldhr.lifecycle.card.startedOn', { date: formatDate(checklist.startedAt) })}
                    </p>
                  </div>
                  {canWrite && checklist.status === 'in_progress' && (
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => setCancelTarget(checklist)}>
                        {t('weldhr.lifecycle.actions.cancelChecklist')}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setDeleteTarget(checklist)}>
                        {t('weldhr.lifecycle.actions.deleteChecklist')}
                      </Button>
                    </div>
                  )}
                </div>

                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{t('weldhr.lifecycle.card.progress', { done: checklist.progress.done, total: checklist.progress.total })}</span>
                  </div>
                  <Progress value={percent} />
                </div>

                <ul className="mt-3 divide-y">
                  {checklist.tasks
                    .slice()
                    .sort((a, b) => a.sortOrder - b.sortOrder)
                    .map((task) => {
                      const overdue = Boolean(task.dueDate && !task.completedAt && task.dueDate < today);
                      return (
                        <li key={task.id} className="flex items-start gap-3 py-2">
                          <Checkbox
                            checked={Boolean(task.completedAt)}
                            disabled={!canWrite || updateTask.isPending}
                            onCheckedChange={(checked) => void toggleTask(checklist.id, task.id, checked === true)}
                            className="mt-0.5"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <p className={task.completedAt ? 'text-sm line-through text-muted-foreground' : 'text-sm'}>
                                {task.title}
                              </p>
                              <Badge variant="secondary" className="text-[10px]">
                                {t(`weldhr.status.assigneeRole.${task.assigneeRole}`)}
                              </Badge>
                              {task.assigneeName && (
                                <span className="text-xs text-muted-foreground">{task.assigneeName}</span>
                              )}
                              {task.visibleToEmployee ? (
                                <Eye className="h-3.5 w-3.5 text-muted-foreground" aria-label={t('weldhr.lifecycle.detail.taskVisible')} />
                              ) : (
                                <EyeOff className="h-3.5 w-3.5 text-muted-foreground/50" />
                              )}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              {task.dueDate && (
                                <span className={overdue ? 'font-medium text-destructive' : ''}>
                                  {overdue ? `${t('weldhr.lifecycle.detail.overdueLabel')} · ` : ''}
                                  {formatDate(task.dueDate)}
                                </span>
                              )}
                              {task.completedAt && (
                                <span>
                                  {task.completedByName
                                    ? t('weldhr.lifecycle.detail.completedBy', { name: task.completedByName })
                                    : t('weldhr.lifecycle.detail.completedAt', { date: formatDate(task.completedAt) })}
                                </span>
                              )}
                            </div>
                          </div>
                          {canWrite && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 shrink-0"
                              onClick={() => setDeleteTaskTarget({ checklistId: checklist.id, taskId: task.id })}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </li>
                      );
                    })}
                </ul>

                {canWrite && (
                  <div className="mt-2">
                    {addingTaskFor === checklist.id ? (
                      <AddTaskForm checklistId={checklist.id} onDone={() => setAddingTaskFor(null)} />
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => setAddingTaskFor(checklist.id)}>
                        <Plus className="mr-1.5 h-4 w-4" />
                        {t('weldhr.lifecycle.detail.addTask')}
                      </Button>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {starting && (
        <StartChecklistDialog
          kind={starting}
          fixedEmployeeId={employeeId}
          fixedEmployeeLabel={employee?.displayName ?? null}
          onClose={() => setStarting(null)}
        />
      )}

      <ConfirmDialog
        open={Boolean(cancelTarget)}
        onOpenChange={(open) => !open && setCancelTarget(null)}
        title={t('weldhr.lifecycle.actions.confirmCancelTitle')}
        description={t('weldhr.lifecycle.actions.confirmCancelDescription')}
        onConfirm={async () => {
          if (!cancelTarget) return;
          await cancelChecklist.mutateAsync(cancelTarget.id);
          setCancelTarget(null);
        }}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('weldhr.lifecycle.actions.confirmDeleteTitle')}
        description={t('weldhr.lifecycle.actions.confirmDeleteDescription')}
        variant="destructive"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await deleteChecklist.mutateAsync(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
      <ConfirmDialog
        open={Boolean(deleteTaskTarget)}
        onOpenChange={(open) => !open && setDeleteTaskTarget(null)}
        title={t('weldhr.lifecycle.detail.deleteTaskConfirm')}
        description=""
        variant="destructive"
        onConfirm={async () => {
          if (!deleteTaskTarget) return;
          await deleteTaskMutation.mutateAsync(deleteTaskTarget.taskId);
          setDeleteTaskTarget(null);
        }}
      />
    </div>
  );
}

function AddTaskForm({ checklistId, onDone }: { checklistId: string; onDone: () => void }) {
  const t = useTranslations();
  const addTask = useAddHrChecklistTask();
  const [title, setTitle] = useState('');
  const [role, setRole] = useState<HrAssigneeRole>('hr');
  const [dueDate, setDueDate] = useState('');
  const [visible, setVisible] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit() {
    if (!title.trim()) return;
    setFailure(null);
    try {
      await addTask.mutateAsync({
        checklistId,
        title: title.trim(),
        assigneeRole: role,
        dueDate: dueDate || undefined,
        visibleToEmployee: visible,
      });
      onDone();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.lifecycle.detail.addTaskFailed')));
    }
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border p-3">
      <ErrorBanner error={failure} />
      <div className="space-y-1">
        <Label htmlFor={`task-title-${checklistId}`}>{t('weldhr.lifecycle.detail.taskTitle')}</Label>
        <Input id={`task-title-${checklistId}`} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label>{t('weldhr.lifecycle.detail.taskRole')}</Label>
          <Select value={role} onValueChange={(v) => setRole(v as HrAssigneeRole)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ASSIGNEE_ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {t(`weldhr.status.assigneeRole.${r}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`task-due-${checklistId}`}>{t('weldhr.lifecycle.detail.taskDueDate')}</Label>
          <Input id={`task-due-${checklistId}`} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={visible} onCheckedChange={(c) => setVisible(c === true)} />
        {t('weldhr.lifecycle.detail.taskVisible')}
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onDone}>
          {t('weldhr.common.cancel')}
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={!title.trim() || addTask.isPending}>
          {t('weldhr.lifecycle.detail.addTaskSubmit')}
        </Button>
      </div>
    </div>
  );
}
