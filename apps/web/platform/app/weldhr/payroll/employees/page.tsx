/** WeldHR Payroll — Employees: who is ready for the next run, and what is still missing. */

import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { UserRoundCheck } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPayrollEmployeeListItem } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { PanelEntityList, type ColumnDef, type GroupConfig } from '@/components/panel-entity-list';
import { useHrPayrollEmployees, useHrPayrollEmployers } from '@/hooks/queries/use-weldhr-payroll-queries';
import { emptyIcon, useHrBreadcrumbs } from '../../components/page-kit';
import { EmployeeAvatar } from '../../components/shared';
import { PayrollGate, ReadinessBadge } from '../components/payroll-ui';
import { formatDecimal } from '../lib/format';
import { usePayrollLabels } from '../lib/use-payroll-labels';

const ALL = '__all';

/** `PanelEntityList` rows need an `id`; the list item is keyed by employee. */
type Row = HrPayrollEmployeeListItem & { id: string };

export default function WeldHrPayrollEmployeesPage() {
  return (
    <PayrollGate>
      <PayrollEmployees />
    </PayrollGate>
  );
}

function PayrollEmployees() {
  const t = useTranslations();
  const labels = usePayrollLabels();
  useHrBreadcrumbs({ label: t('weldhr.payroll.title'), href: '/weldhr/payroll' }, { label: t('weldhr.payroll.employees.title') });
  const navigate = useNavigate();

  const [employerId, setEmployerId] = useState<string>(ALL);
  const { data: employers } = useHrPayrollEmployers();
  const { data, isLoading, error } = useHrPayrollEmployees({ employerId: employerId === ALL ? undefined : employerId });
  const rows: Row[] = (data ?? []).map((employee) => ({ ...employee, id: employee.employeeId }));

  const groups: GroupConfig<Row>[] = [
    { id: 'attention', label: t('weldhr.payroll.employees.groups.attention'), sortOrder: 1, filter: (row) => row.profile !== null && row.issues.length > 0 },
    { id: 'ready', label: t('weldhr.payroll.employees.groups.ready'), sortOrder: 2, filter: (row) => row.profile !== null && row.issues.length === 0 },
    { id: 'notOnPayroll', label: t('weldhr.payroll.employees.groups.notOnPayroll'), sortOrder: 3, filter: (row) => row.profile === null },
  ];

  const columns: ColumnDef<Row>[] = [
    {
      id: 'employee',
      header: t('weldhr.payroll.common.employee'),
      width: 'w-[220px]',
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2">
          <EmployeeAvatar name={row.displayName} src={row.avatarUrl} />
          <span className="min-w-0">
            <span className="block truncate font-medium">{row.displayName}</span>
            {row.jobTitle && <span className="block truncate text-xs text-muted-foreground">{row.jobTitle}</span>}
          </span>
        </span>
      ),
    },
    {
      id: 'employer',
      header: t('weldhr.payroll.common.employer'),
      width: 'w-[170px]',
      render: (row) => <span className="block truncate text-muted-foreground">{row.employerName ?? '—'}</span>,
    },
    {
      id: 'schedule',
      header: t('weldhr.payroll.common.schedule'),
      width: 'w-[150px]',
      render: (row) => <span className="block truncate text-muted-foreground">{row.payScheduleName ?? '—'}</span>,
    },
    {
      id: 'pay',
      header: t('weldhr.payroll.employees.currentPay'),
      width: 'w-[170px]',
      render: (row) =>
        row.currentCompensation ? (
          <span className="tabular-nums">
            {formatDecimal(row.currentCompensation.amount, row.currentCompensation.currency)}
            <span className="text-muted-foreground"> / {t(`weldhr.payroll.period.${row.currentCompensation.period}`)}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'issues',
      header: t('weldhr.payroll.employees.readiness'),
      width: 'flex-1',
      render: (row) => {
        if (row.profile === null) return <span className="text-muted-foreground">{t('weldhr.payroll.employees.notOnPayroll')}</span>;
        const first = row.issues[0];
        return (
          <span className="flex min-w-0 items-center gap-2" title={row.issues.map((issue) => labels.issue(issue)).join('\n')}>
            <ReadinessBadge issues={row.issues} />
            {first && <span className="truncate text-xs text-muted-foreground">{labels.issue(first)}</span>}
          </span>
        );
      },
    },
  ];

  const filter = (
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
  );

  return (
    <PanelEntityList<Row>
      items={rows}
      isLoading={isLoading}
      error={error}
      columns={columns}
      groups={groups}
      filters={[]}
      leftActionButtons={filter}
      searchFields={['displayName', 'employerName']}
      onRowClick={(row) => void navigate({ to: '/weldhr/employees/$employeeId', params: { employeeId: row.employeeId }, search: { tab: 'payroll' } })}
      emptyState={{
        icon: emptyIcon(UserRoundCheck),
        title: t('weldhr.payroll.employees.empty.title'),
        description: t('weldhr.payroll.employees.empty.description'),
      }}
    />
  );
}
