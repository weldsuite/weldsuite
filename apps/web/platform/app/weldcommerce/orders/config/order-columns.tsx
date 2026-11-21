/** Column definitions for the WeldCommerce orders list. */

import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import type { ColumnDef } from '@/components/panel-entity-list';
import { formatPanelDate } from '@/components/objects/_shared/simple-object-panel';
import { LIST_PRIMARY_COLUMN } from '@/app/weldcommerce/products/config/product-columns';
import type { OrderSummary } from '@/hooks/queries/use-commerce-orders-queries';
import { getLocale, getTranslations } from '@/lib/i18n';
import { plural } from '@/lib/i18n/plural';
import {
  approvalStatusLabel,
  approvalStatusTone,
  fulfillmentStatusLabel,
  fulfillmentStatusTone,
  money,
  orderStatusLabel,
  orderStatusTone,
  paymentStatusLabel,
  paymentStatusTone,
  sourceLabel,
} from '../../lib/orders';

export function OrderStatusBadge({ status }: Readonly<{ status: OrderSummary['status'] }>) {
  return <SoftBadge tone={orderStatusTone(status)}>{orderStatusLabel(status)}</SoftBadge>;
}

export function PaymentStatusBadge({ status }: Readonly<{ status: OrderSummary['paymentStatus'] }>) {
  return <SoftBadge tone={paymentStatusTone(status)}>{paymentStatusLabel(status)}</SoftBadge>;
}

export function FulfillmentStatusBadge({ status }: Readonly<{ status: OrderSummary['fulfillmentStatus'] }>) {
  return <SoftBadge tone={fulfillmentStatusTone(status)}>{fulfillmentStatusLabel(status)}</SoftBadge>;
}

/** Pending and rejected approvals show next to the status; "no approval needed" and "approved" are not worth a badge. */
export function ApprovalFlag({ status }: Readonly<{ status: OrderSummary['approvalStatus'] }>) {
  if (status !== 'pending' && status !== 'rejected') return null;
  return <SoftBadge tone={approvalStatusTone(status)}>{approvalStatusLabel(status)}</SoftBadge>;
}

/** The order's status, with its approval badge under it while that matters. */
function StatusCell({ order }: Readonly<{ order: OrderSummary }>) {
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      <OrderStatusBadge status={order.status} />
      <ApprovalFlag status={order.approvalStatus} />
    </span>
  );
}

/** The buyer: the company when the order has one, with the person under it. */
function CustomerCell({ order }: Readonly<{ order: OrderSummary }>) {
  const primary = order.companyName?.trim() || order.customerName?.trim() || order.customerEmail?.trim() || '—';
  const secondary = order.companyName?.trim() ? order.customerName?.trim() || order.customerEmail?.trim() : order.customerEmail?.trim();
  return (
    <span className="block min-w-0">
      <span className="block truncate">{primary}</span>
      {secondary && secondary !== primary && <span className="block truncate text-xs text-muted-foreground">{secondary}</span>}
    </span>
  );
}

/** `channelNames` maps a channel id to its name; an order of a channel not in it (or none) shows a dash. */
export function buildOrderColumns(channelNames: ReadonlyMap<string, string> = new Map()): ColumnDef<OrderSummary>[] {
  const t = getTranslations('commerce').orders;
  return [
    {
      id: 'order',
      header: t.columns.order,
      width: LIST_PRIMARY_COLUMN,
      render: (o) => <span className="block truncate font-medium tabular-nums">{o.orderNumber}</span>,
    },
    {
      id: 'customer',
      header: t.columns.customer,
      width: 'hidden @xl/list:block w-[200px]',
      render: (o) => <CustomerCell order={o} />,
    },
    {
      id: 'status',
      header: t.columns.status,
      width: 'w-[150px]',
      render: (o) => <StatusCell order={o} />,
    },
    {
      id: 'payment',
      header: t.columns.payment,
      width: 'hidden @2xl/list:block w-[150px]',
      render: (o) => <PaymentStatusBadge status={o.paymentStatus} />,
    },
    {
      id: 'fulfilment',
      header: t.columns.fulfilment,
      width: 'hidden @3xl/list:block w-[160px]',
      render: (o) => <FulfillmentStatusBadge status={o.fulfillmentStatus} />,
    },
    {
      id: 'source',
      header: t.columns.source,
      width: 'hidden @5xl/list:block w-[110px]',
      render: (o) => <span className="block truncate text-muted-foreground">{sourceLabel(o.source)}</span>,
    },
    {
      id: 'channel',
      header: t.columns.channel,
      width: 'hidden @5xl/list:block w-[140px]',
      render: (o) => (
        <span className="block truncate text-muted-foreground">{(o.channelId && channelNames.get(o.channelId)) || '—'}</span>
      ),
    },
    {
      id: 'items',
      header: t.columns.items,
      width: 'hidden @4xl/list:block w-[100px]',
      render: (o) => (
        <span className="block truncate text-muted-foreground tabular-nums">
          {plural(o.itemCount, t.itemsCount, getLocale())}
        </span>
      ),
    },
    {
      id: 'total',
      header: t.columns.total,
      width: 'w-[120px]',
      render: (o) => <span className="tabular-nums">{money(o.total, o.currency)}</span>,
    },
    {
      id: 'date',
      header: t.columns.date,
      width: 'hidden @lg/list:block w-[120px]',
      render: (o) => <span className="text-muted-foreground tabular-nums">{formatPanelDate(o.placedAt) ?? '—'}</span>,
    },
  ];
}
