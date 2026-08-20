import { Badge } from '@weldsuite/ui/components/badge';
import type { ColumnDef } from '@/components/panel-entity-list';
import type { CommerceOrder } from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';
import { formatMoney } from '../../products/config/product-columns';

/**
 * `orders.status` is a free-form varchar today — there is no server-side
 * transition guard yet (Phase 3 of `.claude/weldcommerce-plan.md`). This list
 * is the UI's own convention, not an enforced enum.
 */
export const ORDER_STATUS_OPTIONS = [
  'pending',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
] as const;

function statusVariant(status: string | null | undefined) {
  if (status === 'delivered') return 'default' as const;
  if (status === 'cancelled') return 'destructive' as const;
  return 'outline' as const;
}

/**
 * Translate a status for display.
 *
 * `orders.status` is a free-form varchar, so a row can hold a value outside
 * ORDER_STATUS_OPTIONS (imported data, a future status). Those fall back to the
 * raw string rather than rendering blank — showing the unknown value is more
 * useful than hiding it.
 */
export function orderStatusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  const labels = getTranslations('commerce').module.orders.statusLabels as Record<string, string>;
  return labels[status] ?? status;
}

/**
 * Orders carry only `customerId`, so the page resolves an id→name map once and
 * passes it in rather than making every row fetch.
 */
export function buildOrderColumns(customerNames: Map<string, string>): ColumnDef<CommerceOrder>[] {
  const t = getTranslations('commerce').module;
  return [
    {
      id: 'orderNumber',
      header: t.fields.orderNumber,
      width: 'w-[180px]',
      render: (o) => <span className="font-medium">{o.orderNumber ?? t.orders.untitled}</span>,
    },
    {
      id: 'customer',
      header: t.fields.customer,
      width: 'flex-1',
      render: (o) => (
        <span className="text-muted-foreground truncate block">
          {o.customerId ? customerNames.get(o.customerId) ?? o.customerId : t.orders.noCustomer}
        </span>
      ),
    },
    {
      id: 'total',
      header: t.fields.total,
      width: 'w-[130px]',
      render: (o) => <span>{formatMoney(o.total, o.currency)}</span>,
    },
    {
      id: 'status',
      header: t.fields.status,
      width: 'w-[160px]',
      render: (o) => (
        <span className="inline-flex items-center gap-1.5">
          <Badge variant={statusVariant(o.status)}>{orderStatusLabel(o.status)}</Badge>
          {o.source === 'b2b_portal' ? (
            <Badge variant="secondary">{t.orders.portalSource}</Badge>
          ) : null}
        </span>
      ),
    },
    {
      id: 'createdAt',
      header: t.fields.created,
      width: 'w-[130px]',
      render: (o) => (
        <span className="text-muted-foreground">{new Date(o.createdAt).toLocaleDateString()}</span>
      ),
    },
  ];
}
