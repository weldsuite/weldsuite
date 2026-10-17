import { History, LayoutGrid, ListOrdered } from 'lucide-react';
import type { ConfigurablePanelTab } from '@/components/objects/_shared/configurable-panel-tabs';

/**
 * Tab descriptors for the recurring invoice panel. Every tab is backed by a
 * real endpoint:
 *
 *   overview  → `/recurring-invoices/:id`                    (schedule, status, counters)
 *   items     → `/recurring-invoices/:id` templateData.items (the lines of each generated invoice)
 *   history   → `/api/audit-logs?entityType=recurring_invoice`
 */
export type RecurringInvoiceTabId = 'overview' | 'items' | 'history';

export type RecurringInvoiceTab = ConfigurablePanelTab<RecurringInvoiceTabId>;

export function getRecurringInvoiceTabs(labels: {
  details: string;
  items: string;
  history: string;
  itemsCount?: number;
}): RecurringInvoiceTab[] {
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
      id: 'items',
      label: labels.items,
      icon: ListOrdered,
      count: labels.itemsCount,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'history',
      label: labels.history,
      icon: History,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
  ];
}
