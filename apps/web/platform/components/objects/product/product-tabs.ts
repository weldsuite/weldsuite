import { LayoutGrid, Boxes, ArrowLeftRight, FolderTree, Store } from 'lucide-react';
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
 *   stock       → `/inventory?productId=`            (per-warehouse levels)
 *   movements   → `/inventory-movements?productId=`  (the ledger history)
 *   categories  → `/products/:id/categories`         (manual membership)
 *   channels    → `/products/:id/sales-channels`     (store listings)
 *
 * The shared `_shared/*-tab.tsx` components can't be reused here: they're
 * typed `entityKind: 'company' | 'person'` and query CRM surfaces.
 */
export interface ProductTab extends ObjectPanelTabDescriptor {
  id: 'overview' | 'stock' | 'movements' | 'categories' | 'channels';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export function getProductTabs(labels: {
  details: string;
  stock: string;
  movements: string;
  categories: string;
  salesChannels: string;
  categoryCount?: number;
  salesChannelCount?: number;
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
    {
      id: 'stock',
      label: labels.stock,
      icon: Boxes,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'categories',
      label: labels.categories,
      icon: FolderTree,
      count: labels.categoryCount,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'channels',
      label: labels.salesChannels,
      icon: Store,
      count: labels.salesChannelCount,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'movements',
      label: labels.movements,
      icon: ArrowLeftRight,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
  ];
}
