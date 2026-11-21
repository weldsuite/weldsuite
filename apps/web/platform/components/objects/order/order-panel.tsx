/**
 * Order object panel.
 *
 *   details → status badges, the actions (next status, mark paid, edit,
 *             cancel), the customer and company, payment, totals, addresses,
 *             notes and the WeldBooks invoice
 *   items   → the lines with what has been fulfilled (WeldStash fulfils)
 *
 * Fulfilment is written by WeldStash only, so the panel reports it and never
 * changes it.
 */

import { Loader2, Package } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { getTranslations } from '@/lib/i18n';
import { useObjectPanel } from '@/components/object-panel';
import {
  useCommerceOrder,
  useRecalculateCommerceOrderTax,
  type Order,
  type OrderAddress,
  type OrderItem,
} from '@/hooks/queries/use-commerce-orders-queries';
import { fill } from '@/app/weldcommerce/lib/text';
import { rateText, vatCategoryLabel, vatTreatmentText } from '@/app/weldcommerce/lib/vat';
import {
  addressLines,
  approvalStatusLabel,
  fulfillmentStatusLabel,
  fulfillmentStatusTone,
  money,
  orderErrorMessage,
  orderStatusLabel,
  orderStatusTone,
  paymentStatusLabel,
  paymentStatusTone,
  sourceLabel,
} from '@/app/weldcommerce/lib/orders';
import {
  SimpleObjectPanel,
  formatPanelDate,
  SectionHeader,
  ProseBlock,
  LineItemList,
  type ObjectPanelComponentProps,
} from '@/components/objects/_shared/simple-object-panel';
import { detailsTab, extraTab } from '@/components/objects/_shared/focused-tabs';
import { OrderActions } from './order-actions';

function Totals({ order }: Readonly<{ order: Order }>) {
  const t = getTranslations('commerce').orders.panel;
  const rows: Array<{ label: string; value: string; show: boolean; strong?: boolean; note?: boolean }> = [
    { label: t.totals.subtotal, value: money(order.subtotal, order.currency), show: true },
    {
      label: order.discountCode ? fill(t.discountWithCode, { code: order.discountCode }) : t.totals.discount,
      value: `−${money(order.discountTotal, order.currency)}`,
      show: Number(order.discountTotal) > 0,
    },
    { label: t.totals.shipping, value: money(order.shippingTotal, order.currency), show: true },
    {
      label: t.vat.relief,
      value: `−${money(order.vatRelief, order.currency)}`,
      show: Number(order.vatRelief) > 0,
    },
    // With VAT-inclusive prices the tax is inside the total: said so, not added.
    {
      label: order.pricesIncludeTax ? t.totals.taxIncluded : t.totals.tax,
      value: money(order.taxTotal, order.currency),
      show: Number(order.taxTotal) > 0,
      note: order.pricesIncludeTax,
    },
    { label: t.totals.total, value: money(order.total, order.currency), show: true, strong: true },
  ];
  return (
    <div className="space-y-1">
      <SectionHeader>{t.sections.totals}</SectionHeader>
      <dl className="mx-4 space-y-1">
        {rows
          .filter((row) => row.show)
          .map((row) => (
            <div key={row.label} className={row.strong ? 'flex justify-between border-t pt-1.5 text-sm font-semibold' : 'flex justify-between text-sm'}>
              <dt className={row.strong ? undefined : 'text-muted-foreground'}>{row.label}</dt>
              <dd className={row.note ? 'tabular-nums text-muted-foreground' : 'tabular-nums'}>{row.value}</dd>
            </div>
          ))}
      </dl>
    </div>
  );
}

/**
 * How the VAT was worked out, in words: the treatment, the destination, the
 * price basis, the VAT per rate, and a warning when VIES could not be asked.
 * A member who may update the order can have the VAT worked out again while
 * the order is editable; after that it is locked.
 */
