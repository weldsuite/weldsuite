/** WeldHR employee directory: search, department filter, status groups, cursor-paginated list, "New employee". */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Users } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrEmployeeListItem } from '@weldsuite/app-api-client/domains/weldhr';
import { useDebounce } from '@/hooks/use-debounce';
import { PanelEntityList, type ColumnDef, type FilterConfig, type ActiveFilter, type GroupConfig } from '@/components/panel-entity-list';
import { useHrDepartments, useHrEmployees } from '@/hooks/queries/use-weldhr-queries';
import { emptyIcon, useHrBreadcrumbs } from '../components/page-kit';
import { EmployeeAvatar, StatusBadge, formatDate } from '../components/shared';
import { CreateEmployeeDialog } from './components/create-employee-dialog';

export default function WeldHrEmployeesPage() {
  const t = useTranslations();
  useHrBreadcrumbs({ label: t('weldhr.employees.title') });
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canCreate = can('employees:create') || can('employees:manage');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<HrEmployeeListItem[]>([]);
  const [creating, setCreating] = useState(false);

  const { data: departments } = useHrDepartments();
  const departmentId = filters.find((f) => f.field === 'department')?.value;

  useEffect(() => {
    setCursor(undefined);
  }, [debouncedSearch, departmentId]);

  const params = useMemo(
    () => ({
      search: debouncedSearch || undefined,
      departmentId: departmentId || undefined,
      limit: 25,
      cursor,
    }),
    [debouncedSearch, departmentId, cursor],
  );

  const { data, isLoading, isFetching, error } = useHrEmployees(params);

  useEffect(() => {
    if (!data) return;
    setRows((prev) => (cursor ? [...prev, ...data.data] : data.data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const hasMore = data?.pagination?.hasMore ?? false;

  const filterConfigs: FilterConfig[] = [
    {
      field: 'department',
      label: t('weldhr.employees.filters.departmentLabel'),
      options: (departments ?? []).map((dep) => ({ value: dep.id, label: dep.name })),
    },
  ];

  // Employee status is a closed enum (no catch-all group needed, unlike an
  // open-ended workflow status): group so every status stays visible without
  // a separate scope toggle, the way WeldBooks groups invoices by status.
  const groups: GroupConfig<HrEmployeeListItem>[] = [
    { id: 'onboarding', label: t('weldhr.status.employee.onboarding'), sortOrder: 1, filter: (e) => e.status === 'onboarding' },
    { id: 'active', label: t('weldhr.status.employee.active'), sortOrder: 2, filter: (e) => e.status === 'active' },
    { id: 'on_leave', label: t('weldhr.status.employee.on_leave'), sortOrder: 3, filter: (e) => e.status === 'on_leave' },
    { id: 'offboarding', label: t('weldhr.status.employee.offboarding'), sortOrder: 4, filter: (e) => e.status === 'offboarding' },
    { id: 'terminated', label: t('weldhr.status.employee.terminated'), sortOrder: 5, filter: (e) => e.status === 'terminated' },
  ];

  const columns: ColumnDef<HrEmployeeListItem>[] = [
    {
      id: 'name',
      header: t('weldhr.employees.table.name'),
      width: 'flex-1',
      render: (emp) => (
        <span className="flex min-w-0 items-center gap-2">
          <EmployeeAvatar name={emp.displayName} src={emp.avatarUrl} />
          <span className="min-w-0">
            <span className="block truncate font-medium">{emp.displayName}</span>
            <span className="block truncate text-xs text-muted-foreground">{emp.email}</span>
          </span>
        </span>
      ),
    },
    {
      id: 'jobTitle',
      header: t('weldhr.employees.table.jobTitle'),
      width: 'w-[160px]',
      render: (emp) => <span className="text-muted-foreground">{emp.jobTitle ?? '—'}</span>,
    },
    {
      id: 'department',
      header: t('weldhr.employees.table.department'),
      width: 'w-[150px]',
      render: (emp) => <span className="text-muted-foreground">{emp.departmentName ?? '—'}</span>,
    },
    {
      id: 'manager',
      header: t('weldhr.employees.table.manager'),
      width: 'w-[150px]',
      render: (emp) => <span className="text-muted-foreground">{emp.managerName ?? '—'}</span>,
    },
    {
      id: 'clients',
      header: t('weldhr.employees.table.clients'),
      width: 'w-[200px]',
      render: (emp) =>
        emp.clients.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {emp.clients.map((c) => (
              <Badge key={c.companyId} variant="secondary">
                {c.companyName ?? c.companyId}
              </Badge>
            ))}
          </div>
        ),
    },
    {
      id: 'status',
      header: t('weldhr.employees.table.status'),
      width: 'w-[120px]',
      render: (emp) => <StatusBadge group="employee" status={emp.status} />,
    },
    {
      id: 'startDate',
      header: t('weldhr.employees.table.startDate'),
      width: 'w-[120px]',
      render: (emp) => <span className="text-muted-foreground">{formatDate(emp.startDate)}</span>,
    },
  ];

  const createButton = canCreate ? { label: t('weldhr.employees.newEmployee'), onClick: () => setCreating(true) } : undefined;

  return (
    <>
      <PanelEntityList<HrEmployeeListItem>
        items={rows}
        isLoading={isLoading && rows.length === 0}
        error={error as Error | null}
        columns={columns}
        groups={groups}
        onRowClick={(emp) => navigate({ to: '/weldhr/employees/$employeeId', params: { employeeId: emp.id } })}
        filters={filterConfigs}
        activeFilters={filters}
        onFiltersChange={setFilters}
        searchQuery={search}
        onSearchChange={setSearch}
        searchPlaceholder={t('weldhr.employees.searchPlaceholder')}
        createButton={createButton}
        hasMore={hasMore}
        isLoadingMore={isFetching}
        onLoadMore={() => setCursor(data?.pagination?.cursor ?? undefined)}
        emptyState={{
          icon: emptyIcon(Users),
          title: t('weldhr.employees.empty.title'),
          description: t('weldhr.employees.empty.description'),
          action: createButton,
        }}
      />

      {creating && <CreateEmployeeDialog onClose={() => setCreating(false)} />}
    </>
  );
}
