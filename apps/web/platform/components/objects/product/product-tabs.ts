import { LayoutGrid, Boxes, ArrowLeftRight, Truck, Layers, FolderTree, Coins } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab descriptors for the product panel.
 *
 * Deliberately NOT the default set from `simple-object-panel.tsx`. That one is
 * the CRM shape — Emails, Calls, Meetings, Tasks, Notes — which is meaningless
 * on a product and rendered nothing but `ComingSoonTab`. The panel carries
 * only tabs backed by an endpoint:
 *
 *   overview    → the product record, its images and description
 *   variants    → `/products/:id/variants`           (WeldCommerce only)
 *   prices      → `/products/:id/prices`             (WeldCommerce only)
 *   stock       → `/inventory?productId=`            (per-warehouse levels)
 *   categories  → `/products/:id/categories`         (WeldCommerce only)
 *   movements   → `/inventory-movements?productId=`  (the ledger history)
 *
 * The shared `_shared/*-tab.tsx` components can't be reused here: they're
 * typed `entityKind: 'company' | 'person'` and query CRM surfaces.
 */
export interface ProductTab extends ObjectPanelTabDescriptor {
  id: 'overview' | 'variants' | 'prices' | 'stock' | 'categories' | 'movements' | 'suppliers';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

function optionalTab(id: ProductTab['id'], label: string | undefined, icon: ProductTab['icon']): ProductTab[] {
  if (!label) return [];
  return [{ id, label, icon, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true }];
}

export function getProductTabs(labels: {
  details: string;
  stock: string;
  movements: string;
  /** The Suppliers tab (product suppliers, Kubernetes editions); omitted when it is not offered. */
  suppliers?: string;
  /** The Variants tab (WeldCommerce); omitted elsewhere. */
  variants?: string;
  /** The Prices tab, prices per currency (WeldCommerce); omitted elsewhere. */
  prices?: string;
  /** The Categories tab (WeldCommerce); omitted elsewhere. */
  categories?: string;
}): ProductTab[] {
  return [
    {
      id: 'overview',
      label: labels.details,
      icon: LayoutGrid,
      required: true,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    ...optionalTab('variants', labels.variants, Layers),
    ...optionalTab('prices', labels.prices, Coins),
    {
      id: 'stock',
      label: labels.stock,
      icon: Boxes,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    ...optionalTab('categories', labels.categories, FolderTree),
    ...optionalTab('suppliers', labels.suppliers, Truck),
    {
      id: 'movements',
      label: labels.movements,
      icon: ArrowLeftRight,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
  ];
}