function VatSection({ order }: Readonly<{ order: Order }>) {
  const t = getTranslations('commerce').orders.panel.vat;
  const permissions = usePermissionsMaybe();
  const canUpdate = permissions?.can('orders:update') ?? false;
  const recalculate = useRecalculateCommerceOrderTax();
  const sentence = vatTreatmentText(order.vatTreatment, order.destinationCountry);

  const run = async () => {
    try {
      await recalculate.mutateAsync(order.id);
      toast.success(t.toastRecalculated);
    } catch (err) {
      toast.error(orderErrorMessage(err, getTranslations('commerce').orders.errors.generic));
    }
  };

  return (
    <div className="space-y-2">
      <SectionHeader>{t.title}</SectionHeader>
      <div className="mx-4 space-y-2">
        <p className="text-sm">{sentence ?? t.none}</p>
        {order.viesUnavailable && <InfoBanner variant="warning">{t.viesWarning}</InfoBanner>}
        {order.vatTreatment && order.vatTreatment !== 'imported' && (
          <dl className="space-y-1 text-sm">
            {order.destinationCountry && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{t.destination}</dt>
                <dd>{order.destinationCountry}</dd>
              </div>
            )}
            {order.buyerVatNumber && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{t.buyerVat}</dt>
                <dd className="tabular-nums">{order.buyerVatNumber}</dd>
              </div>
            )}
            {order.taxLines.map((line) => (
              <div key={line.rate} className="flex justify-between">
                <dt className="text-muted-foreground">{fill(t.onBase, { rate: rateText(line.rate), base: money(line.base, order.currency) })}</dt>
                <dd className="tabular-nums">{money(line.amount, order.currency)}</dd>
              </div>
            ))}
          </dl>
        )}
        {order.vatTreatment && order.vatTreatment !== 'imported' && (
          <p className="text-xs text-muted-foreground">{order.pricesIncludeTax ? t.pricesIncluded : t.pricesExcluded}</p>
        )}
        {order.vatTreatment !== 'imported' && canUpdate && order.editable && (
          <Button type="button" size="sm" variant="outline" disabled={recalculate.isPending} onClick={() => void run()}>
            {recalculate.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {recalculate.isPending ? t.recalculating : t.recalculate}
          </Button>
        )}
        {order.vatTreatment !== null && order.vatTreatment !== 'imported' && !order.editable && (
          <p className="text-xs text-muted-foreground">{t.locked}</p>
        )}
      </div>
    </div>
  );
}

