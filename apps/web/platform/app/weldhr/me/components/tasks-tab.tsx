/** My HR → Tasks: onboarding / offboarding checklist tasks, grouped by checklist. */

import { useMemo, useState } from 'react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Label } from '@weldsuite/ui/components/label';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfTask } from '@weldsuite/app-api-client/domains/weldhr';
import { useMyHrCompleteTask, useMyHrTasks } from '@/hooks/queries/use-weldhr-queries';
import { EmptyText, SectionCard } from '../../components/page-kit';
import { ErrorBanner, errorMessage, formatDate, todayIso } from '../../components/shared';
import { TabLoading } from './shared';

interface TaskGroup {
  key: string;
  name: string;
  kind: HrSelfTask['checklistKind'];
  tasks: HrSelfTask[];
}

function groupByChecklist(tasks: HrSelfTask[]): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  for (const task of tasks) {
    const key = `${task.checklistKind}:${task.checklistName}`;
    const group = groups.get(key) ?? { key, name: task.checklistName, kind: task.checklistKind, tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

export function MyTasksTab() {
  const t = useTranslations();
  const { data, isLoading, error } = useMyHrTasks();
  const completeTask = useMyHrCompleteTask();
  const [failure, setFailure] = useState<string | null>(null);
  const groups = useMemo(() => groupByChecklist(data ?? []), [data]);

  if (isLoading) return <TabLoading />;
  if (!data) return <ErrorBanner error={errorMessage(error, t('weldhr.me.tasks.loadFailed'))} />;

  const busyId = completeTask.isPending ? completeTask.variables?.id : undefined;
  const today = todayIso();

  async function toggle(task: HrSelfTask, done: boolean) {
    setFailure(null);
    try {
      await completeTask.mutateAsync({ id: task.id, done });
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.me.tasks.failed')));
    }
  }

  function statusLine(task: HrSelfTask): string {
    if (task.completedAt) return t('weldhr.me.tasks.completedOn', { date: formatDate(task.completedAt) });
    if (task.dueDate) return t('weldhr.me.tasks.due', { date: formatDate(task.dueDate) });
    return t('weldhr.me.tasks.noDueDate');
  }

  if (groups.length === 0) {
    return (
      <SectionCard title={t('weldhr.me.tasks.title')}>
        <EmptyText>{t('weldhr.me.tasks.empty')}</EmptyText>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-4">
      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

      {groups.map((group) => {
        const done = group.tasks.filter((task) => task.completedAt).length;
        return (
          <SectionCard
            key={group.key}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {group.name}
                <Badge variant="outline">{t(`weldhr.status.checklistKind.${group.kind}`)}</Badge>
              </span>
            }
            action={
              <span className="text-xs text-muted-foreground">
                {t('weldhr.me.tasks.progress', { done, total: group.tasks.length })}
              </span>
            }
          >
            <ul className="divide-y">
              {group.tasks.map((task) => {
                const overdue = !task.completedAt && task.dueDate !== null && task.dueDate < today;
                const inputId = `my-hr-task-${task.id}`;
                return (
                  <li key={task.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                    <Checkbox
                      id={inputId}
                      className="mt-0.5"
                      checked={Boolean(task.completedAt)}
                      disabled={!task.canComplete || busyId === task.id}
                      onCheckedChange={(checked) => void toggle(task, checked === true)}
                    />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <Label
                        htmlFor={inputId}
                        className={task.completedAt ? 'font-medium text-muted-foreground line-through' : 'font-medium'}
                      >
                        {task.title}
                      </Label>
                      {task.description && <p className="text-sm text-muted-foreground">{task.description}</p>}
                      <p className="text-xs text-muted-foreground">
                        <span className={overdue ? 'text-destructive' : undefined}>{statusLine(task)}</span>
                        {overdue && <span className="text-destructive"> · {t('weldhr.me.tasks.overdue')}</span>}
                        {!task.canComplete && !task.completedAt && (
                          <> · {t('weldhr.me.tasks.assignedTo', { role: t(`weldhr.status.assigneeRole.${task.assigneeRole}`) })}</>
                        )}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </SectionCard>
        );
      })}
    </div>
  );
}
