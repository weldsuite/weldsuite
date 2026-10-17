import { History, LayoutGrid, Wallet } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab descriptors for the deposit panel. Every tab is backed by a real
 * endpoint:
 *
 *   overview → `/bank-deposits/:id`                    (the deposit and its journal entry)
 *   payments → `/bank-deposits/:id` → `payments`, `otherLines`
 *   history  → `/api/audit-logs?entityType=bank_deposit`
 */
export interface DepositTab extends ObjectPanelTabDescriptor {
  id: 'overview' | 'payments' | 'history';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export function getDepositTabs(labels: {
  details: string;
  payments: string;
  history: string;
  paymentsCount?: number;
}): DepositTab[] {
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
      id: 'payments',
      label: labels.payments,
      icon: Wallet,
      count: labels.paymentsCount,
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
