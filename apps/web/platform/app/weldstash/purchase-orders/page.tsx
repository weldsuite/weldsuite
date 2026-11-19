import { Suspense, useMemo, useState } from 'react';
import { ClipboardList, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import type { PurchaseOrder } from '@weldsuite/app-api-client/schemas/purchase-orders';
import { PURCHASE_ORDER_STATUSES } from '@weldsuite/app-api-client/schemas/purchase-orders';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { ListTable, type ListTableColumn } from '@weldsuite/ui/components/list-table';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import { useDebounce } from '@/hooks/use-debounce';
import { useRouter } from '@/lib/router';
import { getLocale, getTranslations } from '@/lib/i18n';
import { isFeatureAvailable } from '@/lib/edition';
import { useDeletePurchaseOrder, useInfinitePurchaseOrders } from '@/hooks/queries/use-purchasing-queries';
import { useWeldstashSuppliers, useWeldstashWarehouses } from '@/hooks/queries/use-weldstash-queries';
import { formatDate, formatMoney } from '../lib/numbers';
import { OdooManagedBadge } from '../components/odoo-managed-badge';
import { PoFormDialog } from './components/po-form-dialog';
import { PoStatusBadge } from './components/po-status-badge';
import { isSentToOdoo, purchaseOrderActions } from './lib/po-actions';

function PurchaseOrdersContent() {
  const t = getTranslations('weldstashPurchasing');
  const locale = getLocale();
  const router = useRouter();
  const { can } = usePermissions();
  const purchasing = isFeatureAvailable('stash-replenishment');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [status, setStatus] = useState<string | undefined>();
  const [supplierId, setSupplierId] = useState<string | undefined>();
  const [warehouseId, setWarehouseId] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<PurchaseOrder | null>(null);

  const filters = useMemo(
    () => ({
      limit: 50,
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      ...(status ? { status } : {}),
      ...(supplierId ? { supplierId } : {}),
      ...(warehouseId ? { warehouseId } : {}),
    }),
    [debouncedSearch, status, supplierId, warehouseId],
  );
  const hasFilters = Object.keys(filters).length > 1;

  const orders = useInfinitePurchaseOrders(filters);
  const suppliers = useWeldstashSuppliers({ limit: 100 });
  const warehouses = useWeldstashWarehouses({ limit: 100 });
  const deleteOrder = useDeletePurchaseOrder();

  const rows = useMemo(() => orders.data?.pages.flatMap((page) => page.data ?? []) ?? [], [orders.data]);
  const warehouseRows = warehouses.data?.data;
  const warehouseById = useMemo(() => new Map((warehouseRows ?? []).map((w) => [w.id, w])), [warehouseRows]);

  const canCreate = can('orders:create');
  const canUpdate = can('orders:update');
  const canDelete = can('orders:delete');

  const columns: ListTableColumn<PurchaseOrder>[] = [
    {
      id: 'poNumber',
      header: t.columns.poNumber,
      width: 'w-[170px]',
      cell: (row) => <span className="font-medium">{row.poNumber}</span>,
    },
    { id: 'supplier', header: t.columns.supplier, accessor: (row) => row.supplierName ?? '' },
    {
      id: 'warehouse',
      header: t.columns.warehouse,
      cell: (row) => {
        const warehouse = row.warehouseId ? warehouseById.get(row.warehouseId) : undefined;
        return (
          <span className="flex items-center gap-2">
            <span className="truncate">{row.warehouseName ?? warehouse?.name ?? ''}</span>
            {warehouse?.managedByConnectionId && <OdooManagedBadge />}
          </span>
        );
      },
    },
    { id: 'status', header: t.columns.status, width: 'w-[120px]', cell: (row) => <PoStatusBadge status={row.status} /> },
    {
      id: 'expected',
      header: t.columns.expected,
      width: 'w-[130px]',
      accessor: (row) => formatDate(row.expectedDate, locale),
    },
    { id: 'lines', header: t.columns.lines, width: 'w-[70px]', align: 'right', accessor: (row) => row.itemCount ?? 0 },
    {
      id: 'total',
      header: t.columns.total,
      width: 'w-[130px]',
      align: 'right',
      cell: (row) => <span className="tabular-nums">{formatMoney(row.total, row.currency, locale)}</span>,
    },
  ];

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await deleteOrder.mutateAsync(deleting.id);
      toast.success(t.detail.toastDeleted);
    } catch (err) {
      toast.error((err as Error).message || t.detail.deleteFailed);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <SearchInput
          className="w-56"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t.searchPlaceholder}
          aria-label={t.searchPlaceholder}
        />
        <FilterSelect
          value={status}
          onChange={setStatus}
          allLabel={t.filters.allStatuses}
          ariaLabel={t.filters.status}
          options={PURCHASE_ORDER_STATUSES.map((s) => ({ value: s, label: (t.status as Record<string, string>)[s] ?? s }))}
        />
        <FilterSelect
          value={supplierId}
          onChange={setSupplierId}
          allLabel={t.filters.allSuppliers}
          ariaLabel={t.filters.supplier}
          options={(suppliers.data?.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
        />
        <FilterSelect
          value={warehouseId}
          onChange={setWarehouseId}
          allLabel={t.filters.allWarehouses}
          ariaLabel={t.filters.warehouse}
          options={(warehouseRows ?? []).map((w) => ({ value: w.id, label: w.name }))}
        />
        <div className="ml-auto">
          {canCreate && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1 size-4" />
              {t.newOrder}
            </Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {orders.isLoading && <PageLoader fullScreen={false} />}
        {orders.isError && (
          <div className="p-6">
            <ErrorState
              message={(orders.error as Error)?.message || t.loadError}
              onRetry={() => void orders.refetch()}
              retryLabel={t.common.retry}
            />
          </div>
        )}
        {!orders.isLoading && !orders.isError && (
          <>
            <ListTable<PurchaseOrder>
              columns={columns}
              data={rows}
              rowKey={(row) => row.id}
              onRowClick={(row) => router.push(`/weldstash/purchase-orders/${row.id}`)}
              rowLabel={(row) => row.poNumber}
              actions={[
                {
                  id: 'delete',
                  label: t.detail.delete,
                  icon: Trash2,
                  variant: 'destructive',
                  onClick: (row) => setDeleting(row),
                  hidden: (row) =>
                    !purchaseOrderActions({
                      status: row.status,
                      totalQuantityReceived: row.totalQuantityReceived ?? 0,
                      sentToOdoo: isSentToOdoo(row.metadata),
                      warehouseManagedInOdoo: false,
                      purchasing,
                      canUpdate,
                      canDelete,
                    }).delete,
                },
              ]}
              emptyState={
                hasFilters
                  ? undefined
                  : {
                      icon: <ClipboardList className="size-10 text-muted-foreground/60" strokeWidth={1.5} />,
                      title: t.empty.title,
                      description: canCreate ? t.empty.description : t.empty.noPermission,
                      action: canCreate ? { label: t.newOrder, onClick: () => setCreateOpen(true) } : undefined,
                    }
              }
              emptyMessage={t.empty.filtered}
            />
            {orders.hasNextPage && (
              <div className="flex justify-center p-4">
                <Button variant="outline" size="sm" disabled={orders.isFetchingNextPage} onClick={() => void orders.fetchNextPage()}>
                  {orders.isFetchingNextPage ? t.common.loading : t.common.loadMore}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {createOpen && (
        <PoFormDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onSaved={(id) => router.push(`/weldstash/purchase-orders/${id}`)}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t.detail.deleteTitle}
        description={t.detail.deleteDescription.replace('{number}', deleting?.poNumber ?? '')}
        confirmLabel={t.detail.delete}
        variant="destructive"
        loading={deleteOrder.isPending}
        onConfirm={handleDelete}
      />
    </div>
  );
}

export default function WeldStashPurchaseOrdersPage() {
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <PurchaseOrdersContent />
    </Suspense>
  );
}
