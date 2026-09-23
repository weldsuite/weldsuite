/** WeldHR employee directory: search, status/department filters, cursor-paginated table, "New employee". */

import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
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
import type { HrEmployeeListItem } from '@weldsuite/app-api-client/domains/weldhr';
import { useDebounce } from '@/hooks/use-debounce';
import { useHrDepartments, useHrEmployees } from '@/hooks/queries/use-weldhr-queries';
import {
  EmployeeAvatar,
  EmptyState,
  ErrorBanner,
  InlineSpinner,
  PageBody,
  PageHeader,
  StatusBadge,
  errorMessage,
  formatDate,
} from '../components/shared';
import { CreateEmployeeDialog } from './components/create-employee-dialog';

const ACTIVE_STATUSES = 'onboarding,active,on_leave,offboarding';

type StatusFilter = 'active' | 'all' | 'left';

export default function WeldHrEmployeesPage() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canCreate = can('employees:create') || can('employees:manage');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [departmentId, setDepartmentId] = useState<string>('all');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<HrEmployeeListItem[]>([]);
  const [creating, setCreating] = useState(false);

  const { data: departments } = useHrDepartments();

  const statusParam = statusFilter === 'active' ? ACTIVE_STATUSES : statusFilter === 'left' ? 'terminated' : undefined;

  useEffect(() => {
    setCursor(undefined);
  }, [debouncedSearch, statusParam, departmentId]);

  const params = useMemo(
    () => ({
      search: debouncedSearch || undefined,
      status: statusParam,
      departmentId: departmentId === 'all' ? undefined : departmentId,
      limit: 25,
      cursor,
    }),
    [debouncedSearch, statusParam, departmentId, cursor],
  );

  const { data, isLoading, isFetching, error } = useHrEmployees(params);

  useEffect(() => {
    if (!data) return;
    setRows((prev) => (cursor ? [...prev, ...data.data] : data.data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const hasMore = data?.pagination?.hasMore ?? false;
  const showInitialLoading = isLoading && rows.length === 0;

  return (
    <PageBody wide>
      <PageHeader
        title={t('weldhr.employees.title')}
        subtitle={t('weldhr.employees.subtitle')}
        actions={
          canCreate ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('weldhr.employees.newEmployee')}
            </Button>
          ) : undefined
        }
      />

      <ErrorBanner error={error ? errorMessage(error, t('weldhr.employees.loadFailed')) : null} />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('weldhr.employees.searchPlaceholder')}
          className="max-w-xs"
        />
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">{t('weldhr.employees.filters.statusActive')}</SelectItem>
            <SelectItem value="all">{t('weldhr.employees.filters.statusAll')}</SelectItem>
            <SelectItem value="left">{t('weldhr.employees.filters.statusLeft')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={departmentId} onValueChange={setDepartmentId}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('weldhr.employees.filters.departmentAll')}</SelectItem>
            {(departments ?? []).map((dep) => (
              <SelectItem key={dep.id} value={dep.id}>
                {dep.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {showInitialLoading ? (
        <InlineSpinner />
      ) : rows.length === 0 ? (
        <EmptyState title={t('weldhr.employees.empty.title')} description={t('weldhr.employees.empty.description')} />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('weldhr.employees.table.name')}</TableHead>
                <TableHead>{t('weldhr.employees.table.jobTitle')}</TableHead>
                <TableHead>{t('weldhr.employees.table.department')}</TableHead>
                <TableHead>{t('weldhr.employees.table.manager')}</TableHead>
                <TableHead>{t('weldhr.employees.table.clients')}</TableHead>
                <TableHead>{t('weldhr.employees.table.status')}</TableHead>
                <TableHead>{t('weldhr.employees.table.startDate')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((emp) => (
                <TableRow key={emp.id}>
                  <TableCell>
                    <Link
                      to="/weldhr/employees/$employeeId"
                      params={{ employeeId: emp.id }}
                      className="flex items-center gap-2 hover:underline"
                    >
                      <EmployeeAvatar name={emp.displayName} src={emp.avatarUrl} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{emp.displayName}</span>
                        <span className="block truncate text-xs text-muted-foreground">{emp.email}</span>
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{emp.jobTitle ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{emp.departmentName ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{emp.managerName ?? '—'}</TableCell>
                  <TableCell>
                    {emp.clients.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {emp.clients.map((c) => (
                          <Badge key={c.companyId} variant="secondary">
                            {c.companyName ?? c.companyId}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge group="employee" status={emp.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(emp.startDate)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {hasMore && (
            <div className="flex justify-center border-t p-3">
              <Button variant="outline" size="sm" disabled={isFetching} onClick={() => setCursor(data?.pagination?.cursor ?? undefined)}>
                {isFetching ? t('weldhr.common.saving') : t('weldhr.employees.loadMore')}
              </Button>
            </div>
          )}
        </div>
      )}

      {creating && <CreateEmployeeDialog onClose={() => setCreating(false)} />}
    </PageBody>
  );
}
