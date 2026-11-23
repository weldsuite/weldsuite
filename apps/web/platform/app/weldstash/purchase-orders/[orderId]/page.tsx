/**
 * One purchase order: header, lines and totals, and (Kubernetes editions) the
 * status actions, receiving, receipts and Send to Odoo.
 */

import { Suspense, useMemo, useState } from 'react';
import { Ban, CheckCircle2, Lock, MoreHorizontal, PackageCheck, Pencil, Send, ShoppingCart, Trash2, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FieldGrid } from '@weldsuite/ui/components/field-grid';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { DetailHeader, DetailPage, TabBody } from '@weldsuite/ui/components/page-layout';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { PageTabs } from '@weldsuite/ui/components/page-tabs';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { useParams, useRouter } from '@/lib/router';
import { getLocale, getTranslations } from '@/lib/i18n';
import { isFeatureAvailable } from '@/lib/edition';
import {
  useApprovePurchaseOrder,
  useCancelPurchaseOrder,
  useClosePurchaseOrder,
  useDeletePurchaseOrder,
  usePurchaseOrder,
  usePurchaseOrderLines,
  useSendPurchaseOrderToOdoo,
} from '@/hooks/queries/use-purchasing-queries';
import { useWeldstashWarehouse } from '@/hooks/queries/use-weldstash-queries';
import { useConnectorConnection } from '@/hooks/queries/use-connector-queries';
import { formatDate, formatMoney, toNumber } from '../../lib/numbers';
import { OdooManagedBadge } from '../../components/odoo-managed-badge';
import { PoFormDialog } from '../components/po-form-dialog';
import { PoLinesTable } from '../components/po-lines-table';
import { PoStatusBadge } from '../components/po-status-badge';
import { MarkOrderedDialog } from '../components/mark-ordered-dialog';
import { ReceiveDialog } from '../components/receive-dialog';
import { ReceiptsTab } from '../components/receipts-tab';
import { isSentToOdoo, purchaseOrderActions } from '../lib/po-actions';
import { computePurchaseOrderTotals } from '../lib/po-totals';

type Confirm = 'cancel' | 'close' | 'delete' | 'odoo' | null;

