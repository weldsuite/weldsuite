import { ArrowLeftRight, History, LayoutGrid, PlugZap } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab descriptors for the bank account panel. Every tab is backed by a real
 * endpoint:
 *
 *   overview      → `/bank-accounts/:id`               (the account + balance)
 *   transactions  → `/bank-lines?bankAccountId=:id`    (statement lines)
 *   feeds         → the account's bank-feed connection
 *   history       → `/api/audit-logs?entityType=bank_account`
 */
export interface BankAccountTab extends ObjectPanelTabDescriptor {
  id: 'overview' | 'transactions' | 'feeds' | 'history';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export function getBankAccountTabs(labels: {
  details: string;
  transactions: string;
  feeds: string;
  history: string;
  transactionsCount?: number;
}): BankAccountTab[] {
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
      icon: ArrowLeftRight,
      count: labels.transactionsCount,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'feeds',
      label: labels.feeds,
      icon: PlugZap,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'history',
      label: labels.history,
      icon: History,
      defaultVisibleInFullscreen: true,
    },
  ];
}
