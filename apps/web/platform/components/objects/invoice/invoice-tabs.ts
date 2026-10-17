import { Banknote, FileMinus, History, LayoutGrid, ListOrdered, Percent } from 'lucide-react';
import type { ConfigurablePanelTab } from '@/components/objects/_shared/configurable-panel-tabs';

/**
 * Tab descriptors for the invoice panel (credit notes are invoices of type
 * `credit_note` and use the same panel). Every tab is backed by the invoice
 * detail read or a real endpoint:
 *
 *   overview     → `/invoices/:id`                    (header fields, addresses, documents)
 *   items        → `/invoices/:id` items + totals
 *   payments     → `/invoices/:id` payments
 *   creditNotes  → `/invoices/:id` creditNotes        (only when some were issued)
 *   tax          → `/invoices/:id` engine, provider sync, Brazil fiscal document and Pix
 *   history      → `/api/audit-logs?entityType=invoice`
 */
export type InvoiceTabId = 'overview' | 'items' | 'payments' | 'creditNotes' | 'tax' | 'history';

export type InvoiceTab = ConfigurablePanelTab<InvoiceTabId>;

export function getInvoiceTabs(input: {
  labels: {
    details: string;
    items: string;
    payments: string;
    creditNotes: string;
    tax: string;
    history: string;
  };
  counts: { items?: number; payments?: number; creditNotes?: number };
  /** Credit notes were issued against the invoice. */
  hasCreditNotes: boolean;
  /** The invoice carries sales tax engine output, or its jurisdiction has fiscal documents / Pix. */
  hasTaxDetails: boolean;
}): InvoiceTab[] {
  const { labels, counts, hasCreditNotes, hasTaxDetails } = input;
  const tabs: InvoiceTab[] = [
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
      count: counts.items,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'payments',
      label: labels.payments,
      icon: Banknote,
      count: counts.payments,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
  ];
  if (hasCreditNotes) {
    tabs.push({
      id: 'creditNotes',
      label: labels.creditNotes,
      icon: FileMinus,
      count: counts.creditNotes,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    });
  }
  if (hasTaxDetails) {
    tabs.push({ id: 'tax', label: labels.tax, icon: Percent, defaultVisibleInFullscreen: true });
  }
  tabs.push({ id: 'history', label: labels.history, icon: History, defaultVisibleInFullscreen: true });
  return tabs;
}
