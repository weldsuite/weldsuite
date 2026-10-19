import { History, LayoutGrid, ListOrdered, Percent } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab descriptors for the bill panel. Every tab is backed by a real endpoint:
 *
 *   overview → `/bills/:id`                         (supplier, dates, notes, documents)
 *   items    → `/bills/:id`                         (the lines and the totals)
 *   tax      → `/bills/:id`                         (use tax / Brazil fiscal breakdown)
 *   history  → `/api/audit-logs?entityType=bill`
 *
 * The tax tab only exists for a bill that has such a breakdown.
 */
export interface BillTab extends ObjectPanelTabDescriptor {
  id: 'overview' | 'items' | 'tax' | 'history';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export function getBillTabs(labels: {
  details: string;
  items: string;
  tax: string;
  history: string;
  itemsCount?: number;
  /** The bill has a tax breakdown worth a tab of its own. */
  showTax: boolean;
}): BillTab[] {
  const tabs: BillTab[] = [
    {
      id: 'overview',
      label: labels.details,
      icon: LayoutGrid,
      required: true,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'items',
      label: labels.items,
      icon: ListOrdered,
      count: labels.itemsCount,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
  ];
  if (labels.showTax) {
    tabs.push({
      id: 'tax',
      label: labels.tax,
      icon: Percent,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    });
  }
  tabs.push({
    id: 'history',
    label: labels.history,
    icon: History,
    defaultVisibleInFullscreen: true,
  });
  return tabs;
}
