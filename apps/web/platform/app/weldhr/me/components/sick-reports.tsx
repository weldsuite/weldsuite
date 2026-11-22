/** My HR → Time off → Sick reports: the one still open and the earlier ones, reporting sick and reporting recovered. */

import { useState } from 'react';
import { HeartPulse } from 'lucide-react';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfAbsence } from '@weldsuite/app-api-client/domains/weldhr';
import {
  PanelEntityList,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/panel-entity-list';
import { useObjectPanel } from '@/components/object-panel';
import { MY_SICK_REPORT_PANEL_TYPE } from '@/components/objects/hr-my-time-off/types';
import { useMyHrAbsences } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { AbsenceDialog } from '../../absenteeism/components/absence-dialog';
import { RecoverDialog } from '../../absenteeism/components/recover-dialog';
import { formatDays } from '../../absenteeism/components/shared';
import { HR_COL, HrListContainer, emptyIcon } from '../../components/page-kit';
import { StatusBadge, formatDate } from '../../components/shared';

export function MySickReportsList() {
  const t = useTranslations();
  const { data, isLoading, error } = useMyHrAbsences();
  const { open: openPanel } = useObjectPanel();
  const [reporting, setReporting] = useState(false);
  const [recovering, setRecovering] = useState<HrSelfAbsence | null>(null);

  const current = data?.current ?? null;
  const reports = data ? [...(current ? [current] : []), ...data.history.filter((r) => r.id !== current?.id)] : [];

  const groups: GroupConfig<HrSelfAbsence>[] = [
    { id: 'ongoing', label: t('weldhr.absenteeism.tabs.ongoing'), sortOrder: 1, filter: (r) => r.status === 'ongoing' },
    { id: 'completed', label: t('weldhr.absenteeism.tabs.completed'), sortOrder: 2, filter: (r) => r.status !== 'ongoing' },
  ];

  const filters: FilterConfig[] = [
    {
      field: 'status',
      label: t('weldhr.me.timeOff.filters.status'),
      operators: ['is'],
      options: (['ongoing', 'completed'] as const).map((status) => ({ value: status, label: t(`weldhr.status.absence.${status}`) })),
    },
  ];

  const applyFilters = (list: HrSelfAbsence[], active: ActiveFilter[]) =>
    active.reduce(
      (rowsLeft, filter) =>
        filter.field === 'status' && filter.value ? rowsLeft.filter((r) => r.status === filter.value) : rowsLeft,
      list,
    );

  const columns: ColumnDef<HrSelfAbsence>[] = [
    {
      id: 'firstDay',
      header: t('weldhr.absenteeism.table.firstSickDay'),
      width: HR_COL.main,
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate font-medium tabular-nums">
            {formatDate(r.startDate)}
            {r.firstDay === 'half' && (
              <span className="font-normal text-muted-foreground"> · {t('weldhr.absenteeism.halfFirstDay')}</span>
            )}
          </p>
          {/* What the hidden columns would show, once the list is too narrow for them. */}
          <p className="truncate text-xs text-muted-foreground @lg:hidden">
            {r.endDate ? formatDate(r.endDate) : t('weldhr.absenteeism.stillAbsent')} · {formatDays(r.days)}
          </p>
        </div>
      ),
    },
    {
      id: 'lastDay',
      header: t('weldhr.absenteeism.table.lastSickDay'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[140px]'),
      render: (r) => (
        <span className={cn('block truncate tabular-nums', !r.endDate && 'text-muted-foreground')}>
          {r.endDate ? formatDate(r.endDate) : t('weldhr.absenteeism.stillAbsent')}
        </span>
      ),
    },
    {
      id: 'days',
      header: t('weldhr.absenteeism.table.days'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[70px]'),
      render: (r) => <span className="tabular-nums">{formatDays(r.days)}</span>,
    },
    {
      id: 'status',
      header: t('weldhr.absenteeism.table.status'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[110px]'),
      render: (r) => <StatusBadge group="absence" status={r.status} />,
    },
  ];

  // Reported sick: the button reports you recovered; otherwise it reports you sick.
  const statusButton = current
    ? { label: t('weldhr.absenteeism.reportRecovered'), onClick: () => setRecovering(current) }
    : { label: t('weldhr.absenteeism.reportSick'), onClick: () => setReporting(true) };

  return (
    <>
      <HrListContainer>
        <PanelEntityList<HrSelfAbsence>
          items={reports}
          isLoading={isLoading}
          error={data ? null : (error as Error | null)}
          columns={columns}
          onRowClick={(r) => openPanel({ type: MY_SICK_REPORT_PANEL_TYPE, id: r.id })}
          objectPanel={{ type: MY_SICK_REPORT_PANEL_TYPE }}
          // The row's "⋮" menu (on hover): only the open report can be reported recovered.
          rowMenu={(r) =>
            r.id === current?.id ? (
              <DropdownMenuItem onClick={() => setRecovering(r)}>
                <HeartPulse />
                {t('weldhr.absenteeism.reportRecovered')}
              </DropdownMenuItem>
            ) : null
          }
          groups={groups}
          filters={filters}
          applyFilters={applyFilters}
          searchFields={['note', 'startDate', 'endDate']}
          searchPlaceholder={t('weldhr.me.timeOff.search.sick')}
          createButton={statusButton}
          emptyState={{
            icon: emptyIcon(HeartPulse),
            title: t('weldhr.absenteeism.mine.well.title'),
            description: t('weldhr.absenteeism.mine.history.empty'),
            action: statusButton,
          }}
        />
      </HrListContainer>

      {reporting && <AbsenceDialog mode={{ kind: 'self' }} onClose={() => setReporting(false)} />}
      {recovering && <RecoverDialog absence={recovering} self onClose={() => setRecovering(null)} />}
    </>
  );
}