function AddressBlock({ title, address }: Readonly<{ title: string; address: OrderAddress | null }>) {
  const t = getTranslations('commerce').orders.panel;
  const lines = addressLines(address);
  return (
    <div className="space-y-1">
      <SectionHeader>{title}</SectionHeader>
      {lines.length === 0 ? (
        <p className="px-4 pb-2 text-sm text-muted-foreground">{t.noAddress}</p>
      ) : (
        <address className="px-4 pb-2 text-sm not-italic">
          {lines.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </address>
      )}
    </div>
  );
}

function ItemRow({ item, currency }: Readonly<{ item: OrderItem; currency: string }>) {
  const t = getTranslations('commerce').orders.panel;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {item.imageUrl ? (
        <img src={item.imageUrl} alt="" width={32} height={32} loading="lazy" className="h-8 w-8 shrink-0 rounded object-cover bg-muted" />
      ) : (
        <span className="h-8 w-8 shrink-0 rounded bg-muted" aria-hidden="true" />
      )}
      <span className="min-w-0">
        <span className="block truncate text-sm">
          {item.name}
          {item.variantName ? <span className="text-muted-foreground"> · {item.variantName}</span> : null}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {[
            item.sku,
            `${item.quantity} × ${money(item.unitPrice, currency)}`,
            item.taxRate === null ? null : fill(t.vat.rate, { rate: rateText(item.taxRate) }),
            item.vatCategory && item.vatCategory !== 'standard' ? vatCategoryLabel(item.vatCategory) : null,
            fill(t.fulfilledOf, { fulfilled: item.fulfilledQuantity, quantity: item.quantity }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
    </span>
  );
}

function OrderItems({ order }: Readonly<{ order: Order }>) {
  const t = getTranslations('commerce').orders.panel;
  if (order.items.length === 0) return <ProseBlock>{t.noItems}</ProseBlock>;
  return (
    <div className="space-y-2 pb-3">
      <SectionHeader>{t.sections.items}</SectionHeader>
      <LineItemList
        items={order.items}
        getKey={(item) => item.id}
        renderLeft={(item) => <ItemRow item={item} currency={order.currency} />}
        renderRight={(item) => <span className="tabular-nums">{money(item.total, order.currency)}</span>}
      />
    </div>
  );
}

export function OrderPanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = getTranslations('commerce').orders;
  const tp = t.panel;
  const { id } = props;
  const { open } = useObjectPanel();
  const { data, isLoading, error } = useCommerceOrder(id);
  const order = data?.data;

  const customer = order?.customerName?.trim() || order?.customerEmail?.trim() || undefined;

  const renderDetails = (o: Order) => (
    <div className="space-y-3">
      <OrderActions order={o} />
      <Totals order={o} />
      <VatSection order={o} />
      <div className="space-y-1">
        <SectionHeader>{tp.sections.fulfilment}</SectionHeader>
        <p className="px-4 text-xs text-muted-foreground">{tp.fulfilmentHint}</p>
        <p className="px-4 pb-1 text-sm">
          {fulfillmentStatusLabel(o.fulfillmentStatus)} ·{' '}
          {fill(tp.fulfilledOf, {
            fulfilled: o.items.reduce((sum, item) => sum + item.fulfilledQuantity, 0),
            quantity: o.totalQuantity,
          })}
        </p>
      </div>
      {o.invoice && (
        <div className="space-y-1">
          <SectionHeader>{tp.fields.invoice}</SectionHeader>
          <button
            type="button"
            className="mx-4 text-left text-sm text-primary hover:underline"
            onClick={() => open({ type: 'invoice', id: o.invoice?.id ?? '', stack: true })}
          >
            {o.invoice.number ? fill(tp.invoiceLink, { number: o.invoice.number }) : tp.invoiceDraft}
          </button>
        </div>
      )}
      <AddressBlock title={tp.sections.billingAddress} address={o.billingAddress} />
      <AddressBlock title={tp.sections.shippingAddress} address={o.shippingAddress} />
      {o.customerNote && (
        <div className="space-y-1">
          <SectionHeader>{tp.sections.customerNote}</SectionHeader>
          <ProseBlock>{o.customerNote}</ProseBlock>
        </div>
      )}
      {o.internalNote && (
        <div className="space-y-1">
          <SectionHeader>{tp.sections.internalNote}</SectionHeader>
          <ProseBlock>{o.internalNote}</ProseBlock>
        </div>
      )}
    </div>
  );

  const fields = order
    ? [
        { label: tp.fields.customer, value: customer },
        { label: tp.fields.company, value: order.companyName },
        { label: tp.fields.email, value: order.customerEmail },
        { label: tp.fields.phone, value: order.customerPhone },
        { label: tp.fields.reference, value: order.customerReference },
        { label: tp.fields.source, value: sourceLabel(order.source) },
        { label: tp.fields.externalId, value: order.externalOrderId },
        { label: tp.fields.placed, value: formatPanelDate(order.placedAt), tabular: true },
        { label: tp.fields.paid, value: formatPanelDate(order.paidAt), tabular: true },
        { label: tp.fields.paymentMethod, value: order.paymentMethod },
        { label: tp.fields.paymentReference, value: order.paymentReference },
        { label: tp.fields.completed, value: formatPanelDate(order.completedAt), tabular: true },
        { label: tp.fields.cancelled, value: formatPanelDate(order.cancelledAt), tabular: true },
        { label: tp.fields.cancelReason, value: order.cancelReason },
        { label: tp.fields.tags, value: order.tags.join(', ') || null },
      ]
    : [];

  return (
    <SimpleObjectPanel
      {...props}
      objectType="order"
      isLoading={isLoading}
      hasError={!!error}
      hasData={!!order}
      title={order?.orderNumber}
      subtitle={order?.companyName ?? customer}
      openHref={order ? `/weldcommerce/orders?stack=order:${encodeURIComponent(order.id)}` : undefined}
      tabs={[detailsTab(tp.tabDetails), { ...extraTab('items', tp.tabItems, Package), count: order?.items.length || undefined }]}
      renderTab={(tabId) => (tabId === 'items' && order ? <OrderItems order={order} /> : null)}
      statusBadges={
        order && (
          <>
            <SoftBadge tone={orderStatusTone(order.status)}>{orderStatusLabel(order.status)}</SoftBadge>
            <SoftBadge tone={paymentStatusTone(order.paymentStatus)}>{paymentStatusLabel(order.paymentStatus)}</SoftBadge>
            <SoftBadge tone={fulfillmentStatusTone(order.fulfillmentStatus)}>
              {fulfillmentStatusLabel(order.fulfillmentStatus)}
            </SoftBadge>
            {order.approvalStatus !== 'not_required' && <SoftBadge tone="warning">{approvalStatusLabel(order.approvalStatus)}</SoftBadge>}
          </>
        )
      }
      fields={fields}
      extras={order ? renderDetails(order) : undefined}
    />
  );
}
