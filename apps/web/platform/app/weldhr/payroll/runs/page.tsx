/** WeldHR Payroll — Pay runs: every run grouped by status, newest period first. */

import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Banknote } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrPayRun } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { PanelEntityList, type ColumnDef, type GroupConfig } from '@/components/panel-entity-list';
import { useHrPayRuns, useHrPayrollEmployers } from '@/hooks/queries/use-weldhr-payroll-queries';
import { emptyIcon, useHrBreadcrumbs } from '../../components/page-kit';
import { formatDate } from '../../components/shared';
import { IssueCountBadges, PayrollGate, RunStatusBadge } from '../components/payroll-ui';
import { StartRunDialog } from '../components/start-run-dialog';
import { formatCents, periodRange, yearOptions } from '../lib/format';

const ALL = '__all';

export default function WeldHrPayrollRunsPage() {
  return (
    <PayrollGate>
      <RunsList />
    </PayrollGate>
  );
}

function RunsList() {
  const t = useTranslations();
  useHrBreadcrumbs({ label: t('weldhr.payroll.title'), href: '/weldhr/payroll' }, { label: t('weldhr.payroll.runs.title') });
  const { can } = usePermissions();
  const navigate = useNavigate();

  const [employerId, setEmployerId] = useState<string>(ALL);
  const [year, setYear] = useState<string>(ALL);
  const [creating, setCreating] = useState(false);

  const { data: employers } = useHrPayrollEmployers();
  const { data: runs, isLoading, error } = useHrPayRuns({
    employerId: employerId === ALL ? undefined : employerId,
    year: year === ALL ? undefined : Number(year),
  });

  const groups: GroupConfig<HrPayRun>[] = (['draft', 'calculated', 'approved', 'paid', 'cancelled'] as const).map((status, index) => ({
    id: status,
    label: t(`weldhr.payroll.runs.groups.${status}`),
    sortOrder: index + 1,
    filter: (run: HrPayRun) => run.status === status,
  }));

  const columns: ColumnDef<HrPayRun>[] = [
    {
      id: 'period',
      header: t('weldhr.payroll.common.period'),
      width: 'flex-1',
      render: (run) => (
        <span className="block truncate font-medium">
          {periodRange(run.periodStart, run.periodEnd)}
          {run.kind !== 'regular' && <span className="ml-2 text-xs font-normal text-muted-foreground">{t(`weldhr.payroll.runKind.${run.kind}`)}</span>}
        </span>
      ),
    },
    {
      id: 'employer',
      header: t('weldhr.payroll.common.employer'),
      width: 'w-[180px]',
      render: (run) => <span className="block truncate text-muted-foreground">{run.employerName}</span>,
    },
    {
      id: 'payDate',
      header: t('weldhr.payroll.common.payDate'),
      width: 'w-[110px]',
      render: (run) => <span className="text-muted-foreground">{formatDate(run.payDate)}</span>,
    },
    {
      id: 'employees',
      header: t('weldhr.payroll.common.employees'),
      width: 'w-[90px]',
      render: (run) => <span className="tabular-nums">{run.employeeCount}</span>,
    },
    {
      id: 'net',
      header: t('weldhr.payroll.common.net'),
      width: 'w-[120px]',
      render: (run) => <span className="font-medium tabular-nums">{formatCents(run.totals?.netCents, run.currency)}</span>,
    },
    {
      id: 'issues',
      header: t('weldhr.payroll.runs.table.issues'),
      width: 'w-[90px]',
      render: (run) => <IssueCountBadges issues={run.issues} />,
    },
    {
      id: 'status',
      header: t('weldhr.payroll.common.status'),
      width: 'w-[110px]',
      render: (run) => <RunStatusBadge status={run.status} />,
    },
  ];

  const filters = (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={employerId} onValueChange={setEmployerId}>
        <SelectTrigger className="h-8 w-[180px]" aria-label={t('weldhr.payroll.common.employer')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('weldhr.payroll.common.allEmployers')}</SelectItem>
          {(employers ?? []).map((employer) => (
            <SelectItem key={employer.id} value={employer.id}>
              {employer.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={year} onValueChange={setYear}>
        <SelectTrigger className="h-8 w-[120px]" aria-label={t('weldhr.payroll.common.year')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('weldhr.payroll.common.allYears')}</SelectItem>
          {yearOptions().map((option) => (
            <SelectItem key={option} value={String(option)}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <>
      <PanelEntityList<HrPayRun>
        items={runs ?? []}
        isLoading={isLoading}
        error={error}
        columns={columns}
        groups={groups}
        filters={[]}
        leftActionButtons={filters}
        searchFields={['employerName']}
        onRowClick={(run) => void navigate({ to: '/weldhr/payroll/runs/$runId', params: { runId: run.id } })}
        createButton={can('payroll:prepare') ? { label: t('weldhr.payroll.runs.newRun'), onClick: () => setCreating(true) } : undefined}
        emptyState={{
          icon: emptyIcon(Banknote),
          title: t('weldhr.payroll.runs.empty.title'),
          description: t('weldhr.payroll.runs.empty.description'),
        }}
      />
      {creating && <StartRunDialog onClose={() => setCreating(false)} />}
    </>
  );
}
