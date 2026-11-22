/** My HR → Time off → Balances: one row per leave type with its allowance, use and what is left. */

import { Scale } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrLeaveBalance } from '@weldsuite/app-api-client/domains/weldhr';
import { useObjectPanel } from '@/components/object-panel';
import { MY_LEAVE_BALANCE_PANEL_TYPE } from '@/components/objects/hr-my-time-off/types';
import { PanelEntityList, type ActiveFilter, type ColumnDef, type FilterConfig } from '@/components/panel-entity-list';
import { useMyHrLeave } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { HR_COL, HrListContainer, emptyIcon } from '../../components/page-kit';
import { ColorDot } from './shared';

type BalanceRow = HrLeaveBalance & { id: string };

export function MyLeaveBalancesList() {
  const t = useTranslations();
  const { data, isLoading, error } = useMyHrLeave();
  const { open: openPanel } = useObjectPanel();
  const rows: BalanceRow[] = (data?.balances ?? []).map((b) => ({ ...b, id: b.leaveTypeId }));
  const days = (value: number | null) => (value === null ? t('weldhr.me.leave.balances.unlimited') : value);

  const filters: FilterConfig[] = [
    {
      field: 'pay',
      label: t('weldhr.me.timeOff.filters.pay'),
      operators: ['is'],
      options: [
        { value: 'paid', label: t('weldhr.me.timeOff.filters.paid') },
        { value: 'unpaid', label: t('weldhr.me.timeOff.filters.unpaid') },
      ],
    },
  ];

  const applyFilters = (list: BalanceRow[], active: ActiveFilter[]) =>
    active.reduce(
      (rowsLeft, filter) =>
        filter.field === 'pay' && filter.value ? rowsLeft.filter((b) => b.isPaid === (filter.value === 'paid')) : rowsLeft,
      list,
    );

  const columns: ColumnDef<BalanceRow>[] = [
    {
      id: 'type',
      header: t('weldhr.me.timeOff.balances.type'),
      width: HR_COL.main,
      render: (b) => (
        <div className="min-w-0">
          <p className="flex min-w-0 items-center gap-1.5">
            <ColorDot color={b.color} />
            <span className="truncate font-medium">{b.name}</span>
          </p>
          {/* What the hidden columns would show, once the list is too narrow for them. */}
          <p className="truncate text-xs text-muted-foreground @lg:hidden">
            {t('weldhr.me.timeOff.balances.remaining')}: {days(b.remaining)}
          </p>
        </div>
      ),
    },
    {
      id: 'allowance',
      header: t('weldhr.me.timeOff.balances.allowance'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[110px]'),
      render: (b) => <span className="tabular-nums">{days(b.allowance)}</span>,
    },
    {
      id: 'used',
      header: t('weldhr.me.timeOff.balances.used'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[90px]'),
      render: (b) => <span className="tabular-nums">{b.used}</span>,
    },
    {
      id: 'pending',
      header: t('weldhr.me.timeOff.balances.pending'),
      width: cn(HR_COL.fixed, HR_COL.hideMd, 'w-[90px]'),
      render: (b) => <span className={cn('tabular-nums', b.pending === 0 && 'text-muted-foreground')}>{b.pending}</span>,
    },
    {
      id: 'remaining',
      header: t('weldhr.me.timeOff.balances.remaining'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[110px]'),
      render: (b) => <span className="font-medium tabular-nums">{days(b.remaining)}</span>,
    },
  ];

  return (
    <HrListContainer>
      <PanelEntityList<BalanceRow>
        items={rows}
        isLoading={isLoading}
        error={data ? null : (error as Error | null)}
        columns={columns}
        onRowClick={(b) => openPanel({ type: MY_LEAVE_BALANCE_PANEL_TYPE, id: b.id })}
        objectPanel={{ type: MY_LEAVE_BALANCE_PANEL_TYPE }}
        filters={filters}
        applyFilters={applyFilters}
        searchFields={['name']}
        searchPlaceholder={t('weldhr.me.timeOff.search.balances')}
        emptyState={{
          icon: emptyIcon(Scale),
          title: t('weldhr.me.leave.balances.empty'),
          description: t('weldhr.me.timeOff.empty.balances'),
        }}
      />
    </HrListContainer>
  );
}
