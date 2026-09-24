/** WeldHR employee detail: header, actions, and tabs (overview, clients, personal, lifecycle, attendance, leave, coaching, evaluations, performance). */

import { useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Loader2, MoreHorizontal, Plus } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrAssignment } from '@weldsuite/app-api-client/domains/weldhr';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
import {
  useDeleteHrAssignment,
  useDeleteHrEmployee,
  useHrAssignments,
  useHrEmployee,
  useUpdateHrAssignment,
} from '@/hooks/queries/use-weldhr-queries';
import { EmployeeLifecycleTab } from '../../components/employee-tabs/lifecycle-tab';
import { EmployeeAttendanceTab } from '../../components/employee-tabs/attendance-tab';
import { EmployeeLeaveTab } from '../../components/employee-tabs/leave-tab';
import { EmployeeCoachingTab } from '../../components/employee-tabs/coaching-tab';
import { EmployeeEvaluationsTab } from '../../components/employee-tabs/evaluations-tab';
import { EmployeePerformanceTab } from '../../components/employee-tabs/performance-tab';
import { EmployeePortalAccessCard } from '../../components/portal/employee-portal-card';
import { DetailHeader, DetailPage, DetailTabs, FieldGrid, SectionCard, EmptyText, useHrBreadcrumbs } from '../../components/page-kit';
import { EmployeeAvatar, ErrorBanner, StatusBadge, errorMessage, formatDate } from '../../components/shared';
import { EditEmployeeDialog } from '../components/edit-employee-dialog';
import { LifecycleStartDialog } from '../components/lifecycle-start-dialog';
import { AssignmentDialog } from '../components/assignment-dialog';
import { SensitivePanel } from '../components/sensitive-panel';

type TabId = 'overview' | 'clients' | 'personal' | 'lifecycle' | 'attendance' | 'leave' | 'coaching' | 'evaluations' | 'performance';

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

  const [dialog, setDialog] = useState<'edit' | 'onboarding' | 'offboarding' | 'delete' | null>(null);

  const canUpdate = can('employees:update') || can('employees:manage');
  const canDelete = can('employees:delete') || can('employees:manage');
  const canSensitive = can('employees:sensitive');
  const canManagePortal = can('employees:manage');

  const activeTab: TabId = (search.tab as TabId | undefined) ?? 'overview';

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
    { id: 'clients' as const, label: t('weldhr.employees.detail.tabs.clients'), visible: true },
    { id: 'personal' as const, label: t('weldhr.employees.detail.tabs.personal'), visible: canSensitive },
    { id: 'lifecycle' as const, label: t('weldhr.employees.detail.tabs.lifecycle'), visible: can('employees:read') },
    { id: 'attendance' as const, label: t('weldhr.employees.detail.tabs.attendance'), visible: can('attendance:read') },
    { id: 'leave' as const, label: t('weldhr.employees.detail.tabs.leave'), visible: can('leave:read') },
    { id: 'coaching' as const, label: t('weldhr.employees.detail.tabs.coaching'), visible: can('coaching:read') },
    { id: 'evaluations' as const, label: t('weldhr.employees.detail.tabs.evaluations'), visible: can('evaluations:read') },
    { id: 'performance' as const, label: t('weldhr.employees.detail.tabs.performance'), visible: can('evaluations:read') },
  ];
  const tabs = allTabs.filter((tabDef) => tabDef.visible);

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
                {canUpdate && employee.status !== 'terminated' && (
                  <DropdownMenuItem onSelect={() => setDialog('onboarding')}>
                    {t('weldhr.employees.detail.actions.startOnboarding')}
                  </DropdownMenuItem>
                )}
                {canUpdate && employee.status !== 'terminated' && (
                  <DropdownMenuItem onSelect={() => setDialog('offboarding')}>
                    {t('weldhr.employees.detail.actions.startOffboarding')}
                  </DropdownMenuItem>
                )}
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

      {activeTab === 'overview' && <OverviewTab employee={employee} canManagePortal={canManagePortal} />}
      {activeTab === 'clients' && <ClientsTab employeeId={employeeId} canUpdate={canUpdate} />}
      {activeTab === 'personal' && canSensitive && <SensitivePanel employeeId={employeeId} />}
      {activeTab === 'lifecycle' && <EmployeeLifecycleTab employeeId={employeeId} />}
      {activeTab === 'attendance' && <EmployeeAttendanceTab employeeId={employeeId} />}
      {activeTab === 'leave' && <EmployeeLeaveTab employeeId={employeeId} />}
      {activeTab === 'coaching' && <EmployeeCoachingTab employeeId={employeeId} />}
      {activeTab === 'evaluations' && <EmployeeEvaluationsTab employeeId={employeeId} />}
      {activeTab === 'performance' && <EmployeePerformanceTab employeeId={employeeId} />}

      {dialog === 'edit' && <EditEmployeeDialog employee={employee} onClose={() => setDialog(null)} />}
      {dialog === 'onboarding' && <LifecycleStartDialog employeeId={employeeId} kind="onboarding" onClose={() => setDialog(null)} />}
      {dialog === 'offboarding' && <LifecycleStartDialog employeeId={employeeId} kind="offboarding" onClose={() => setDialog(null)} />}
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
}: {
  employee: NonNullable<ReturnType<typeof useHrEmployee>['data']>;
  canManagePortal: boolean;
}) {
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

      <SectionCard title={t('weldhr.employees.detail.overview.clients.title')}>
        {employee.clients.length === 0 ? (
          <EmptyText>{t('weldhr.employees.detail.overview.clients.empty')}</EmptyText>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {employee.clients.map((c) => (
              <Link key={c.companyId} to="/weldhr/clients/$companyId" params={{ companyId: c.companyId }}>
                <Badge variant={c.isPrimary ? 'default' : 'secondary'}>{c.companyName ?? c.companyId}</Badge>
              </Link>
            ))}
          </div>
        )}
      </SectionCard>

      {canManagePortal && <EmployeePortalAccessCard employeeId={employee.id} employeeStatus={employee.status} />}
    </div>
  );
}

