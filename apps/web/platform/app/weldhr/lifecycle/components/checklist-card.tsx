/** One in-flight or completed checklist, rendered as a card on the lifecycle board. */

import { Link } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { Progress } from '@weldsuite/ui/components/progress';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrChecklist } from '@weldsuite/app-api-client/domains/weldhr';
import { EmployeeAvatar, StatusBadge, formatDate, todayIso } from '../../components/shared';

export function ChecklistCard({ checklist }: { checklist: HrChecklist }) {
  const t = useTranslations();
  const today = todayIso();
  const openTasks = checklist.tasks.filter((task) => !task.completedAt);
  const overdueCount = openTasks.filter((task) => task.dueDate && task.dueDate < today).length;
  const nextTasks = openTasks
    .slice()
    .sort((a, b) => (a.dueDate ?? '9999-99-99').localeCompare(b.dueDate ?? '9999-99-99'))
    .slice(0, 3);
  const percent = checklist.progress.total ? Math.round((checklist.progress.done / checklist.progress.total) * 100) : 0;

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <EmployeeAvatar name={checklist.employeeName} />
          <div className="min-w-0">
            <Link
              to="/weldhr/employees/$employeeId"
              params={{ employeeId: checklist.employeeId }}
              search={{ tab: 'lifecycle' }}
              className="truncate text-sm font-medium hover:underline"
            >
              {checklist.employeeName}
            </Link>
            <p className="truncate text-xs text-muted-foreground">{checklist.name}</p>
          </div>
        </div>
        <StatusBadge group="checklist" status={checklist.status} />
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('weldhr.lifecycle.card.progress', { done: checklist.progress.done, total: checklist.progress.total })}</span>
          {overdueCount > 0 && (
            <span className="flex items-center gap-1 text-destructive">
              <AlertTriangle className="h-3 w-3" />
              {t('weldhr.lifecycle.card.overdue', { count: overdueCount })}
            </span>
          )}
        </div>
        <Progress value={percent} />
      </div>

      <div className="mt-3 space-y-1">
        <p className="text-xs font-medium text-muted-foreground">{t('weldhr.lifecycle.card.nextUp')}</p>
        {nextTasks.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('weldhr.lifecycle.card.noOpenTasks')}</p>
        ) : (
          <ul className="space-y-1">
            {nextTasks.map((task) => (
              <li key={task.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate">{task.title}</span>
                {task.dueDate && (
                  <span className={task.dueDate < today ? 'shrink-0 text-destructive' : 'shrink-0 text-muted-foreground'}>
                    {formatDate(task.dueDate)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
        <span>
          {checklist.completedAt
            ? t('weldhr.lifecycle.card.completedOn', { date: formatDate(checklist.completedAt) })
            : t('weldhr.lifecycle.card.startedOn', { date: formatDate(checklist.startedAt) })}
        </span>
        <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
          <Link to="/weldhr/employees/$employeeId" params={{ employeeId: checklist.employeeId }} search={{ tab: 'lifecycle' }}>
            {t('weldhr.lifecycle.card.viewEmployee')}
          </Link>
        </Button>
      </div>
    </Card>
  );
}
