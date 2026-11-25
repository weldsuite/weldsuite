/**
 * My HR → Expenses → Declarations: your expense declarations as a list grouped
 * by status (the open amounts on the group headers), downloading a receipt and
 * withdrawing a declaration from the row menu, and its details panel. The page
 * holds the filters, so the Payouts tab can open this list filtered.
 */

import { Fragment, useState } from 'react';
import { toast } from 'sonner';
import { Download, Paperclip, ReceiptText, Undo2 } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfDeclaration } from '@weldsuite/app-api-client/domains/weldhr';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenuItem, DropdownMenuSeparator } from '@weldsuite/ui/components/dropdown-menu';
import { useObjectPanel } from '@/components/object-panel';
import { MY_DECLARATION_PANEL_TYPE } from '@/components/objects/hr-my-hr/types';
import {
  PanelEntityList,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/panel-entity-list';
import {
  useMyHrCancelDeclaration,
  useMyHrDeclarations,
  useMyHrOpenDeclarationReceipt,
} from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { HR_COL, HrListContainer, emptyIcon } from '../../components/page-kit';
import { StatusBadge, errorMessage, formatDate, formatMoney, formatMonth } from '../../components/shared';

const STATUSES = ['pending', 'approved', 'paid', 'rejected', 'cancelled'] as const;
const KNOWN_STATUSES = new Set<string>(STATUSES);
const CATEGORIES = ['travel', 'meals', 'accommodation', 'equipment', 'training', 'other'] as const;

/** The month a paid declaration was paid out in, as `YYYY-MM` in local time; null while not paid. */
export function paidMonthOf(declaration: HrSelfDeclaration): string | null {
  if (declaration.status !== 'paid') return null;
  // A paid declaration has `paidAt`; the review date stands in should it be missing.
  const at = new Date(declaration.paidAt ?? declaration.reviewedAt ?? declaration.createdAt);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;
}

/** Narrows the declarations to the filters picked in the list. */
export function filterDeclarations(rows: HrSelfDeclaration[], active: ActiveFilter[]): HrSelfDeclaration[] {
  return active.reduce((list, filter) => {
    if (!filter.value) return list;
    if (filter.field === 'status') return list.filter((d) => d.status === filter.value);
    if (filter.field === 'category') return list.filter((d) => d.category === filter.value);
    if (filter.field === 'paidMonth') return list.filter((d) => paidMonthOf(d) === filter.value);
    return list;
  }, rows);
}

/** Only a declaration that still waits for a decision can be withdrawn (as the server). */
export function isWithdrawable(declaration: HrSelfDeclaration): boolean {
  return declaration.status === 'pending';
}

/** Downloads a declaration's receipt, with a toast when that fails. */
export function useDownloadMyReceipt() {
  const t = useTranslations();
  const openReceipt = useMyHrOpenDeclarationReceipt();
  return {
    isPending: openReceipt.isPending,
    download: (declaration: HrSelfDeclaration) =>
      openReceipt.mutate(declaration, {
        onError: (err) => toast.error(errorMessage(err, t('weldhr.me.declarations.list.receiptFailed'))),
      }),
  };
}

export function MyDeclarationsList({
  canSubmit,
  onNewDeclaration,
  activeFilters,
  onFiltersChange,
}: Readonly<{
  canSubmit: boolean;
  onNewDeclaration: () => void;
  activeFilters: ActiveFilter[];
  onFiltersChange: (filters: ActiveFilter[]) => void;
}>) {
  const t = useTranslations();
  const { data, isLoading, error } = useMyHrDeclarations();
  const cancelDeclaration = useMyHrCancelDeclaration();
  const receipt = useDownloadMyReceipt();
  const { open: openPanel } = useObjectPanel();
  const [withdrawTarget, setWithdrawTarget] = useState<HrSelfDeclaration | null>(null);

  async function confirmWithdraw(declaration: HrSelfDeclaration) {
    try {
      await cancelDeclaration.mutateAsync(declaration.id);
      toast.success(t('weldhr.me.declarations.withdrawConfirm.toast'));
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.me.declarations.withdrawConfirm.failed')));
    } finally {
      setWithdrawTarget(null);
    }
  }

  // What is still to come, per currency, on the header of its group.
  const openTotal = (field: 'pending' | 'approved') => {
    const amounts = (data?.open ?? []).filter((o) => o[field] > 0).map((o) => formatMoney(o[field], o.currency));
    return amounts.length > 0 ? (
      <span className="text-xs text-muted-foreground tabular-nums">{amounts.join(' · ')}</span>
    ) : undefined;
  };

  const groups: GroupConfig<HrSelfDeclaration>[] = [
    {
      id: 'pending',
      label: t('weldhr.me.declarations.groups.pending'),
      sortOrder: 1,
      filter: (d) => d.status === 'pending',
      rightContent: openTotal('pending'),
    },
    {
      id: 'approved',
      label: t('weldhr.me.declarations.groups.approved'),
      sortOrder: 2,
      filter: (d) => d.status === 'approved',
      rightContent: openTotal('approved'),
    },
    { id: 'paid', label: t('weldhr.declarations.groups.paid'), sortOrder: 3, filter: (d) => d.status === 'paid' },
    {
      id: 'rejectedCancelled',
      label: t('weldhr.declarations.groups.rejectedCancelled'),
      sortOrder: 4,
      filter: (d) => d.status === 'rejected' || d.status === 'cancelled',
    },
    { id: 'other', label: t('weldhr.declarations.groups.other'), sortOrder: 5, filter: (d) => !KNOWN_STATUSES.has(d.status) },
  ];

  const filters: FilterConfig[] = [
    {
      field: 'status',
      label: t('weldhr.me.declarations.list.table.status'),
      operators: ['is'],
      options: STATUSES.map((status) => ({ value: status, label: t(`weldhr.status.declaration.${status}`) })),
    },
    {
      field: 'category',
      label: t('weldhr.me.declarations.list.table.category'),
      operators: ['is'],
      options: CATEGORIES.map((category) => ({ value: category, label: t(`weldhr.declarations.category.${category}`) })),
    },
  ];

  const declarations = data?.declarations ?? [];
  const paidMonths = [...new Set(declarations.map(paidMonthOf).filter((m): m is string => m !== null))].sort((a, b) => a.localeCompare(b)).reverse();
  if (paidMonths.length > 0) {
    filters.push({
      field: 'paidMonth',
      label: t('weldhr.me.declarations.list.filters.paidMonth'),
      operators: ['is'],
      options: paidMonths.map((month) => ({ value: month, label: formatMonth(month) })),
    });
  }

  const columns: ColumnDef<HrSelfDeclaration>[] = [
    {
      id: 'description',
      header: t('weldhr.me.declarations.list.table.description'),
      width: HR_COL.main,
      render: (d) => (
        <div className="min-w-0">
          <p className="truncate font-medium" title={d.description}>
            {d.description}
          </p>
          {/* What the hidden columns would show, once the list is too narrow for them. */}
          <p className="truncate text-xs text-muted-foreground @lg:hidden">
            {formatDate(d.expenseDate)} · {formatMoney(d.amount, d.currency)}
          </p>
          <div className="mt-1 @lg:hidden">
            <StatusBadge group="declaration" status={d.status} />
          </div>
        </div>
      ),
    },
    {
      id: 'category',
      header: t('weldhr.me.declarations.list.table.category'),
      width: cn(HR_COL.fixed, HR_COL.hideMd, 'w-[130px]'),
      render: (d) => <span className="block truncate">{t(`weldhr.declarations.category.${d.category}`)}</span>,
    },
    {
      id: 'date',
      header: t('weldhr.me.declarations.list.table.date'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[110px]'),
      render: (d) => <span className="tabular-nums">{formatDate(d.expenseDate)}</span>,
    },
    {
      id: 'amount',
      header: t('weldhr.me.declarations.list.table.amount'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[110px]'),
      render: (d) => <span className="font-medium tabular-nums">{formatMoney(d.amount, d.currency)}</span>,
    },
    {
      id: 'receipt',
      header: t('weldhr.me.declarations.list.table.receipt'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[60px]'),
      // A sign that there is one; downloading it is in the row menu and the panel.
      render: (d) =>
        d.hasReceipt ? (
          <span title={d.receiptFileName ?? undefined}>
            <Paperclip className="h-3.5 w-3.5 text-muted-foreground" aria-label={t('weldhr.me.declarations.list.table.receipt')} />
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'status',
      header: t('weldhr.me.declarations.list.table.status'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[110px]'),
      render: (d) => <StatusBadge group="declaration" status={d.status} />,
    },
  ];

  /** The row's "⋮" menu (on hover): downloading the receipt, and withdrawing while it waits for a decision. */
  function rowMenu(d: HrSelfDeclaration) {
    const items = [
      d.hasReceipt && (
        <DropdownMenuItem key="receipt" disabled={receipt.isPending} onClick={() => receipt.download(d)}>
          <Download />
          {t('weldhr.declarations.downloadReceipt')}
        </DropdownMenuItem>
      ),
      isWithdrawable(d) && (
        <DropdownMenuItem key="withdraw" variant="destructive" onClick={() => setWithdrawTarget(d)}>
          <Undo2 />
          {t('weldhr.me.declarations.withdrawConfirm.confirm')}
        </DropdownMenuItem>
      ),
    ].filter(Boolean);
    if (items.length === 0) return null;
    return items.map((item, index) => (
      <Fragment key={index}>
        {index > 0 && <DropdownMenuSeparator />}
        {item}
      </Fragment>
    ));
  }

  const newButton = canSubmit ? { label: t('weldhr.me.declarations.newDeclaration'), onClick: onNewDeclaration } : undefined;

  return (
    <>
      <HrListContainer>
        <PanelEntityList<HrSelfDeclaration>
          // The filters are the page's, so the list gets the rows they leave.
          items={filterDeclarations(declarations, activeFilters)}
          isLoading={isLoading}
          error={data ? null : (error as Error | null)}
          columns={columns}
          onRowClick={(d) => openPanel({ type: MY_DECLARATION_PANEL_TYPE, id: d.id })}
          objectPanel={{ type: MY_DECLARATION_PANEL_TYPE }}
          rowMenu={rowMenu}
          groups={groups}
          filters={filters}
          activeFilters={activeFilters}
          onFiltersChange={onFiltersChange}
          searchFields={['description', 'reviewNote']}
          searchPlaceholder={t('weldhr.me.declarations.list.searchPlaceholder')}
          createButton={newButton}
          emptyState={{
            icon: emptyIcon(ReceiptText),
            title: t('weldhr.me.declarations.list.empty'),
            // Without the button, say why: the workspace turned declarations off.
            description: canSubmit ? t('weldhr.me.declarations.list.emptyHint') : t('weldhr.me.declarations.submitOff'),
            action: newButton,
          }}
          noResultsState={{
            icon: emptyIcon(ReceiptText),
            title: t('weldhr.me.declarations.list.noResults.title'),
            description: t('weldhr.me.declarations.list.noResults.description'),
          }}
        />
      </HrListContainer>

      {withdrawTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setWithdrawTarget(null)}
          title={t('weldhr.me.declarations.withdrawConfirm.title')}
          description={t('weldhr.me.declarations.withdrawConfirm.description', {
            amount: formatMoney(withdrawTarget.amount, withdrawTarget.currency),
            date: formatDate(withdrawTarget.expenseDate),
          })}
          variant="destructive"
          confirmLabel={t('weldhr.me.declarations.withdrawConfirm.confirm')}
          cancelLabel={t('weldhr.me.declarations.withdrawConfirm.keep')}
          onConfirm={() => confirmWithdraw(withdrawTarget)}
        />
      )}
    </>
  );
}
