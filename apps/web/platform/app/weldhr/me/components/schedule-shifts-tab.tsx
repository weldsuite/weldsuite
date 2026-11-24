/** My HR → Schedule → Shifts, as a list: your shifts in the picked period, upcoming first (soonest first), then past (latest first). */

import type { ReactNode } from 'react';
import { CalendarClock } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfAttendance } from '@weldsuite/app-api-client/domains/weldhr';
import { formatClockRange, useTimeFormat } from '@/app/weldcalendar/lib/calendar-format';
import { useObjectPanel } from '@/components/object-panel';
import { MY_SHIFT_PANEL_TYPE } from '@/components/objects/hr-my-hr/types';
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
import { listLoadError, formatWeekdayDate } from '../../components/shared';
import { PeriodSelect, periodRange, type MyPeriod } from './schedule-period';

export type MyShift = HrSelfAttendance['shifts'][number];

/** Planned hours: the shift's length minus its (unpaid) break, as "8.5". */
export function plannedHours(shift: MyShift): string {
  const length = new Date(shift.endsAt).getTime() - new Date(shift.startsAt).getTime();
  const pause =
    shift.breakStartsAt && shift.breakEndsAt ? new Date(shift.breakEndsAt).getTime() - new Date(shift.breakStartsAt).getTime() : 0;
  return String(Math.round((Math.max(0, length - Math.max(0, pause)) / 3_600_000) * 10) / 10);
}

/** Still to come (or running now) rather than over. */
function isUpcoming(shift: MyShift, now: number): boolean {
  return new Date(shift.endsAt).getTime() >= now;
}

export function MyShiftsList({
  period,
  onPeriodChange,
  viewToggle,
}: Readonly<{
  period: MyPeriod;
  onPeriodChange: (period: MyPeriod) => void;
  /** The list / calendar switch, next to the Filter button. */
  viewToggle?: ReactNode;
}>) {
  const t = useTranslations();
  const timeFormat = useTimeFormat();
  const { data, isLoading, error } = useMyHrAttendance(periodRange(period));
  const { open: openPanel } = useObjectPanel();
  const now = Date.now();

  // Upcoming soonest first, then past latest first: the groups keep this order.
  const shifts = [...(data?.shifts ?? [])].sort((a, b) => {
    const aUp = isUpcoming(a, now);
    const bUp = isUpcoming(b, now);
    if (aUp !== bUp) return aUp ? -1 : 1;
    return aUp ? a.startsAt.localeCompare(b.startsAt) : b.startsAt.localeCompare(a.startsAt);
  });

  const groups: GroupConfig<MyShift>[] = [
    { id: 'upcoming', label: t('weldhr.me.schedule.groups.upcoming'), sortOrder: 1, filter: (s) => isUpcoming(s, now) },
    { id: 'past', label: t('weldhr.me.schedule.groups.past'), sortOrder: 2, filter: (s) => !isUpcoming(s, now) },
  ];

  const clients = [...new Set(shifts.map((s) => s.companyName).filter((name): name is string => !!name))].sort((a, b) => a.localeCompare(b));
  const filters: FilterConfig[] = [
    {
      field: 'when',
      label: t('weldhr.me.schedule.filters.when'),
      operators: ['is'],
      options: [
        { value: 'upcoming', label: t('weldhr.me.schedule.groups.upcoming') },
        { value: 'past', label: t('weldhr.me.schedule.groups.past') },
      ],
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

  const applyFilters = (rows: MyShift[], active: ActiveFilter[]) =>
    active.reduce((list, filter) => {
      if (!filter.value) return list;
      if (filter.field === 'when') return list.filter((s) => isUpcoming(s, now) === (filter.value === 'upcoming'));
      if (filter.field === 'client') return list.filter((s) => s.companyName === filter.value);
      return list;
    }, rows);

  const timeRange = (s: MyShift) => formatClockRange(new Date(s.startsAt), new Date(s.endsAt), timeFormat);

  const columns: ColumnDef<MyShift>[] = [
    {
      id: 'date',
      header: t('weldhr.me.schedule.table.date'),
      width: HR_COL.main,
      render: (s) => (
        <div className="min-w-0">
          <p className="truncate font-medium tabular-nums">{formatWeekdayDate(s.startsAt)}</p>
          {/* What the hidden columns would show, once the list is too narrow for them. */}
          <p className="truncate text-xs text-muted-foreground tabular-nums @lg:hidden">
            {[timeRange(s), s.workType].filter(Boolean).join(' · ')}
          </p>
        </div>
      ),
    },
    {
      id: 'time',
      header: t('weldhr.me.schedule.table.time'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[170px]'),
      render: (s) => <span className="block truncate tabular-nums">{timeRange(s)}</span>,
    },
    {
      id: 'hours',
      header: t('weldhr.me.schedule.table.hours'),
      width: cn(HR_COL.fixed, HR_COL.hideMd, 'w-[80px]'),
      render: (s) => <span className="tabular-nums">{plannedHours(s)}</span>,
    },
    {
      id: 'workType',
      header: t('weldhr.me.schedule.table.workType'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[150px]'),
      render: (s) => <span className="block truncate">{s.workType ?? '—'}</span>,
    },
    {
      id: 'client',
      header: t('weldhr.me.schedule.table.client'),
      width: cn(HR_COL.fixed, HR_COL.hideXl, 'w-[170px]'),
      render: (s) => <span className="block truncate text-muted-foreground">{s.companyName ?? '—'}</span>,
    },
  ];

  return (
    <HrListContainer>
      <PanelEntityList<MyShift>
        items={shifts}
        isLoading={isLoading}
        error={listLoadError(data, error, t('weldhr.me.attendance.loadFailed'))}
        columns={columns}
        onRowClick={(s) => openPanel({ type: MY_SHIFT_PANEL_TYPE, id: s.id })}
        objectPanel={{ type: MY_SHIFT_PANEL_TYPE }}
        groups={groups}
        filters={filters}
        applyFilters={applyFilters}
        searchFields={['workType', 'companyName', 'notes']}
        searchPlaceholder={t('weldhr.me.schedule.search.shifts')}
        // The period sits with the filter, not beside the search: on a phone the left side gets
        // its own row, so the search box keeps its full width.
        leftActionButtons={
          <>
            {viewToggle}
            <PeriodSelect value={period} onChange={onPeriodChange} />
          </>
        }
        emptyState={{
          icon: emptyIcon(CalendarClock),
          title: t('weldhr.me.schedule.empty.shifts.title'),
          description: t('weldhr.me.schedule.empty.shifts.description'),
        }}
      />
    </HrListContainer>
  );
}
