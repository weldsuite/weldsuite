import { History, LayoutGrid, ListOrdered } from 'lucide-react';
import type { ConfigurablePanelTab } from '@/components/objects/_shared/configurable-panel-tabs';

/**
 * Tab descriptors for the quote panel. Every tab is backed by the quote read:
 *
 *   overview  → `/accounting-quotes/:id`          (figures, who, timeline, invoices made from it)
 *   lines     → `/accounting-quotes/:id` lines and totals
 *   history   → `/api/audit-logs?entityType=quote`
 */
export type QuoteTabId = 'overview' | 'lines' | 'history';

export type QuoteTab = ConfigurablePanelTab<QuoteTabId>;

export function getQuoteTabs(labels: { details: string; lines: string; history: string; linesCount?: number }): QuoteTab[] {
  return [
    { id: 'overview', label: labels.details, icon: LayoutGrid, required: true, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
    {
      id: 'lines',
      label: labels.lines,
      icon: ListOrdered,
      count: labels.linesCount,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    { id: 'history', label: labels.history, icon: History, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  ];
}
