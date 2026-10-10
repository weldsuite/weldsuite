/** WeldHR employee detail: header, actions, and tabs (overview, personal, attendance, leave, payroll). */

import { useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
import { useDeleteHrEmployee, useHrEmployee } from '@/hooks/queries/use-weldhr-queries';
import { useHrPayrollFlag } from '@/hooks/queries/use-weldhr-payroll-queries';
import { EmployeeAttendanceTab } from '../../components/employee-tabs/attendance-tab';
import { EmployeeLeaveTab } from '../../components/employee-tabs/leave-tab';
import { EmployeePayrollTab } from '../../components/employee-tabs/payroll-tab';
import { EmployeePortalAccessCard } from '../../components/portal/employee-portal-card';
import { DetailHeader, DetailPage, DetailTabs, FieldGrid, SectionCard, EmptyText, useHrBreadcrumbs } from '../../components/page-kit';
import { EmployeeAvatar, ErrorBanner, StatusBadge, errorMessage, formatDate } from '../../components/shared';
import { EditEmployeeDialog } from '../components/edit-employee-dialog';
import { SensitivePanel } from '../components/sensitive-panel';
import { EmployeeWorkspaceMemberCard } from '../components/workspace-member-card';

type TabId = 'overview' | 'personal' | 'attendance' | 'leave' | 'payroll';

export default function WeldHrEmployeeDetailPage() {
  const t = useTranslations();
  const { can } = usePermissions();
  const { employeeId } = useParams({ from: '/weldhr/employees/$employeeId/' });
  const search = useSearch({ from: '/weldhr/employees/$employeeId/' });
  const navigate = useNavigate();

  const { data: employee, isLoading, error } = useHrEmployee(employeeId);
  const deleteEmployee = useDeleteHrEmployee();

  useHrBreadcrumbs(
    { label: t('weldhr.employees.title'), href: '/weldhr/employees' },
    employee ? { label: employee.displayName } : null,
  );

  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null);

  const canUpdate = can('employees:update') || can('employees:manage');
  const canDelete = can('employees:delete') || can('employees:manage');
  const canSensitive = can('employees:sensitive');
  const canManagePortal = can('employees:manage');
  // The Payroll tab needs the weldhr-payroll flag and payroll:read.
  const payrollFlag = useHrPayrollFlag();
  const canSeePayroll = payrollFlag.enabled && can('payroll:read');


  function setTab(tab: TabId) {
    void navigate({ to: '/weldhr/employees/$employeeId', params: { employeeId }, search: { tab }, replace: true });
  }

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!employee) {
    return (
      <DetailPage>
        <ErrorBanner error={errorMessage(error, t('weldhr.employees.detail.notFound'))} />
      </DetailPage>
    );
  }

  const allTabs: Array<{ id: TabId; label: string; visible: boolean }> = [
    { id: 'overview' as const, label: t('weldhr.employees.detail.tabs.overview'), visible: true },
    { id: 'personal' as const, label: t('weldhr.employees.detail.tabs.personal'), visible: canSensitive },
    { id: 'attendance' as const, label: t('weldhr.employees.detail.tabs.attendance'), visible: can('attendance:read') },
    { id: 'leave' as const, label: t('weldhr.employees.detail.tabs.leave'), visible: can('leave:read') },
    { id: 'payroll' as const, label: t('weldhr.payroll.employeeTab'), visible: canSeePayroll },
  ];
  const tabs = allTabs.filter((tabDef) => tabDef.visible);
  // An old link can still carry a tab that no longer exists (?tab=coaching): show the overview.
  const activeTab: TabId = tabs.find((tabDef) => tabDef.id === search.tab)?.id ?? 'overview';

  return (
    <DetailPage>
      <DetailHeader
        leading={<EmployeeAvatar name={employee.displayName} src={employee.avatarUrl} className="h-12 w-12" />}
        title={employee.displayName}
        badges={<StatusBadge group="employee" status={employee.status} />}
        subtitle={
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {employee.jobTitle ?? t('weldhr.employees.detail.overview.noJobTitle')}
              {' · '}
              {t(`weldhr.status.employmentType.${employee.employmentType}`)}
              {employee.departmentName && ` · ${employee.departmentName}`}
            </span>
            <span className="text-muted-foreground">·</span>
            <span>{employee.email}</span>
            {employee.phone && (
              <>
                <span className="text-muted-foreground">·</span>
                <span>{employee.phone}</span>
              </>
            )}
            {employee.managerName && (
              <>
                <span className="text-muted-foreground">·</span>
                <Link to="/weldhr/employees/$employeeId" params={{ employeeId: employee.managerId as string }} className="hover:underline">
                  {t('weldhr.employees.detail.overview.manager')}: {employee.managerName}
                </Link>
              </>
            )}
          </div>
        }
        actions={
          (canUpdate || canDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canUpdate && <DropdownMenuItem onSelect={() => setDialog('edit')}>{t('weldhr.employees.detail.actions.edit')}</DropdownMenuItem>}
                {canDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setDialog('delete')}>
                      {t('weldhr.employees.detail.actions.delete')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }
      />

      <DetailTabs tabs={tabs} activeTab={activeTab} onTabChange={(v) => setTab(v as TabId)} />

      {activeTab === 'overview' && (
        <OverviewTab
          employee={employee}
          canManagePortal={canManagePortal}
          showWorkspaceCard={canUpdate || can('team:create') || can('team:read')}
        />
      )}
      {activeTab === 'personal' && canSensitive && <SensitivePanel employeeId={employeeId} />}
      {activeTab === 'attendance' && <EmployeeAttendanceTab employeeId={employeeId} />}
      {activeTab === 'leave' && <EmployeeLeaveTab employeeId={employeeId} />}
      {activeTab === 'payroll' && canSeePayroll && <EmployeePayrollTab employeeId={employeeId} />}

      {dialog === 'edit' && <EditEmployeeDialog employee={employee} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={t('weldhr.employees.detail.deleteConfirm.title')}
          description={t('weldhr.employees.detail.deleteConfirm.description', { name: employee.displayName })}
          variant="destructive"
          confirmLabel={t('weldhr.common.delete')}
          cancelLabel={t('weldhr.common.cancel')}
          onConfirm={async () => {
            await deleteEmployee.mutateAsync(employeeId);
            setDialog(null);
            void navigate({ to: '/weldhr/employees' });
          }}
        />
      )}
    </DetailPage>
  );
}

