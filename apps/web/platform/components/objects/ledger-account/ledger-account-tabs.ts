import { History, LayoutGrid } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab descriptors for the ledger account panel (a chart-of-accounts row):
 *
 *   overview → `/gl-accounts/:id`                       (the account + balances)
 *   history  → `/api/audit-logs?entityType=account`
 */
export interface LedgerAccountTab extends ObjectPanelTabDescriptor {
  id: 'overview' | 'history';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export function getLedgerAccountTabs(labels: { details: string; history: string }): LedgerAccountTab[] {
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
