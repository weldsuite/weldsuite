/**
 * Order object panel.
 *
 * Tabs are order-specific rather than the CRM default set (Emails / Calls /
 * Meetings mean nothing on an order):
 *
 *   overview  → the order record + its customer
 *   items     → `/orders/:id/items` — the line items
 *
 * The customer row opens the existing `company` panel stacked on top of this
 * one (`stack: true`), which is what gives the drill-down a back chevron
 * rather than replacing the current panel.
 */

import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Building2, ListOrdered } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { useObjectPanel } from '@/components/object-panel';
import { useCommerceOrder, useCommerceOrderItems } from '@/hooks/queries/use-commerce-queries';
import { useCompany } from '@/components/objects/company/use-company-data';
import {
  SimpleObjectPanel,
  formatPanelDate,
  formatPanelMoney,
  SectionHeader,
  ProseBlock,
  LineItemList,
  type ObjectPanelComponentProps,
} from '@/components/objects/_shared/simple-object-panel';
import { detailsTab, extraTab } from '@/components/objects/_shared/focused-tabs';

export function OrderPanel(props: ObjectPanelComponentProps) {
  const t = getTranslations('commerce').module;
  const { id } = props;
  const { open } = useObjectPanel();
  const { data, isLoading, error } = useCommerceOrder(id);
  const order = data?.data;

  const customerId = order?.customerId ?? undefined;
  const { data: customer } = useCompany(customerId ?? '', !!customerId);
  const customerName = customer?.data?.name;

  const { data: items } = useCommerceOrderItems(id, !!order);
  const itemRows = items?.data ?? [];
  const itemCount = itemRows.reduce((sum, i) => sum + (i.quantity ?? 0), 0);

  return (
    <SimpleObjectPanel
      {...props}
      objectType="order"
      isLoading={isLoading}
      hasError={!!error}
      hasData={!!order}
      title={order?.orderNumber ?? (order ? t.orders.untitled : undefined)}
      subtitle={customerName ?? undefined}
      openHref={order ? `/weldcommerce/orders?open=${order.id}` : undefined}
      tabs={[
        detailsTab(t.panel.tabDetails),
        // Count on the tab so an empty order is obvious without opening it.
        { ...extraTab('items', t.panel.tabItems, ListOrdered), count: itemRows.length || undefined },
      ]}
      renderTab={(tabId) =>
        tabId === 'items' ? (
          itemRows.length === 0 ? (
            <ProseBlock>{t.panel.noItems}</ProseBlock>
          ) : (
            <div className="space-y-2">
              <SectionHeader>{t.panel.tabItems}</SectionHeader>
              <LineItemList
                items={itemRows}
                getKey={(i) => i.id}
                renderLeft={(i) => (
                  <span className="truncate">
                    {i.name}
                    {i.sku ? <span className="text-muted-foreground"> · {i.sku}</span> : null}
                    <span className="text-muted-foreground">
                      {' '}
                      × {i.quantity}
                    </span>
                  </span>
                )}
                renderRight={(i) => formatPanelMoney(i.total, order?.currency) ?? '—'}
              />
            </div>
          )
        ) : null
      }
      statusBadges={
        order?.status && (
          <Badge variant="outline" className="capitalize">
            {order.status}
          </Badge>
        )
      }
      fields={
        order
          ? [
              { label: t.fields.orderNumber, value: order.orderNumber },
              { label: t.panel.itemCount, value: itemRows.length > 0 ? itemCount : undefined },
              { label: t.fields.subtotal, value: formatPanelMoney(order.subtotal, order.currency) },
              { label: t.fields.tax, value: formatPanelMoney(order.taxTotal, order.currency) },
              { label: t.fields.total, value: formatPanelMoney(order.total, order.currency) },
              { label: t.fields.created, value: formatPanelDate(order.createdAt) },
            ]
          : []
      }
      extras={
        customerId && (
          <div className="space-y-2">
            <SectionHeader>{t.fields.customer}</SectionHeader>
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start gap-2"
              onClick={() => open({ type: 'company', id: customerId, stack: true })}
            >
              <Building2 className="h-4 w-4 shrink-0" />
              <span className="truncate">{customerName ?? customerId}</span>
            </Button>
          </div>
        )
      }
    />
  );
}
