import { Building2, CheckCircle2, History, LayoutGrid, ReceiptText, ShieldAlert } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab descriptors for the payment run panel. Every tab is backed by the run
 * itself (`GET /payment-runs/:id` answers with all of it):
 *
 *   overview  → the summary, what to do next and the ACH file
 *   vendors   → what each vendor is paid, and what became of the payment
 *   bills     → the bills behind the amounts
 *   holds     → the vendors kept out of the payments (only while there are any)
 *   approvals → who made the run and who approved it
 *   history   → what happened to the run
 */
export interface PaymentRunTab extends ObjectPanelTabDescriptor {
  id: 'overview' | 'vendors' | 'bills' | 'holds' | 'approvals' | 'history';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export function getPaymentRunTabs(labels: {
  details: string;
  vendors: string;
  bills: string;
  holds: string;
  approvals: string;
  history: string;
  vendorsCount?: number;
  billsCount?: number;
  holdsCount?: number;
}): PaymentRunTab[] {
  const tabs: PaymentRunTab[] = [
    {
      id: 'overview',
      label: labels.details,
      icon: LayoutGrid,
      required: true,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'vendors',
      label: labels.vendors,
      icon: Building2,
      count: labels.vendorsCount,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'bills',
      label: labels.bills,
      icon: ReceiptText,
      count: labels.billsCount,
      defaultVisibleInFullscreen: true,
    },
  ];
  // A run without holds has nothing to show on this tab: it is left out.
  if (labels.holdsCount) {
    tabs.push({
      id: 'holds',
      label: labels.holds,
      icon: ShieldAlert,
      count: labels.holdsCount,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    });
  }
  tabs.push(
    {
      id: 'approvals',
      label: labels.approvals,
      icon: CheckCircle2,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'history',
      label: labels.history,
      icon: History,
      defaultVisibleInFullscreen: true,
    },
  );
  return tabs;
}
