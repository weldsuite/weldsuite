/**
 * My HR → Tasks: your onboarding / offboarding checklist tasks, in the same
 * list as WeldFlow's My tasks (checkbox, task, then plain columns and status
 * pills), grouped per checklist.
 */

import { useCallback, useMemo } from 'react';
import { SquareCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfTask } from '@weldsuite/app-api-client/domains/weldhr';
import { EntityList, type ActiveFilter, type FilterConfig, type GroupConfig, type HeaderColumn } from '@/components/entity-list';
import { useMyHrCompleteTask, useMyHrTasks } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { emptyIcon } from '../../components/page-kit';
import { errorMessage, formatDate, todayIso } from '../../components/shared';

type TaskState = 'open' | 'overdue' | 'done';

function taskState(task: HrSelfTask, today: string): TaskState {
  if (task.completedAt) return 'done';
  return task.dueDate !== null && task.dueDate < today ? 'overdue' : 'open';
}

/** The status pill's colours, as WeldFlow's (to do grey, done green) plus red for overdue. */
const STATE_PILL: Record<TaskState, string> = {
  open: 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary',
  overdue: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950',
  done: 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950',
};

const PILL = 'inline-flex rounded px-2 py-0.5 text-[12px] font-medium';

/** One group per checklist, in the order the checklists come. */
function checklistGroups(tasks: HrSelfTask[], progress: (done: number, total: number) => string): GroupConfig<HrSelfTask>[] {
  const groups = new Map<string, { name: string; tasks: HrSelfTask[] }>();
  for (const task of tasks) {
    const key = `${task.checklistKind}:${task.checklistName}`;
    const group = groups.get(key) ?? { name: task.checklistName, tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }
  return Array.from(groups.entries()).map(([key, group], index) => ({
    id: key,
    label: group.name,
    filter: (task) => `${task.checklistKind}:${task.checklistName}` === key,
    sortOrder: index,
    rightContent: (
      <span className="text-xs text-muted-foreground">
        {progress(group.tasks.filter((t) => t.completedAt).length, group.tasks.length)}
      </span>
    ),
  }));
}

export function MyTasksTab() {
  const t = useTranslations();
  const { data, isLoading, error } = useMyHrTasks();
  const completeTask = useMyHrCompleteTask();
  const tasks = useMemo(() => data ?? [], [data]);
  const today = todayIso();
  const busyId = completeTask.isPending ? completeTask.variables?.id : undefined;

  const stateLabel = useCallback(
    (state: TaskState) =>
      ({
        open: t('weldhr.me.tasks.states.open'),
        overdue: t('weldhr.me.tasks.overdue'),
        done: t('weldhr.me.tasks.states.done'),
      })[state],
    [t],
  );

  const groups = useMemo(
    () => checklistGroups(tasks, (done, total) => t('weldhr.me.tasks.progress', { done, total })),
    [tasks, t],
  );

  const headerColumns: HeaderColumn[] = useMemo(
    () => [
      // As in WeldFlow: the "Task" header sits over the checkbox column.
      { id: 'checkbox', header: t('weldhr.me.tasks.columns.task'), width: 'w-4 flex-shrink-0' },
      { id: 'task', header: '', width: 'min-w-[200px] flex-1' },
      { id: 'checklist', header: t('weldhr.me.tasks.columns.checklist'), width: 'w-[160px]' },
      { id: 'status', header: t('weldhr.me.tasks.columns.status'), width: 'w-[120px]' },
      { id: 'type', header: t('weldhr.me.tasks.columns.type'), width: 'w-[110px]' },
      { id: 'due', header: t('weldhr.me.tasks.columns.due'), width: 'w-[100px]' },
      { id: 'assignee', header: t('weldhr.me.tasks.columns.assignee'), width: 'w-[120px]' },
    ],
    [t],
  );

  const filters: FilterConfig[] = useMemo(
    () => [
      {
        field: 'state',
        label: t('weldhr.me.tasks.columns.status'),
        operators: ['is'],
        options: (['open', 'overdue', 'done'] as const).map((state) => ({ value: state, label: stateLabel(state) })),
      },
      {
        field: 'kind',
        label: t('weldhr.me.tasks.columns.type'),
        operators: ['is'],
        options: (['onboarding', 'offboarding'] as const).map((kind) => ({
          value: kind,
          label: t(`weldhr.status.checklistKind.${kind}`),
        })),
      },
    ],
    [t, stateLabel],
  );

  const applyFilters = useCallback(
    (items: HrSelfTask[], active: ActiveFilter[]) =>
      active.reduce((rows, filter) => {
        if (!filter.value) return rows;
        if (filter.field === 'state') return rows.filter((task) => taskState(task, today) === filter.value);
        if (filter.field === 'kind') return rows.filter((task) => task.checklistKind === filter.value);
        return rows;
      }, items),
    [today],
  );

  const toggle = useCallback(
    async (task: HrSelfTask, done: boolean) => {
      try {
        await completeTask.mutateAsync({ id: task.id, done });
      } catch (err) {
        toast.error(errorMessage(err, t('weldhr.me.tasks.failed')));
      }
    },
    [completeTask, t],
  );

  const renderRow = useCallback(
    (task: HrSelfTask) => {
      const state = taskState(task, today);
      const done = state === 'done';
      const assignee =
        task.assigneeRole === 'employee' ? t('weldhr.me.tasks.you') : t(`weldhr.status.assigneeRole.${task.assigneeRole}`);
      return (
        <div
          key={task.id}
          className={cn(
            'group relative flex items-center gap-4 border-b border-gray-200/70 py-3 pr-4 pl-4 hover:bg-gray-50 dark:border-border dark:hover:bg-secondary/50',
            done && 'opacity-50',
          )}
        >
          <div className="relative z-[1] flex w-4 flex-shrink-0 items-center">
            <Checkbox
              aria-label={task.title}
              checked={done}
              disabled={!task.canComplete || busyId === task.id}
              onCheckedChange={(checked) => void toggle(task, checked === true)}
              className="h-4 w-4"
            />
          </div>

          <div className="flex min-w-[200px] flex-1 items-center gap-2" title={task.description ?? undefined}>
            <span
              className={cn(
                'min-w-0 truncate text-sm font-medium',
                done ? 'text-gray-400 line-through' : 'text-gray-900 dark:text-foreground',
              )}
            >
              {task.title}
            </span>
          </div>

          <div className="flex w-[160px] items-center">
            <span className="block truncate text-sm text-gray-600 dark:text-muted-foreground">{task.checklistName}</span>
          </div>

          <div className="flex w-[120px] items-center">
            <span className={cn(PILL, STATE_PILL[state])}>{stateLabel(state)}</span>
          </div>

          <div className="flex w-[110px] items-center">
            <span className={cn(PILL, STATE_PILL.open)}>{t(`weldhr.status.checklistKind.${task.checklistKind}`)}</span>
          </div>

          <div className="flex w-[100px] items-center text-sm">
            {task.dueDate ? (
              <span className={cn('tabular-nums', state === 'overdue' && 'text-red-600 dark:text-red-400')}>
                {formatDate(task.dueDate)}
              </span>
            ) : (
              <span className="text-gray-400">—</span>
            )}
          </div>

          <div className="flex w-[120px] items-center">
            <span className="truncate text-sm text-gray-600 dark:text-muted-foreground">{assignee}</span>
          </div>

          {/* The list's actions column (WeldFlow's ⋯ menu); no row actions here. */}
          <div className="h-7 w-[40px] flex-shrink-0" />
        </div>
      );
    },
    [today, t, busyId, toggle, stateLabel],
  );

  return (
    <EntityList<HrSelfTask>
      items={tasks}
      isLoading={isLoading}
      error={error && !data ? new Error(errorMessage(error, t('weldhr.me.tasks.loadFailed'))) : null}
      headerColumns={headerColumns}
      filters={filters}
      groups={groups}
      applyFilters={applyFilters}
      renderRow={renderRow}
      searchPlaceholder={t('weldhr.me.tasks.searchPlaceholder')}
      searchFields={['title', 'description', 'checklistName']}
      topBarClassName="pt-2 pb-2"
      emptyState={{
        icon: emptyIcon(SquareCheck),
        title: t('weldhr.me.tasks.title'),
        description: t('weldhr.me.tasks.empty'),
      }}
    />
  );
}
