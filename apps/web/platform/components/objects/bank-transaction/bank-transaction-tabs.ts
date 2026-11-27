import { History, LayoutGrid } from 'lucide-react';
import type { ConfigurablePanelTab } from '@/components/objects/_shared/configurable-panel-tabs';

/**
 * Tab descriptors for the bank transaction panel:
 *
 *   overview → `/bank-transactions/:id/links`   (the line and what it is connected to)
 *   history  → `/api/audit-logs?entityType=bank_transaction`
 */
export type BankTransactionTab = ConfigurablePanelTab<'overview' | 'history'>;

export function getBankTransactionTabs(labels: { details: string; history: string }): BankTransactionTab[] {
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
      id: 'history',
      label: labels.history,
      icon: History,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
  ];
}