function PurchaseOrderContent() {
  const t = getTranslations('weldstashPurchasing');
  const locale = getLocale();
  const { orderId } = useParams() as { orderId: string };
  const router = useRouter();
  const { can } = usePermissions();
  const purchasing = isFeatureAvailable('stash-replenishment');

  const orderQuery = usePurchaseOrder(orderId);
  const linesQuery = usePurchaseOrderLines(orderId);
  const order = orderQuery.data;
  const lines = linesQuery.data;
  const warehouse = useWeldstashWarehouse(order?.warehouseId ?? '', !!order?.warehouseId).data?.data;
  const managedByConnectionId = warehouse?.managedByConnectionId ?? null;
  const connection = useConnectorConnection(purchasing ? managedByConnectionId : null).data?.data;
  const warehouseManagedInOdoo = !!managedByConnectionId && connection?.provider === 'odoo';

  const approve = useApprovePurchaseOrder();
  const cancel = useCancelPurchaseOrder();
  const close = useClosePurchaseOrder();
  const remove = useDeletePurchaseOrder();
  const sendToOdoo = useSendPurchaseOrderToOdoo();

  const [tab, setTab] = useState<'lines' | 'receipts'>('lines');
  const [editOpen, setEditOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [orderedOpen, setOrderedOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const sentToOdoo = isSentToOdoo(order?.metadata);
  const odooRef = (order?.metadata?.odoo ?? null) as { name?: string } | null;
  const actions = useMemo(
    () =>
      purchaseOrderActions({
        status: order?.status ?? 'draft',
        totalQuantityReceived: order?.totalQuantityReceived ?? 0,
        sentToOdoo,
        warehouseManagedInOdoo,
        purchasing,
        canUpdate: can('purchase_orders:update'),
        canDelete: can('purchase_orders:delete'),
      }),
    [order, sentToOdoo, warehouseManagedInOdoo, purchasing, can],
  );
  const totals = useMemo(() => computePurchaseOrderTotals(lines ?? [], order ?? {}), [lines, order]);

  if (orderQuery.isLoading) return <PageLoader fullScreen={false} />;
  if (orderQuery.isError || !order) {
    return (
      <div className="p-6">
        <ErrorState
          message={(orderQuery.error as Error)?.message || t.detail.notFound}
          onRetry={() => void orderQuery.refetch()}
          retryLabel={t.common.retry}
        />
      </div>
    );
  }

  const run = async (action: () => Promise<unknown>, success: string, failure: string) => {
    try {
      await action();
      toast.success(success);
    } catch (err) {
      toast.error((err as Error).message || failure);
    }
  };

  const confirmCopy = {
    cancel: { title: t.detail.cancelTitle, description: t.detail.cancelDescription, label: t.detail.cancelConfirm, destructive: true },
    close: { title: t.detail.closeTitle, description: t.detail.closeDescription, label: t.detail.closeConfirm, destructive: false },
    delete: { title: t.detail.deleteTitle, description: t.detail.deleteDescription.replace('{number}', order.poNumber), label: t.detail.delete, destructive: true },
    odoo: { title: t.odoo.sendTitle, description: t.odoo.sendDescription, label: t.odoo.send, destructive: false },
  } as const;

  const onConfirm = async () => {
    const which = confirm;
    setConfirm(null);
    if (which === 'cancel') await run(() => cancel.mutateAsync(order.id), t.detail.toastCancelled, t.detail.actionFailed);
    if (which === 'close') await run(() => close.mutateAsync(order.id), t.detail.toastClosed, t.detail.actionFailed);
    if (which === 'odoo') {
      await run(
        async () => {
          const result = await sendToOdoo.mutateAsync(order.id);
          toast.message(t.odoo.sentAs.replace('{name}', result.odoo.name));
        },
        t.odoo.toastSent,
        t.detail.actionFailed,
      );
    }
    if (which === 'delete') {
      try {
        await remove.mutateAsync(order.id);
        toast.success(t.detail.toastDeleted);
        router.push('/weldstash/purchase-orders');
      } catch (err) {
        toast.error((err as Error).message || t.detail.deleteFailed);
      }
    }
  };

  const hasSecondary = actions.cancel || actions.close || actions.delete;

  return (
    <DetailPage>
      <DetailHeader
        onBack={() => router.push('/weldstash/purchase-orders')}
        title={order.poNumber}
        badges={
          <>
            <PoStatusBadge status={order.status} />
            {(warehouseManagedInOdoo || sentToOdoo) && <OdooManagedBadge />}
          </>
        }
        subtitle={[order.supplierName, order.warehouseName].filter(Boolean).join(' · ')}
        actions={
          <>
            {actions.approve && (
              <Button
                size="sm"
                disabled={approve.isPending}
                onClick={() => void run(() => approve.mutateAsync(order.id), t.detail.toastApproved, t.detail.actionFailed)}
              >
                <CheckCircle2 className="mr-1 size-4" />
                {t.detail.approve}
              </Button>
            )}
            {actions.markOrdered && (
              <Button size="sm" onClick={() => setOrderedOpen(true)}>
                <ShoppingCart className="mr-1 size-4" />
                {t.detail.markOrdered}
              </Button>
            )}
            {actions.receive && (
              <Button size="sm" onClick={() => setReceiveOpen(true)}>
                <PackageCheck className="mr-1 size-4" />
                {t.detail.receive}
              </Button>
            )}
            {actions.sendToOdoo && (
              <Button size="sm" variant="outline" onClick={() => setConfirm('odoo')}>
                <Send className="mr-1 size-4" />
                {t.odoo.send}
              </Button>
            )}
            {actions.edit && (
              <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                <Pencil className="mr-1 size-4" />
                {t.detail.edit}
              </Button>
            )}
            {hasSecondary && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="outline" aria-label={t.detail.moreActions}>
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {actions.close && (
                    <DropdownMenuItem onClick={() => setConfirm('close')}>
                      <Lock className="size-4" />
                      {t.detail.close}
                    </DropdownMenuItem>
                  )}
                  {actions.cancel && (
                    <DropdownMenuItem onClick={() => setConfirm('cancel')}>
                      <Ban className="size-4" />
                      {t.detail.cancel}
                    </DropdownMenuItem>
                  )}
                  {actions.delete && (actions.close || actions.cancel) && <DropdownMenuSeparator />}
                  {actions.delete && (
                    <DropdownMenuItem variant="destructive" onClick={() => setConfirm('delete')}>
                      <Trash2 className="size-4" />
                      {t.detail.delete}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />

      {sentToOdoo && (
        <InfoBanner variant="info" icon={Truck}>
          {odooRef?.name ? t.odoo.sentNotice.replace('{name}', odooRef.name) : t.odoo.sentNoticeNoName}
        </InfoBanner>
      )}
      {!sentToOdoo && warehouseManagedInOdoo && purchasing && (
        <InfoBanner variant="neutral" icon={Truck}>
          {t.odoo.warehouseNotice}
        </InfoBanner>
      )}

      <SectionCard title={t.detail.details}>
        <FieldGrid
          fields={[
            { label: t.detail.supplier, value: order.supplierName },
            { label: t.detail.warehouse, value: order.warehouseName },
            { label: t.detail.orderDate, value: formatDate(order.orderDate, locale) || null },
            { label: t.detail.expectedDate, value: formatDate(order.expectedDate, locale) || null },
            { label: t.detail.receivedDate, value: formatDate(order.receivedDate, locale) || null },
            { label: t.detail.paymentTerms, value: order.paymentTerms },
            { label: t.detail.supplierNotes, value: order.supplierNotes },
            { label: t.detail.internalNotes, value: order.internalNotes },
          ]}
        />
      </SectionCard>

      <div>
        <PageTabs
          tabs={[
            { id: 'lines', label: t.detail.linesTab, count: lines?.length },
            ...(actions.receipts ? [{ id: 'receipts', label: t.detail.receiptsTab }] : []),
          ]}
          activeTab={tab}
          onTabChange={(id) => setTab(id as 'lines' | 'receipts')}
        />
        <TabBody className="px-0">
          {tab === 'lines' && (
            <>
              {linesQuery.isLoading && <PageLoader fullScreen={false} />}
              {linesQuery.isError && (
                <ErrorState
                  message={(linesQuery.error as Error)?.message || t.lines.loadError}
                  onRetry={() => void linesQuery.refetch()}
                  retryLabel={t.common.retry}
                />
              )}
              {lines && (
                <>
                  <PoLinesTable orderId={order.id} currency={order.currency} lines={lines} editable={actions.editLines} />
                  <div className="ml-auto mt-4 w-full max-w-xs space-y-1 text-sm" data-testid="po-totals">
                    <TotalRow label={t.totals.subtotal} value={formatMoney(totals.subtotal, order.currency, locale)} />
                    <TotalRow label={t.totals.tax} value={formatMoney(totals.taxTotal, order.currency, locale)} />
                    {toNumber(order.shippingTotal) > 0 && (
                      <TotalRow label={t.totals.shipping} value={formatMoney(totals.shippingTotal, order.currency, locale)} />
                    )}
                    {toNumber(order.discountTotal) > 0 && (
                      <TotalRow label={t.totals.discount} value={`-${formatMoney(totals.discountTotal, order.currency, locale)}`} />
                    )}
                    <TotalRow strong label={t.totals.total} value={formatMoney(totals.total, order.currency, locale)} />
                  </div>
                </>
              )}
            </>
          )}
          {tab === 'receipts' && actions.receipts && <ReceiptsTab orderId={order.id} lines={lines ?? []} />}
        </TabBody>
      </div>

      {editOpen && (
        <PoFormDialog open={editOpen} onOpenChange={setEditOpen} order={order} chooseStatus={actions.chooseStatus} />
      )}
      {receiveOpen && lines && <ReceiveDialog open={receiveOpen} onOpenChange={setReceiveOpen} order={order} lines={lines} />}
      {orderedOpen && (
        <MarkOrderedDialog open={orderedOpen} onOpenChange={setOrderedOpen} orderId={order.id} expectedDate={order.expectedDate} />
      )}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm ? confirmCopy[confirm].title : ''}
        description={confirm ? confirmCopy[confirm].description : ''}
        confirmLabel={confirm ? confirmCopy[confirm].label : undefined}
        variant={confirm && confirmCopy[confirm].destructive ? 'destructive' : 'default'}
        onConfirm={onConfirm}
      />
    </DetailPage>
  );
}

function TotalRow({ label, value, strong = false }: Readonly<{ label: string; value: string; strong?: boolean }>) {
  return (
    <div className={`flex justify-between gap-6 ${strong ? 'border-t pt-2 text-base font-semibold' : 'text-muted-foreground'}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

export default function WeldStashPurchaseOrderPage() {
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <PurchaseOrderContent />
    </Suspense>
  );
}
