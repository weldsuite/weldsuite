import { Banknote, History, LayoutGrid, ListOrdered, MessageSquare, Percent } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab descriptors for the bill panel. Every tab is backed by a real endpoint:
 *
 *   overview → `/bills/:id`                         (supplier, dates, notes, documents)
 *   items    → `/bills/:id`                         (the lines and the totals)
 *   payments → `/bills/:id`                         (the payments made against it)
 *   tax      → `/bills/:id`                         (use tax / Brazil fiscal breakdown)
 *   chat     → the bill's record chat, with the questions to the accountant (`books-questions`)
 *   history  → `/api/audit-logs?entityType=bill`
 *
 * The tax tab only exists for a bill that has such a breakdown.
 */
export interface BillTab extends ObjectPanelTabDescriptor {
  id: 'overview' | 'items' | 'payments' | 'tax' | 'chat' | 'history';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export function getBillTabs(labels: {
  details: string;
  items: string;
  payments: string;
  tax: string;
  history: string;
  /** Label of the Chat tab; with `showChat`. */
  chat?: string;
  /** The edition has questions to the accountant (`books-questions`). */
  showChat?: boolean;
  itemsCount?: number;
  paymentsCount?: number;
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
    {
      id: 'payments',
      label: labels.payments,
      icon: Banknote,
      count: labels.paymentsCount,
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
  if (labels.showChat && labels.chat) {
    tabs.push({
      id: 'chat',
      label: labels.chat,
      icon: MessageSquare,
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
