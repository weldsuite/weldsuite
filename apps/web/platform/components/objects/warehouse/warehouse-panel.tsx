/**
 * Warehouse object panel — detail view over app-api `/warehouses/:id`, plus
 * the stock currently held there.
 *
 * Tabs are warehouse-specific rather than the CRM default set; see
 * `_shared/focused-tabs.ts`.
 */

import { Badge } from '@weldsuite/ui/components/badge';
import { Boxes } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { useWeldstashWarehouse, useWeldstashStock } from '@/hooks/queries/use-weldstash-queries';
import {
  SimpleObjectPanel,
  formatPanelDate,
  SectionHeader,
  ProseBlock,
  LineItemList,
  type ObjectPanelComponentProps,
} from '@/components/objects/_shared/simple-object-panel';
import { detailsTab, extraTab } from '@/components/objects/_shared/focused-tabs';

export function WarehousePanel(props: ObjectPanelComponentProps) {
  const t = getTranslations('commerce').module;
  const { id } = props;
  const { data, isLoading, error } = useWeldstashWarehouse(id);
  const warehouse = data?.data;

  const { data: stock } = useWeldstashStock({ limit: 50, warehouseId: id });
  const stockRows = stock?.data ?? [];

  return (
    <SimpleObjectPanel
      {...props}
      objectType="warehouse"
      isLoading={isLoading}
      hasError={!!error}
      hasData={!!warehouse}
      title={warehouse?.name}
      subtitle={warehouse?.code ?? undefined}
      openHref={warehouse ? `/weldstash/warehouses?open=${warehouse.id}` : undefined}
      tabs={[detailsTab(t.panel.tabDetails), extraTab('stock', t.panel.tabStock, Boxes)]}
      renderTab={(tabId) =>
        tabId === 'stock' ? (
          stockRows.length === 0 ? (
            <ProseBlock>{t.panel.noStock}</ProseBlock>
          ) : (
            <div className="space-y-2">
              <SectionHeader>{t.panel.tabStock}</SectionHeader>
              <LineItemList
                items={stockRows}
                getKey={(r) => r.id}
                renderLeft={(r) => (
                  <span className="truncate">{r.productName ?? r.productId}</span>
                )}
                renderRight={(r) => `${r.quantityAvailable} / ${r.quantityOnHand}`}
              />
              <p className="px-4 pb-2 text-xs text-muted-foreground">{t.panel.stockLegend}</p>
            </div>
          )
        ) : null
      }
      statusBadges={
        warehouse && (
          <>
            <Badge variant={warehouse.isActive === false ? 'secondary' : 'default'}>
              {warehouse.isActive === false ? t.status.inactive : t.status.active}
            </Badge>
            {warehouse.isDefault && <Badge variant="outline">{t.fields.isDefault}</Badge>}
          </>
        )
      }
      fields={
        warehouse
          ? [
              { label: t.fields.address, value: warehouse.addressLine1 },
              { label: t.fields.city, value: warehouse.city },
              { label: t.fields.country, value: warehouse.country },
              { label: t.fields.contact, value: warehouse.contactName },
              { label: t.fields.email, value: warehouse.contactEmail },
              { label: t.fields.phone, value: warehouse.contactPhone },
              { label: t.fields.timezone, value: warehouse.timezone },
              { label: t.fields.created, value: formatPanelDate(warehouse.createdAt) },
            ]
          : []
      }
    />
  );
}
