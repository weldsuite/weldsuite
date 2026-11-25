/** WeldHR — Declarations: the expense review queue and history, grouped by status. */

import { useState } from 'react';
import { toast } from 'sonner';
import { Banknote, Paperclip, ReceiptText, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrDeclarationListItem } from '@weldsuite/app-api-client/domains/weldhr';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import {
  PanelEntityList,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/panel-entity-list';
import {
  useCancelHrDeclaration,
  useDeleteHrDeclaration,
  useHrDeclarations,
  useMarkHrDeclarationPaid,
  useOpenHrDeclarationReceipt,
} from '@/hooks/queries/use-weldhr-queries';
import { emptyIcon, useHrBreadcrumbs } from '../components/page-kit';
import { StatusBadge, errorMessage, formatDate, formatMoney } from '../components/shared';
import { DeclarationDialog } from './components/declaration-dialog';
import { DeclarationReviewDialog } from './components/review-dialog';

const STATUSES = ['pending', 'approved', 'rejected', 'paid', 'cancelled'] as const;
const KNOWN_STATUSES = new Set<string>(STATUSES);
const CATEGORIES = ['travel', 'meals', 'accommodation', 'equipment', 'training', 'other'] as const;

export default function WeldHrDeclarationsPage() {
  const t = useTranslations();
  useHrBreadcrumbs({ label: t('weldhr.declarations.title') });
  const { can } = usePermissions();
  const canCreate = can('declarations:create');
  const canApprove = can('declarations:approve');
  const canUpdate = can('declarations:update');
  const canDelete = can('declarations:delete');

  const { data: declarations, isLoading, error } = useHrDeclarations();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<HrDeclarationListItem | null>(null);
  const [review, setReview] = useState<{ declaration: HrDeclarationListItem; decision: 'approved' | 'rejected' } | null>(null);
  const [payTarget, setPayTarget] = useState<HrDeclarationListItem | null>(null);
  const [cancelTarget, setCancelTarget] = useState<HrDeclarationListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrDeclarationListItem | null>(null);

  const markPaid = useMarkHrDeclarationPaid();
  const cancelDeclaration = useCancelHrDeclaration();
  const deleteDeclaration = useDeleteHrDeclaration();
  const openReceipt = useOpenHrDeclarationReceipt();

  function downloadReceipt(declaration: HrDeclarationListItem) {
    openReceipt.mutate(declaration, {
      onError: (err) => toast.error(errorMessage(err, t('weldhr.declarations.receiptFailed'))),
    });
  }

  const groups: GroupConfig<HrDeclarationListItem>[] = [
    { id: 'pending', label: t('weldhr.declarations.groups.pending'), sortOrder: 1, filter: (d) => d.status === 'pending' },
    { id: 'approved', label: t('weldhr.declarations.groups.approved'), sortOrder: 2, filter: (d) => d.status === 'approved' },
    { id: 'paid', label: t('weldhr.declarations.groups.paid'), sortOrder: 3, filter: (d) => d.status === 'paid' },
    { id: 'rejectedCancelled', label: t('weldhr.declarations.groups.rejectedCancelled'), sortOrder: 4, filter: (d) => d.status === 'rejected' || d.status === 'cancelled' },
    { id: 'other', label: t('weldhr.declarations.groups.other'), sortOrder: 5, filter: (d) => !KNOWN_STATUSES.has(d.status) },
  ];

  const rows = declarations ?? [];
  const employees = [...new Set(rows.map((d) => d.employeeName).filter((name): name is string => !!name))].sort((a, b) => a.localeCompare(b));
  const filters: FilterConfig[] = [
    {
      field: 'status',
      label: t('weldhr.declarations.table.status'),
      operators: ['is'],
      options: STATUSES.map((status) => ({ value: status, label: t(`weldhr.status.declaration.${status}`) })),
    },
    {
      field: 'category',
      label: t('weldhr.declarations.form.category'),
      operators: ['is'],
      options: CATEGORIES.map((category) => ({ value: category, label: t(`weldhr.declarations.category.${category}`) })),
    },
    {
      field: 'employee',
      label: t('weldhr.declarations.table.employee'),
      operators: ['is'],
      searchable: true,
      options: employees.map((name) => ({ value: name, label: name })),
    },
  ];
  const applyFilters = (list: HrDeclarationListItem[], active: ActiveFilter[]) =>
    active.reduce((rowsLeft, filter) => {
      if (!filter.value) return rowsLeft;
      if (filter.field === 'status') return rowsLeft.filter((d) => d.status === filter.value);
      if (filter.field === 'category') return rowsLeft.filter((d) => d.category === filter.value);
      if (filter.field === 'employee') return rowsLeft.filter((d) => d.employeeName === filter.value);
      return rowsLeft;
    }, list);

  const columns: ColumnDef<HrDeclarationListItem>[] = [
    {
      id: 'employee',
      header: t('weldhr.declarations.table.employee'),
      width: 'w-[160px]',
      render: (d) => <span className="block truncate font-medium">{d.employeeName}</span>,
    },
    {
      id: 'date',
      header: t('weldhr.declarations.table.date'),
      width: 'w-[100px]',
      render: (d) => <span className="tabular-nums">{formatDate(d.expenseDate)}</span>,
    },
    {
      id: 'category',
      header: t('weldhr.declarations.form.category'),
      width: 'flex-1',
      // The category only: the description made the rows busy. Hover shows it; search still finds it.
      render: (d) => (
        <span className="block truncate" title={d.description}>
          {t(`weldhr.declarations.category.${d.category}`)}
        </span>
      ),
    },
    {
      id: 'amount',
      header: t('weldhr.declarations.table.amount'),
      width: 'w-[110px]',
      render: (d) => <span className="font-medium tabular-nums">{formatMoney(d.amount, d.currency)}</span>,
    },
    {
      id: 'receipt',
      header: t('weldhr.declarations.table.receipt'),
      width: 'w-[70px]',
      render: (d) =>
        d.hasReceipt ? (
          // The file name on hover, so you know what you are about to open.
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                aria-label={[t('weldhr.declarations.downloadReceipt'), d.receiptFileName].filter(Boolean).join(': ')}
                disabled={openReceipt.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  downloadReceipt(d);
                }}
              >
                <Paperclip className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="font-medium">{t('weldhr.declarations.downloadReceipt')}</p>
              {d.receiptFileName && <p className="max-w-64 truncate opacity-80">{d.receiptFileName}</p>}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'status',
      header: t('weldhr.declarations.table.status'),
      width: 'w-[110px]',
      render: (d) => <StatusBadge group="declaration" status={d.status} />,
    },
    {
      id: 'actions',
      header: '',
      width: 'w-[210px]',
      render: (d) => (
        <div className="flex justify-end gap-1.5">
          {canApprove && d.status === 'pending' && (
            <>
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={(e) => { e.stopPropagation(); setReview({ declaration: d, decision: 'approved' }); }}>
                {t('weldhr.declarations.approve')}
              </Button>
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={(e) => { e.stopPropagation(); setReview({ declaration: d, decision: 'rejected' }); }}>
                {t('weldhr.declarations.reject')}
              </Button>
            </>
          )}
          {canApprove && d.status === 'approved' && (
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={(e) => { e.stopPropagation(); setPayTarget(d); }}>
              <Banknote className="mr-1 h-3.5 w-3.5" />
              {t('weldhr.declarations.markPaid')}
            </Button>
          )}
          {canUpdate && (d.status === 'pending' || d.status === 'approved') && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={(e) => { e.stopPropagation(); setCancelTarget(d); }}>
              <X className="mr-1 h-3.5 w-3.5" />
              {t('weldhr.declarations.cancel')}
            </Button>
          )}
        </div>
      ),
    },
  ];

  /** The row menu lists Edit for every row; the server only accepts it while pending. */
  function edit(declaration: HrDeclarationListItem) {
    if (declaration.status === 'pending') setEditing(declaration);
    else toast.info(t('weldhr.declarations.editLocked'));
  }

  return (
    <>
      <PanelEntityList<HrDeclarationListItem>
        items={rows}
        isLoading={isLoading}
        error={error}
        columns={columns}
        groups={groups}
        filters={filters}
        applyFilters={applyFilters}
        searchFields={['employeeName', 'description']}
        searchPlaceholder={t('weldhr.declarations.searchPlaceholder')}
        onEdit={canUpdate ? edit : undefined}
        onDelete={canDelete ? (d) => setDeleteTarget(d) : undefined}
        createButton={canCreate ? { label: t('weldhr.declarations.newDeclaration'), onClick: () => setCreating(true) } : undefined}
        emptyState={{
          icon: emptyIcon(ReceiptText),
          title: t('weldhr.declarations.empty.title'),
          description: t('weldhr.declarations.empty.description'),
        }}
      />

      {creating && <DeclarationDialog onClose={() => setCreating(false)} />}
      {editing && <DeclarationDialog declaration={editing} onClose={() => setEditing(null)} />}
      {review && <DeclarationReviewDialog declaration={review.declaration} decision={review.decision} onClose={() => setReview(null)} />}

      <ConfirmDialog
        open={Boolean(payTarget)}
        onOpenChange={(open) => !open && setPayTarget(null)}
        title={t('weldhr.declarations.payConfirmTitle')}
        description={
          payTarget
            ? t('weldhr.declarations.payConfirmDescription', {
                amount: formatMoney(payTarget.amount, payTarget.currency),
                employee: payTarget.employeeName,
              })
            : ''
        }
        confirmLabel={t('weldhr.declarations.markPaid')}
        onConfirm={async () => {
          if (!payTarget) return;
          try {
            await markPaid.mutateAsync(payTarget.id);
            setPayTarget(null);
          } catch (err) {
            toast.error(errorMessage(err, t('weldhr.declarations.payFailed')));
          }
        }}
      />
      <ConfirmDialog
        open={Boolean(cancelTarget)}
        onOpenChange={(open) => !open && setCancelTarget(null)}
        title={t('weldhr.declarations.cancelConfirmTitle')}
        description={t('weldhr.declarations.cancelConfirmDescription')}
        onConfirm={async () => {
          if (!cancelTarget) return;
          try {
            await cancelDeclaration.mutateAsync(cancelTarget.id);
            setCancelTarget(null);
          } catch (err) {
            toast.error(errorMessage(err, t('weldhr.declarations.cancelFailed')));
          }
        }}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('weldhr.declarations.deleteConfirmTitle')}
        description={t('weldhr.declarations.deleteConfirmDescription')}
        variant="destructive"
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteDeclaration.mutateAsync(deleteTarget.id);
            setDeleteTarget(null);
          } catch (err) {
            toast.error(errorMessage(err, t('weldhr.declarations.deleteFailed')));
          }
        }}
      />
    </>
  );
}
