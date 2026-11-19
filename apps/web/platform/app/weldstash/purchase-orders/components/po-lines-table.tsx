import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { PurchaseOrderLine } from '@weldsuite/app-api-client/schemas/purchase-orders';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ListTable, type ListTableColumn } from '@weldsuite/ui/components/list-table';
import { getLocale, getTranslations } from '@/lib/i18n';
import { useDeletePurchaseOrderLine } from '@/hooks/queries/use-purchasing-queries';
import { formatMoney, toNumber } from '../../lib/numbers';
import { remainingToReceive } from '../lib/po-actions';
import { PoLineDialog } from './po-line-dialog';

interface PoLinesTableProps {
  orderId: string;
  currency: string | null;
  lines: readonly PurchaseOrderLine[];
  /** Whether lines can be added, changed and removed (a draft). */
  editable: boolean;
}

export function PoLinesTable({ orderId, currency, lines, editable }: Readonly<PoLinesTableProps>) {
  const t = getTranslations('weldstashPurchasing');
  const locale = getLocale();
  const deleteLine = useDeletePurchaseOrderLine(orderId);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PurchaseOrderLine | null>(null);
  const [deleting, setDeleting] = useState<PurchaseOrderLine | null>(null);

  const columns: ListTableColumn<PurchaseOrderLine>[] = [
    {
      id: 'name',
      header: t.lines.item,
      cell: (line) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{line.name}</span>
          {line.sku && <span className="truncate text-xs text-muted-foreground">{line.sku}</span>}
        </span>
      ),
    },
    { id: 'ordered', header: t.lines.ordered, width: 'w-[80px]', align: 'right', accessor: (line) => line.quantityOrdered },
    { id: 'received', header: t.lines.received, width: 'w-[80px]', align: 'right', accessor: (line) => line.quantityReceived ?? 0 },
    { id: 'rejected', header: t.lines.rejected, width: 'w-[80px]', align: 'right', accessor: (line) => line.quantityRejected ?? 0 },
    { id: 'remaining', header: t.lines.remaining, width: 'w-[90px]', align: 'right', accessor: (line) => remainingToReceive(line) },
    {
      id: 'unitPrice',
      header: t.lines.unitPrice,
      width: 'w-[110px]',
      align: 'right',
      cell: (line) => <span className="tabular-nums">{formatMoney(line.unitPrice, currency, locale)}</span>,
    },
    {
      id: 'tax',
      header: t.lines.tax,
      width: 'w-[70px]',
      align: 'right',
      accessor: (line) => `${toNumber(line.taxPercent)}%`,
    },
    {
      id: 'total',
      header: t.lines.total,
      width: 'w-[120px]',
      align: 'right',
      cell: (line) => <span className="tabular-nums">{formatMoney(line.total, currency, locale)}</span>,
    },
  ];

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await deleteLine.mutateAsync(deleting.id);
      toast.success(t.lines.toastDeleted);
    } catch (err) {
      toast.error((err as Error).message || t.lines.deleteFailed);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-3">
      {editable && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="mr-1 size-4" />
            {t.lines.add}
          </Button>
        </div>
      )}
      <ListTable<PurchaseOrderLine>
        columns={columns}
        data={[...lines]}
        rowKey={(line) => line.id}
        dense
        actions={
          editable
            ? [
                { id: 'edit', label: t.lines.edit, icon: Pencil, onClick: (line) => setEditing(line) },
                { id: 'delete', label: t.lines.delete, icon: Trash2, variant: 'destructive', onClick: (line) => setDeleting(line) },
              ]
            : undefined
        }
        emptyMessage={editable ? t.lines.emptyEditable : t.lines.empty}
      />

      {adding && <PoLineDialog open={adding} onOpenChange={setAdding} orderId={orderId} currency={currency} />}
      {editing && (
        <PoLineDialog
          open={!!editing}
          onOpenChange={(open) => !open && setEditing(null)}
          orderId={orderId}
          currency={currency}
          line={editing}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t.lines.deleteTitle}
        description={t.lines.deleteDescription.replace('{name}', deleting?.name ?? '')}
        confirmLabel={t.lines.delete}
        variant="destructive"
        loading={deleteLine.isPending}
        onConfirm={handleDelete}
      />
    </div>
  );
}
