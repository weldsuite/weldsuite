/**
 * Supplier object panel — detail view over app-api `/wms-suppliers/:id`.
 *
 * This is the WMS supplier record (`suppliers` table), not a CRM company with
 * `isSupplier` set. The two are separate surfaces today.
 */

import { Package } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { isFeatureAvailable } from '@/lib/edition';
import { ProductSuppliersSection } from '@/app/weldstash/product-suppliers/components/product-suppliers-section';
import { getTranslations } from '@/lib/i18n';
import { useWeldstashSupplier } from '@/hooks/queries/use-weldstash-queries';
import {
  SimpleObjectPanel,
  formatPanelDate,
  type ObjectPanelComponentProps,
} from '@/components/objects/_shared/simple-object-panel';
import { detailsTab, extraTab } from '@/components/objects/_shared/focused-tabs';

export function SupplierPanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = getTranslations('weldstash');
  const { id } = props;
  const { data, isLoading, error } = useWeldstashSupplier(id);
  const supplier = data?.data;
  const tw = getTranslations('weldstashPurchasing').productSuppliers;
  // Product suppliers are served by the Rust backend only (Kubernetes editions).
  const permissions = usePermissionsMaybe();
  const showProducts = isFeatureAvailable('stash-replenishment') && (permissions?.can('weldstash:suppliers:read') ?? false);

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
      tabs={[detailsTab(t.panel.tabDetails), ...(showProducts ? [extraTab('products', tw.titleForSupplier, Package)] : [])]}
      renderTab={(tabId) =>
        tabId === 'products' && showProducts ? <ProductSuppliersSection side="supplier" supplierId={id} /> : null
      }
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
              { label: t.fields.created, value: formatPanelDate(supplier.createdAt), tabular: true },
            ]
          : []
      }
    />
  );
}
