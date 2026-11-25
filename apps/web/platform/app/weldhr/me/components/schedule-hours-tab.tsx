/** My HR → Schedule → Hours: your clock records in the picked period, the ones still awaiting approval first, latest day first. */

import { Clock } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfAttendance } from '@weldsuite/app-api-client/domains/weldhr';
import { useObjectPanel } from '@/components/object-panel';
import { MY_ATTENDANCE_PANEL_TYPE } from '@/components/objects/hr-my-hr/types';
import {
  PanelEntityList,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/panel-entity-list';
import { useMyHrAttendance } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { HR_COL, HrListContainer, emptyIcon } from '../../components/page-kit';
import { StatusBadge, listLoadError, formatMinutes, formatWeekdayDate, useFormatTime } from '../../components/shared';
import { PeriodSelect, periodRange, type MyPeriod } from './schedule-period';

export type MyAttendanceRecord = HrSelfAttendance['records'][number];

/** The status badge, and how late when late. */
export function RecordStatus({ record }: Readonly<{ record: MyAttendanceRecord }>) {
  const t = useTranslations();
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <StatusBadge group="attendance" status={record.status} />
      {record.lateMinutes !== null && record.lateMinutes > 0 && (
        <span className="truncate text-xs text-muted-foreground">{t('weldhr.me.attendance.lateBy', { minutes: record.lateMinutes })}</span>
      )}
    </span>
  );
}

export function MyHoursList({ period, onPeriodChange }: Readonly<{ period: MyPeriod; onPeriodChange: (period: MyPeriod) => void }>) {
  const t = useTranslations();
  const formatTime = useFormatTime();
  const { data, isLoading, error } = useMyHrAttendance(periodRange(period));
  const { open: openPanel } = useObjectPanel();
  const records = [...(data?.records ?? [])].sort((a, b) => b.date.localeCompare(a.date));

  const groups: GroupConfig<MyAttendanceRecord>[] = [
    {
      id: 'awaiting',
      label: t('weldhr.me.schedule.groups.awaitingApproval'),
      sortOrder: 1,
      filter: (r) => !r.approved,
    },
    { id: 'approved', label: t('weldhr.me.schedule.groups.approved'), sortOrder: 2, filter: (r) => r.approved },
  ];

  const statuses = [...new Set(records.map((r) => r.status))];
  const clients = [...new Set(records.map((r) => r.companyName).filter((name): name is string => !!name))].sort((a, b) => a.localeCompare(b));
  const filters: FilterConfig[] = [
    {
      field: 'status',
      label: t('weldhr.me.schedule.filters.status'),
      operators: ['is'],
      options: statuses.map((status) => ({ value: status, label: t(`weldhr.status.attendance.${status}`) })),
    },
    ...(clients.length > 0
      ? [
          {
            field: 'client',
            label: t('weldhr.me.schedule.filters.client'),
            operators: ['is'],
            options: clients.map((name) => ({ value: name, label: name })),
          },
        ]
      : []),
  ];

  const applyFilters = (rows: MyAttendanceRecord[], active: ActiveFilter[]) =>
    active.reduce((list, filter) => {
      if (!filter.value) return list;
      if (filter.field === 'status') return list.filter((r) => r.status === filter.value);
      if (filter.field === 'client') return list.filter((r) => r.companyName === filter.value);
      return list;
    }, rows);

  const columns: ColumnDef<MyAttendanceRecord>[] = [
    {
      id: 'date',
      header: t('weldhr.me.attendance.table.date'),
      width: HR_COL.main,
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate font-medium tabular-nums">{formatWeekdayDate(r.date)}</p>
          {/* What the hidden columns would show, once the list is too narrow for them. */}
          <p className="truncate text-xs text-muted-foreground tabular-nums @lg:hidden">
            {formatTime(r.clockIn)} – {formatTime(r.clockOut)} · {formatMinutes(r.workedMinutes)}
          </p>
        </div>
      ),
    },
    {
      id: 'clockIn',
      header: t('weldhr.me.attendance.table.clockIn'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[90px]'),
      render: (r) => <span className={cn('tabular-nums', !r.clockIn && 'text-muted-foreground')}>{formatTime(r.clockIn)}</span>,
    },
    {
      id: 'clockOut',
      header: t('weldhr.me.attendance.table.clockOut'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[90px]'),
      render: (r) => <span className={cn('tabular-nums', !r.clockOut && 'text-muted-foreground')}>{formatTime(r.clockOut)}</span>,
    },
    {
      id: 'break',
      header: t('weldhr.me.attendance.table.break'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[80px]'),
      render: (r) => <span className="tabular-nums text-muted-foreground">{formatMinutes(r.breakMinutes)}</span>,
    },
    {
      id: 'worked',
      header: t('weldhr.me.attendance.table.worked'),
      width: cn(HR_COL.fixed, HR_COL.hideMd, 'w-[90px]'),
      render: (r) => <span className="font-medium tabular-nums">{formatMinutes(r.workedMinutes)}</span>,
    },
    {
      id: 'status',
      header: t('weldhr.me.attendance.table.status'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[170px]'),
      render: (r) => <RecordStatus record={r} />,
    },
    {
      id: 'client',
      header: t('weldhr.me.attendance.table.client'),
      width: cn(HR_COL.fixed, HR_COL.hideXl, 'w-[160px]'),
      render: (r) => <span className="block truncate text-muted-foreground">{r.companyName ?? '—'}</span>,
    },
  ];

  return (
    <HrListContainer>
      <PanelEntityList<MyAttendanceRecord>
        items={records}
        isLoading={isLoading}
        error={listLoadError(data, error, t('weldhr.me.attendance.loadFailed'))}
        columns={columns}
        onRowClick={(r) => openPanel({ type: MY_ATTENDANCE_PANEL_TYPE, id: r.id })}
        objectPanel={{ type: MY_ATTENDANCE_PANEL_TYPE }}
        groups={groups}
        filters={filters}
        applyFilters={applyFilters}
        searchFields={['companyName', 'notes']}
        searchPlaceholder={t('weldhr.me.schedule.search.hours')}
        // With the filter, as on the Shifts tab, so a phone's search box keeps its full width.
        leftActionButtons={<PeriodSelect value={period} onChange={onPeriodChange} />}
        emptyState={{
          icon: emptyIcon(Clock),
          title: t('weldhr.me.schedule.empty.hours.title'),
          description: t('weldhr.me.schedule.empty.hours.description'),
        }}
      />
    </HrListContainer>
  );
}
