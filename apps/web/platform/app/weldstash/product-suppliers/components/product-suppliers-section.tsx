/**
 * Product suppliers as a tab body: on a product, the suppliers it is bought
 * from; on a supplier, the products it sells. The same rows (`/product-suppliers`),
 * seen from either side. Kubernetes editions only (the caller does not render
 * it elsewhere; the hooks stay idle on Global as well).
 */

import { useState } from 'react';
import { Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import type { ProductSupplier } from '@weldsuite/app-api-client/schemas/product-suppliers';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { getLocale, getTranslations } from '@/lib/i18n';
import {
  useDeleteProductSupplier,
  useProductSuppliers,
  useUpdateProductSupplier,
} from '@/hooks/queries/use-purchasing-queries';
import { formatMoney } from '../../lib/numbers';
import { ProductSupplierDialog } from './product-supplier-dialog';

type Side = { side: 'product'; productId: string } | { side: 'supplier'; supplierId: string };

export function ProductSuppliersSection(props: Readonly<Side>) {
  const t = getTranslations('weldstashPurchasing').productSuppliers;
  const locale = getLocale();
  const { can } = usePermissions();
  const isProduct = props.side === 'product';
  const rows = useProductSuppliers(isProduct ? { productId: props.productId } : { supplierId: props.supplierId });
  const update = useUpdateProductSupplier();
  const remove = useDeleteProductSupplier();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ProductSupplier | null>(null);
  const [deleting, setDeleting] = useState<ProductSupplier | null>(null);

  const canCreate = can('suppliers:create');
  const canUpdate = can('suppliers:update');
  const canDelete = can('suppliers:delete');

  if (rows.isLoading) return <InlineSpinner className="py-8" />;
  if (rows.isError) {
    return (
      <div className="p-4">
        <ErrorState message={(rows.error as Error)?.message || t.loadError} onRetry={() => void rows.refetch()} />
      </div>
    );
  }
  const data = rows.data ?? [];

  const makePreferred = async (row: ProductSupplier) => {
    try {
      await update.mutateAsync({ id: row.id, data: { isPreferred: true } });
      toast.success(t.toastPreferred);
    } catch (err) {
      toast.error((err as Error).message || t.saveFailed);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast.success(t.toastRemoved);
    } catch (err) {
      toast.error((err as Error).message || t.removeFailed);
    } finally {
      setDeleting(null);
    }
  };

  const title = (row: ProductSupplier) => (isProduct ? row.supplierName : row.productName) ?? '';
  const subtitle = (row: ProductSupplier) => (isProduct ? row.supplierSku : row.productSku);
  const excludeIds = data.map((row) => (isProduct ? row.supplierId : row.productId));

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{isProduct ? t.titleForProduct : t.titleForSupplier}</h3>
        {canCreate && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="mr-1 size-4" />
            {isProduct ? t.addSupplier : t.addProduct}
          </Button>
        )}
      </div>

      {data.length === 0 ? (
        <EmptyState
          title={isProduct ? t.emptyProductTitle : t.emptySupplierTitle}
          description={isProduct ? t.emptyProductDescription : t.emptySupplierDescription}
        />
      ) : (
        <ul className="divide-y rounded-md border">
          {data.map((row) => {
            const leadTime = row.leadTimeDays ?? row.supplierLeadTimeDays;
            return (
              <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span className="truncate">{title(row)}</span>
                    {row.isPreferred && <SoftBadge tone="success">{t.preferred}</SoftBadge>}
                    {row.variantId && <SoftBadge tone="neutral">{t.variant}</SoftBadge>}
                  </p>
                  {subtitle(row) && <p className="text-xs text-muted-foreground">{subtitle(row)}</p>}
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {[
                      row.unitCost ? formatMoney(row.unitCost, row.currency ?? row.supplierCurrency, locale) : null,
                      leadTime !== null && leadTime !== undefined ? t.leadTimeDays.replace('{count}', String(leadTime)) : null,
                      row.minOrderQty ? t.minOrder.replace('{count}', String(row.minOrderQty)) : null,
                      row.orderMultiple > 1 ? t.multiple.replace('{count}', String(row.orderMultiple)) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {canUpdate && !row.isPreferred && (
                    <Button size="icon-sm" variant="ghost" title={t.makePreferred} aria-label={t.makePreferred} onClick={() => void makePreferred(row)}>
                      <Star className="size-4" />
                    </Button>
                  )}
                  {canUpdate && (
                    <Button size="icon-sm" variant="ghost" title={t.edit} aria-label={t.edit} onClick={() => setEditing(row)}>
                      <Pencil className="size-4" />
                    </Button>
                  )}
                  {canDelete && (
                    <Button size="icon-sm" variant="ghost" title={t.remove} aria-label={t.remove} onClick={() => setDeleting(row)}>
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {adding && (
        <ProductSupplierDialog
          open={adding}
          onOpenChange={setAdding}
          productId={props.side === 'product' ? props.productId : undefined}
          supplierId={props.side === 'supplier' ? props.supplierId : undefined}
          excludeIds={excludeIds}
        />
      )}
      {editing && <ProductSupplierDialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)} row={editing} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t.removeTitle}
        description={t.removeDescription.replace('{name}', deleting ? title(deleting) : '')}
        confirmLabel={t.remove}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={handleDelete}
      />
    </div>
  );
}
