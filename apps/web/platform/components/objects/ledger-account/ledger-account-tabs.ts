import { History, LayoutGrid, ListOrdered } from 'lucide-react';
import type { ConfigurablePanelTab } from '@/components/objects/_shared/configurable-panel-tabs';

/**
 * Tab descriptors for the ledger account panel (a chart-of-accounts row):
 *
 *   overview     → `/gl-accounts/:id`                       (the account + balances)
 *   transactions → `/gl-accounts/:id/transactions`          (its posted journal lines)
 *   history      → `/api/audit-logs?entityType=account`
 */
export type LedgerAccountTabId = 'overview' | 'transactions' | 'history';

export type LedgerAccountTab = ConfigurablePanelTab<LedgerAccountTabId>;

export function getLedgerAccountTabs(labels: {
  details: string;
  transactions: string;
  history: string;
}): LedgerAccountTab[] {
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
      id: 'transactions',
      label: labels.transactions,
      icon: ListOrdered,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      // The audit trail is reachable from the side panel too, not only in fullscreen.
      id: 'history',
      label: labels.history,
      icon: History,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
  ];
}
