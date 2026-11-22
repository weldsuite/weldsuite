/**
 * My HR → Expenses → Payouts: what is still to come (awaiting a decision, and
 * approved but not yet paid out) and what was paid out to you, per month. A row
 * opens the Declarations tab on the declarations behind it.
 */

import { Wallet } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfDeclaration } from '@weldsuite/app-api-client/domains/weldhr';
import {
  PanelEntityList,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/panel-entity-list';
import { useMyHrDeclarations } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { HR_COL, HrListContainer, emptyIcon } from '../../components/page-kit';
import { formatMoney, formatMonth } from '../../components/shared';
import { paidMonthOf } from './declarations-tab';

type PayoutKind = 'pending' | 'approved' | 'paid';

interface PayoutRow {
  id: string;
  kind: PayoutKind;
  /** `YYYY-MM` of a paid-out row. */
  month: string | null;
  count: number;
  /** Amount per currency. */
  amounts: Map<string, number>;
}

/** A row with the name it shows, for the search. */
type ListedPayoutRow = PayoutRow & { label: string };

const KINDS: PayoutKind[] = ['pending', 'approved', 'paid'];

function emptyRow(id: string, kind: PayoutKind, month: string | null): PayoutRow {
  return { id, kind, month, count: 0, amounts: new Map() };
}

/** The two "still to come" rows (always there, so nothing to come shows as such), then a row per payout month, newest first. */
export function payoutRows(declarations: HrSelfDeclaration[]): PayoutRow[] {
  const outstanding = { pending: emptyRow('pending', 'pending', null), approved: emptyRow('approved', 'approved', null) };
  const months = new Map<string, PayoutRow>();
  for (const declaration of declarations) {
    let row: PayoutRow | undefined;
    if (declaration.status === 'pending' || declaration.status === 'approved') {
      row = outstanding[declaration.status];
    } else {
      const month = paidMonthOf(declaration);
      if (month === null) continue;
      row = months.get(month) ?? emptyRow(`paid:${month}`, 'paid', month);
      months.set(month, row);
    }
    row.count += 1;
    // In cents, so the sums don't pick up floating-point dust.
    row.amounts.set(declaration.currency, (row.amounts.get(declaration.currency) ?? 0) + Math.round(declaration.amount * 100));
  }
  const paid = [...months.values()].sort((a, b) => (b.month ?? '').localeCompare(a.month ?? ''));
  return [outstanding.pending, outstanding.approved, ...paid];
}

/** "€118.50", or one amount per currency: "€118.50 · $20.00"; a dash for nothing. */
function formatAmounts(amounts: Map<string, number>): string {
  const parts = [...amounts.entries()].filter(([, cents]) => cents !== 0).map(([currency, cents]) => formatMoney(cents / 100, currency));
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function sumAmounts(rows: PayoutRow[]): Map<string, number> {
  const total = new Map<string, number>();
  for (const row of rows) {
    for (const [currency, cents] of row.amounts) total.set(currency, (total.get(currency) ?? 0) + cents);
  }
  return total;
}

/** The Declarations tab's filters that show the declarations behind a row. */
export function payoutFilters(row: PayoutRow): ActiveFilter[] {
  return row.kind === 'paid'
    ? [{ id: 'paidMonth', field: 'paidMonth', operator: 'is', value: row.month ?? '' }]
    : [{ id: 'status', field: 'status', operator: 'is', value: row.kind }];
}

export function MyPayoutsList({
  onOpenRow,
  onNewDeclaration,
}: Readonly<{
  /** Opens the Declarations tab on this row's declarations. */
  onOpenRow: (row: PayoutRow) => void;
  /** Undefined when the workspace turned declarations off. */
  onNewDeclaration?: () => void;
}>) {
  const t = useTranslations();
  const { data, isLoading, error } = useMyHrDeclarations();
  const declarations = data?.declarations ?? [];
  const label = (row: PayoutRow) =>
    row.kind === 'paid' ? formatMonth(row.month ?? '') : t(`weldhr.me.declarations.groups.${row.kind}`);
  // Nothing declared yet: the empty state, rather than two empty "still to come" rows.
  const rows: ListedPayoutRow[] =
    declarations.length > 0 ? payoutRows(declarations).map((row) => ({ ...row, label: label(row) })) : [];
  const years = [...new Set(rows.map((row) => row.month?.slice(0, 4)).filter((y): y is string => !!y))].sort().reverse();

  const kindLabel = (kind: PayoutKind) =>
    kind === 'paid' ? t('weldhr.me.declarations.payouts.groups.paid') : t(`weldhr.me.declarations.groups.${kind}`);
  const filters: FilterConfig[] = [
    {
      field: 'kind',
      label: t('weldhr.me.declarations.payouts.filters.status'),
      operators: ['is'],
      options: KINDS.map((kind) => ({ value: kind, label: kindLabel(kind) })),
    },
    ...(years.length > 0
      ? [
          {
            field: 'year',
            label: t('weldhr.me.declarations.payouts.filters.year'),
            operators: ['is'],
            options: years.map((year) => ({ value: year, label: year })),
          },
        ]
      : []),
  ];

  // A year narrows to what was paid out in it; what is still to come has no year yet.
  const applyFilters = (list: ListedPayoutRow[], active: ActiveFilter[]) =>
    active.reduce((rowsLeft, filter) => {
      if (!filter.value) return rowsLeft;
      if (filter.field === 'kind') return rowsLeft.filter((row) => row.kind === filter.value);
      if (filter.field === 'year') return rowsLeft.filter((row) => row.month?.startsWith(`${filter.value}-`));
      return rowsLeft;
    }, list);

  const groupTotal = (kinds: PayoutKind[]) => {
    const amount = formatAmounts(sumAmounts(rows.filter((row) => kinds.includes(row.kind))));
    return amount === '—' ? undefined : <span className="text-xs text-muted-foreground tabular-nums">{amount}</span>;
  };

  const groups: GroupConfig<ListedPayoutRow>[] = [
    {
      id: 'outstanding',
      label: t('weldhr.me.declarations.payouts.groups.outstanding'),
      sortOrder: 1,
      filter: (row) => row.kind !== 'paid',
      rightContent: groupTotal(['pending', 'approved']),
    },
    {
      id: 'paid',
      label: t('weldhr.me.declarations.payouts.groups.paid'),
      sortOrder: 2,
      filter: (row) => row.kind === 'paid',
      rightContent: groupTotal(['paid']),
    },
  ];

  const columns: ColumnDef<ListedPayoutRow>[] = [
    {
      id: 'payout',
      header: t('weldhr.me.declarations.payouts.table.payout'),
      width: HR_COL.main,
      render: (row) => <span className={cn('block truncate font-medium', row.count === 0 && 'text-muted-foreground')}>{row.label}</span>,
    },
    {
      id: 'count',
      header: t('weldhr.me.declarations.payouts.table.count'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[120px]'),
      render: (row) => <span className={cn('tabular-nums', row.count === 0 && 'text-muted-foreground')}>{row.count}</span>,
    },
    {
      id: 'amount',
      header: t('weldhr.me.declarations.payouts.table.amount'),
      width: cn(HR_COL.fixed, 'w-[160px]'),
      render: (row) => (
        <span className={cn('block truncate tabular-nums', row.count === 0 ? 'text-muted-foreground' : 'font-medium')}>
          {formatAmounts(row.amounts)}
        </span>
      ),
    },
  ];

  const newButton = onNewDeclaration
    ? { label: t('weldhr.me.declarations.newDeclaration'), onClick: onNewDeclaration }
    : undefined;

  return (
    <HrListContainer>
      <PanelEntityList<ListedPayoutRow>
        items={rows}
        isLoading={isLoading}
        error={data ? null : (error as Error | null)}
        columns={columns}
        onRowClick={onOpenRow}
        groups={groups}
        filters={filters}
        applyFilters={applyFilters}
        searchFields={['label']}
        searchPlaceholder={t('weldhr.me.declarations.payouts.searchPlaceholder')}
        createButton={newButton}
        emptyState={{
          icon: emptyIcon(Wallet),
          title: t('weldhr.me.declarations.payouts.empty.title'),
          description: t('weldhr.me.declarations.payouts.empty.description'),
          action: newButton,
        }}
      />
    </HrListContainer>
  );
}
