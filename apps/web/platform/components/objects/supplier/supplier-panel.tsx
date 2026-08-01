/**
 * Supplier object panel — detail view over app-api `/wms-suppliers/:id`.
 *
 * This is the WMS supplier record (`suppliers` table), not a CRM company with
 * `isSupplier` set. The two are separate surfaces today.
 */

import { Badge } from '@weldsuite/ui/components/badge';
import { getTranslations } from '@/lib/i18n';
import { useWeldstashSupplier } from '@/hooks/queries/use-weldstash-queries';
import {
  SimpleObjectPanel,
  formatPanelDate,
  type ObjectPanelComponentProps,
} from '@/components/objects/_shared/simple-object-panel';
import { detailsOnlyTabs } from '@/components/objects/_shared/focused-tabs';

export function SupplierPanel(props: ObjectPanelComponentProps) {
  const t = getTranslations('commerce').module;
  const { id } = props;
  const { data, isLoading, error } = useWeldstashSupplier(id);
  const supplier = data?.data;

  return (
    <SimpleObjectPanel
      {...props}
      objectType="supplier"
      isLoading={isLoading}
      hasError={!!error}
      hasData={!!supplier}
      title={supplier?.name}
      subtitle={supplier?.code ?? undefined}
      openHref={supplier ? `/weldstash/suppliers?open=${supplier.id}` : undefined}
      // Details only — purchase orders per supplier aren't wired to this panel.
      tabs={detailsOnlyTabs(t.panel.tabDetails)}
      statusBadges={
        supplier && (
          <Badge variant={supplier.isActive === false ? 'secondary' : 'default'} className="capitalize">
            {supplier.status}
          </Badge>
        )
      }
      fields={
        supplier
          ? [
              { label: t.fields.email, value: supplier.email },
              { label: t.fields.phone, value: supplier.phone },
              { label: t.fields.website, value: supplier.website },
              { label: t.fields.contact, value: supplier.contactName },
              { label: t.fields.leadTime, value: supplier.defaultLeadTimeDays },
              { label: t.fields.paymentTerms, value: supplier.paymentTerms },
              { label: t.fields.currency, value: supplier.currency },
              { label: t.fields.city, value: supplier.city },
              { label: t.fields.country, value: supplier.country },
              { label: t.fields.created, value: formatPanelDate(supplier.createdAt) },
            ]
          : []
      }
    />
  );
}