function OverviewTab({
  employee,
  canManagePortal,
  showWorkspaceCard,
}: Readonly<{
  employee: NonNullable<ReturnType<typeof useHrEmployee>['data']>;
  canManagePortal: boolean;
  showWorkspaceCard: boolean;
}>) {
  const t = useTranslations();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SectionCard title={t('weldhr.employees.detail.overview.profile')}>
        <FieldGrid
          fields={[
            { label: t('weldhr.employees.detail.overview.employeeNumber'), value: employee.employeeNumber },
            { label: t('weldhr.employees.detail.overview.pronouns'), value: employee.pronouns },
            { label: t('weldhr.employees.create.startDate'), value: formatDate(employee.startDate) },
            { label: t('weldhr.employees.detail.overview.probationEndDate'), value: formatDate(employee.probationEndDate) },
            { label: t('weldhr.employees.detail.overview.endDate'), value: formatDate(employee.endDate) },
            { label: t('weldhr.employees.detail.overview.location'), value: employee.location },
            { label: t('weldhr.employees.detail.overview.timezone'), value: employee.timezone },
            {
              label: t('weldhr.employees.detail.overview.weeklyHours'),
              value: employee.weeklyHours !== null ? String(employee.weeklyHours) : null,
            },
          ]}
        />
      </SectionCard>

      <SectionCard title={t('weldhr.employees.detail.overview.directReports.title')}>
        {employee.directReports.length === 0 ? (
          <EmptyText>{t('weldhr.employees.detail.overview.directReports.empty')}</EmptyText>
        ) : (
          <ul className="space-y-2">
            {employee.directReports.map((report) => (
              <li key={report.id}>
                <Link
                  to="/weldhr/employees/$employeeId"
                  params={{ employeeId: report.id }}
                  className="flex items-center gap-2 text-sm hover:underline"
                >
                  <EmployeeAvatar name={report.displayName} src={report.avatarUrl} className="h-6 w-6" />
                  <span>{report.displayName}</span>
                  {report.jobTitle && <span className="text-muted-foreground">· {report.jobTitle}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {showWorkspaceCard && <EmployeeWorkspaceMemberCard employee={employee} />}
      {canManagePortal && <EmployeePortalAccessCard employeeId={employee.id} employeeStatus={employee.status} />}
    </div>
  );
}
