import { History, LayoutGrid, MessageSquare } from 'lucide-react';
import type { ConfigurablePanelTab } from '@/components/objects/_shared/configurable-panel-tabs';

/**
 * Tab descriptors for the bank transaction panel:
 *
 *   overview → `/bank-transactions/:id/links`   (the line and what it is connected to)
 *   chat     → the line's record chat, with the questions to the accountant (`books-questions`)
 *   history  → `/api/audit-logs?entityType=bank_transaction`
 */
export type BankTransactionTab = ConfigurablePanelTab<'overview' | 'chat' | 'history'>;

export function getBankTransactionTabs(labels: {
  details: string;
  history: string;
  /** Label of the Chat tab; with `showChat`. */
  chat?: string;
  /** The edition has questions to the accountant (`books-questions`). */
  showChat?: boolean;
}): BankTransactionTab[] {
  const tabs: BankTransactionTab[] = [
    {
      id: 'overview',
      label: labels.details,
      icon: LayoutGrid,
      required: true,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
  ];
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
    defaultVisibleInPanel: true,
    defaultVisibleInFullscreen: true,
  });
  return tabs;
}