function ClientsTab({ employeeId, canUpdate }: { employeeId: string; canUpdate: boolean }) {
  const t = useTranslations();
  const { data: assignments, isLoading, error } = useHrAssignments({ employeeId });
  const updateAssignment = useUpdateHrAssignment();
  const deleteAssignment = useDeleteHrAssignment();
  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'edit'; assignment: HrAssignment } | { kind: 'delete'; assignment: HrAssignment } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <SectionCard
      title={t('weldhr.employees.detail.clientsTab.title')}
      action={
        canUpdate && (
          <Button size="sm" onClick={() => setDialog({ kind: 'create' })}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('weldhr.employees.detail.clientsTab.addAssignment')}
          </Button>
        )
      }
    >
      <ErrorBanner error={failure ?? (error ? errorMessage(error, t('weldhr.common.loadFailed')) : null)} onDismiss={() => setFailure(null)} />

      {isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : !assignments || assignments.length === 0 ? (
        <EmptyText>{t('weldhr.employees.detail.clientsTab.empty')}</EmptyText>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('weldhr.employees.detail.clientsTab.table.company')}</TableHead>
              <TableHead>{t('weldhr.employees.detail.clientsTab.table.role')}</TableHead>
              <TableHead>{t('weldhr.employees.detail.clientsTab.table.allocation')}</TableHead>
              <TableHead>{t('weldhr.employees.detail.clientsTab.table.dates')}</TableHead>
              <TableHead>{t('weldhr.employees.detail.clientsTab.table.status')}</TableHead>
              {canUpdate && <TableHead className="w-px" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {assignments.map((a) => (
              <TableRow key={a.id}>
                <TableCell>
                  <Link to="/weldhr/clients/$companyId" params={{ companyId: a.companyId }} className="hover:underline">
                    {a.companyName ?? a.companyId}
                  </Link>
                  {a.isPrimary && (
                    <Badge variant="outline" className="ml-2">
                      {t('weldhr.employees.detail.clientsTab.table.primary')}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{a.role ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground">{a.allocationPercent}%</TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(a.startDate)} – {a.endDate ? formatDate(a.endDate) : t('weldhr.common.none')}
                </TableCell>
                <TableCell>
                  <Badge variant={a.isActive ? 'default' : 'secondary'}>
                    {a.isActive ? t('weldhr.common.yes') : t('weldhr.common.no')}
                  </Badge>
                </TableCell>
                {canUpdate && (
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {a.isActive && !a.endDate && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={async () => {
                            setFailure(null);
                            try {
                              await updateAssignment.mutateAsync({ id: a.id, endDate: new Date().toISOString().slice(0, 10) });
                            } catch (err) {
                              setFailure(errorMessage(err, t('weldhr.common.saveFailed')));
                            }
                          }}
                        >
                          {t('weldhr.employees.detail.clientsTab.endAssignment')}
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: 'edit', assignment: a })}>
                        {t('weldhr.common.edit')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: 'delete', assignment: a })}>
                        {t('weldhr.common.delete')}
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {dialog?.kind === 'create' && <AssignmentDialog employeeId={employeeId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <AssignmentDialog employeeId={employeeId} assignment={dialog.assignment} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={t('weldhr.common.confirmDelete')}
          description={dialog.assignment.companyName ?? ''}
          variant="destructive"
          confirmLabel={t('weldhr.common.delete')}
          cancelLabel={t('weldhr.common.cancel')}
          onConfirm={async () => {
            try {
              await deleteAssignment.mutateAsync(dialog.assignment.id);
              setDialog(null);
            } catch (err) {
              setFailure(errorMessage(err, t('weldhr.common.deleteFailed')));
              setDialog(null);
            }
          }}
        />
      )}
    </SectionCard>
  );
}
