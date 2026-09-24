/**
 * WeldHR — on- & offboarding board.
 *
 * One flat list of every checklist, grouped onboarding-in-progress /
 * offboarding-in-progress / completed & cancelled. Starting a checklist here
 * materialises real tasks from a template (see `services/weldhr/lifecycle.ts`).
 */

import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { ListChecks, Settings } from 'lucide-react';
import { Progress } from '@weldsuite/ui/components/progress';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrChecklist } from '@weldsuite/app-api-client/domains/weldhr';
import { PanelEntityList, type ColumnDef, type GroupConfig } from '@/components/panel-entity-list';
import { useHrChecklists } from '@/hooks/queries/use-weldhr-queries';
import { emptyIcon, useHrBreadcrumbs } from '../components/page-kit';
import { EmployeeAvatar, formatDate, todayIso } from '../components/shared';
import { StartChecklistDialog } from './components/start-checklist-dialog';

export default function WeldHrLifecyclePage() {
  const t = useTranslations();
  const { can } = usePermissions();
  const navigate = useNavigate();
  useHrBreadcrumbs({ label: t('weldhr.lifecycle.title') });

  const canWrite = can('employees:update');
  const [starting, setStarting] = useState(false);

  const { data: checklists, isLoading, error } = useHrChecklists({});
  const today = todayIso();

  const goToEmployee = (checklist: HrChecklist) =>
    navigate({ to: '/weldhr/employees/$employeeId', params: { employeeId: checklist.employeeId }, search: { tab: 'lifecycle' } });

  const columns: ColumnDef<HrChecklist>[] = [
    {
      id: 'employee',
      header: t('weldhr.lifecycle.list.columns.employee'),
      width: 'flex-1',
      render: (c) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <EmployeeAvatar name={c.employeeName} className="h-7 w-7" />
          <span className="truncate font-medium">{c.employeeName}</span>
        </span>
      ),
    },
    {
      id: 'template',
      header: t('weldhr.lifecycle.list.columns.template'),
      width: 'w-[220px]',
      render: (c) => <span className="truncate text-muted-foreground">{c.name}</span>,
    },
    {
      id: 'progress',
      header: t('weldhr.lifecycle.list.columns.progress'),
      width: 'w-[200px]',
      render: (c) => {
        const percent = c.progress.total ? Math.round((c.progress.done / c.progress.total) * 100) : 0;
        return (
          <div className="flex items-center gap-2">
            <Progress value={percent} className="h-1.5 w-24" />
            <span className="shrink-0 text-xs text-muted-foreground">
              {t('weldhr.lifecycle.card.progress', { done: c.progress.done, total: c.progress.total })}
            </span>
          </div>
        );
      },
    },
    {
      id: 'overdue',
      header: t('weldhr.lifecycle.list.columns.overdue'),
      width: 'w-[110px]',
      render: (c) => {
        const overdueCount = c.tasks.filter((task) => !task.completedAt && task.dueDate && task.dueDate < today).length;
        return overdueCount > 0 ? (
          <span className="text-destructive">{t('weldhr.lifecycle.card.overdue', { count: overdueCount })}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        );
      },
    },
    {
      id: 'started',
      header: t('weldhr.lifecycle.list.columns.started'),
      width: 'w-[120px]',
      render: (c) => <span className="text-muted-foreground">{formatDate(c.startedAt)}</span>,
    },
  ];

  const groups: GroupConfig<HrChecklist>[] = [
    { id: 'onboarding', label: t('weldhr.lifecycle.list.groups.onboarding'), sortOrder: 1, filter: (c) => c.kind === 'onboarding' && c.status === 'in_progress' },
    { id: 'offboarding', label: t('weldhr.lifecycle.list.groups.offboarding'), sortOrder: 2, filter: (c) => c.kind === 'offboarding' && c.status === 'in_progress' },
    { id: 'completed', label: t('weldhr.lifecycle.list.groups.completed'), sortOrder: 3, filter: (c) => c.status === 'completed' || c.status === 'cancelled' },
  ];

  return (
    <>
      <PanelEntityList<HrChecklist>
        items={checklists ?? []}
        isLoading={isLoading}
        error={error}
        columns={columns}
        groups={groups}
        onRowClick={goToEmployee}
        filters={[]}
        actionButtons={
          <Button asChild variant="outline" size="sm" className="h-8">
            <Link to="/weldhr/settings" search={{ tab: 'templates' }}>
              <Settings className="mr-1.5 h-4 w-4" />
              {t('weldhr.lifecycle.manageTemplates')}
            </Link>
          </Button>
        }
        createButton={canWrite ? { label: t('weldhr.lifecycle.startChecklist.action'), onClick: () => setStarting(true) } : undefined}
        emptyState={{
          icon: emptyIcon(ListChecks),
          title: t('weldhr.lifecycle.list.empty.title'),
          description: t('weldhr.lifecycle.list.empty.description'),
          action: canWrite ? { label: t('weldhr.lifecycle.startChecklist.action'), onClick: () => setStarting(true) } : undefined,
        }}
      />

      {starting && <StartChecklistDialog onClose={() => setStarting(false)} />}
    </>
  );
}
